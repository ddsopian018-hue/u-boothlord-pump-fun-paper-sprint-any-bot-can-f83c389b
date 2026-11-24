// DipSnap — a minimum-size dip-buy paper bot for the pump.fun replay sprint.
//
// REVISION v3 (after two dev replays and dataset forensics). The v2 launch-snipe
// lost -0.487 SOL on dev (18% win rate): the 2-slot fill latency eats the
// launch edge whole — the median fill lands +11.7% above the decision price,
// and post-fill price action is a driftless random walk, so every directional
// family (launch-snipe, momentum, dip-buy) loses the ~2.7% round-trip fee
// spread in expectation. The forensics also showed completing coins pump
// 0 -> 85 SOL inside a single slot (untradeable) and the dip-buy's price PnL
// is ~breakeven (v1: -0.0487 SOL total, of which 0.0495 SOL was fees).
//
// So v3 stops chasing an edge that latency has already eaten and instead
// minimises the bleed while meeting the ranking bar:
//
//   * BUY only a coin that fell >= 10% off its recent peak AND bounced >= 2%
//     off the low since the peak (stabilisation — never catch a falling knife).
//   * BUY the MINIMUM qualifying size: 0.015 SOL per coin (the bar is a round
//     trip of >= 0.01 SOL on each of >= 20 coins). The fee bleed is ~2.4% of
//     size per round trip, so 25 coins x 0.015 SOL costs ~0.009 SOL total —
//     versus 0.049 SOL for the same 25 trips at 0.10 SOL.
//   * SELL at +20% take-profit, -10% stop-loss, or after 400 batches held.
//     At most 5 open positions, at most 30 buys a run.
//   * Entry price is corrected to the actual FILL price (quote / tokens from
//     the buy fill), because the 2-slot latency makes the decision price a
//     stale basis for take-profit / stop-loss.
//   * Global brake: stop opening new positions if equity falls 0.50 SOL under
//     start (a safety only — total exposure is ~0.45 SOL at most).
//
// The bar dominates the ranking (an entry missing it ranks below every entry
// that meets it, even one at a small loss), so the design buys the bar as
// cheaply as possible and lets any bounce that does come pay for it.
//
// Deterministic: no clock, no environment, no Math.random. Every decision comes
// from the harness state alone.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface DipSnapConfig {
  dipPct: number; // buy only >= this below the recent peak
  bouncePct: number; // ...and >= this recovered off the low since the peak
  minTrades: number; // activity floor: the coin must actually trade
  minRealReservesSol: number; // liquidity floor: real SOL reserves at entry
  targetBuySol: number; // buy size, SOL (kept at the minimum that clears the bar)
  minBuySol: number; // never buy smaller (round-trip bar is 0.01 SOL)
  takeProfit: number; // sell at +this vs entry (fill) price
  stopLoss: number; // sell at -this vs entry (fill) price
  maxHoldBatches: number; // age exit: sell after this many batches held
  maxBuys: number; // hard budget of buys per run
  brakeLossSol: number; // stop opening if equity is this far under start
}

export const DEFAULT_CONFIG: DipSnapConfig = {
  dipPct: 0.1,
  bouncePct: 0.02,
  minTrades: 3,
  minRealReservesSol: 0.5,
  targetBuySol: 0.015,
  minBuySol: 0.012,
  takeProfit: 0.2,
  stopLoss: 0.1,
  maxHoldBatches: 400,
  maxBuys: 30,
  brakeLossSol: 0.5,
};

const MAX_SLIPPAGE_BPS = 500;

// --- per-coin tracking ----------------------------------------------------
interface CoinTrack {
  prices: number[]; // recent prices, SOL per token, oldest first
  peak: number; // highest price in the window
  lowAfterPeak: number; // lowest price since the peak was set
  trades: number; // TradeEvents seen
  complete: boolean;
  entryPrice: number | null; // price at our buy (corrected to the fill price)
  buySeq: number; // batch seq of our buy decision
  bought: boolean; // we already bought this coin once (one dip per coin)
}

const HISTORY = 40; // prices kept per coin (recent-peak window)

export class DipSnapStrategy {
  private readonly cfg: DipSnapConfig;
  private coins = new Map<Pubkey, CoinTrack>();
  private startCash = 0n;
  private buysSent = 0;
  private roundTripped = new Set<Pubkey>();
  private stopped = false;

  constructor(config: DipSnapConfig = DEFAULT_CONFIG) {
    this.cfg = config;
  }

  onHello(state: BotState): void {
    this.startCash = state.cash;
    console.error(
      `[dipsnap] hello: capital=${Number(state.cash) / 1e9} SOL ` +
        `maxPositions=${state.hello.caps.max_open_positions} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} ` +
        `cfg=${JSON.stringify(this.cfg)}`,
    );
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.observe(state, batch);
    const orders: OrderInput[] = [];
    orders.push(...this.exits(state));
    if (!this.stopped) {
      orders.push(...this.entries(state, batch));
    }
    this.updateGlobalState(state);
    return orders;
  }

  onDone(state: BotState): void {
    const equity = this.equitySol(state);
    console.error(
      `[dipsnap] done: batches=${state.seq} equity=${equity.toFixed(4)} SOL ` +
        `buys=${this.buysSent} coinsRoundTripped=${this.roundTripped.size}`,
    );
  }

  // --- observation --------------------------------------------------------
  private observe(state: BotState, batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        this.track(event.mint);
        this.pushPrice(event.mint, priceOf(event.virtual_quote_reserves, event.virtual_token_reserves));
      } else if (event.event === 'TradeEvent') {
        const t = this.track(event.mint);
        t.trades += 1;
        this.pushPrice(event.mint, priceOf(event.virtual_quote_reserves, event.virtual_token_reserves));
      } else {
        // CompleteEvent: the curve is done; the harness closes positions in it.
        const t = this.coins.get(event.mint);
        if (t) t.complete = true;
      }
    }
    // Marks refresh the price of every coin we hold or have pending.
    for (const mark of batch.marks) {
      this.pushPrice(mark.mint, priceOf(mark.virtual_quote_reserves, mark.virtual_token_reserves));
    }
    // Fills that resolved since the last batch: correct the entry price to the
    // actual fill price (the decision price is stale by the 2-slot latency),
    // and record completed round trips.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || BigInt(fill.token_amount) === 0n) continue;
      if (fill.side === 'buy') {
        const t = this.coins.get(fill.mint);
        if (t) {
          const fillPrice = Number(BigInt(fill.quote_lamports)) / Number(BigInt(fill.token_amount)) / 1e9;
          if (Number.isFinite(fillPrice) && fillPrice > 0) t.entryPrice = fillPrice;
        }
      } else {
        this.roundTripped.add(fill.mint);
      }
    }
  }

  private track(mint: Pubkey): CoinTrack {
    let t = this.coins.get(mint);
    if (!t) {
      t = {
        prices: [],
        peak: 0,
        lowAfterPeak: Number.POSITIVE_INFINITY,
        trades: 0,
        complete: false,
        entryPrice: null,
        buySeq: 0,
        bought: false,
      };
      this.coins.set(mint, t);
    }
    return t;
  }

  private pushPrice(mint: Pubkey, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const t = this.track(mint);
    t.prices.push(price);
    if (t.prices.length > HISTORY) t.prices.shift();
    if (price > t.peak) {
      t.peak = price;
      t.lowAfterPeak = price;
    } else if (price < t.lowAfterPeak) {
      t.lowAfterPeak = price;
    }
  }

  // --- exits --------------------------------------------------------------
  private exits(state: BotState): OrderInput[] {
    const orders: OrderInput[] = [];
    for (const [mint, holding] of state.positions) {
      if (this.hasPendingSell(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue; // harness closes completed curves
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const t = this.coins.get(mint);
      const entry = t?.entryPrice;
      if (!entry || entry <= 0) continue;
      const gain = (price - entry) / entry;
      const age = state.seq - (t?.buySeq ?? state.seq);
      if (gain >= this.cfg.takeProfit || gain <= -this.cfg.stopLoss || age >= this.cfg.maxHoldBatches) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
    return orders;
  }

  // --- entries ------------------------------------------------------------
  private entries(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    if (this.buysSent >= this.cfg.maxBuys) return orders;
    const freeSlots =
      state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots <= 0) return orders;
    if (state.freeCashLamports() < BigInt(Math.round(this.cfg.minBuySol * 1e9))) return orders;

    // Candidates are the coins that actually traded in this batch.
    const seen = new Set<Pubkey>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const mint = event.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (orders.length >= freeSlots) break;
      const order = this.maybeDipBuy(state, mint);
      if (order) orders.push(order);
    }
    return orders;
  }

  private maybeDipBuy(state: BotState, mint: Pubkey): OrderInput | null {
    const t = this.coins.get(mint);
    const curve = state.curves.get(mint);
    if (!t || !curve || curve.complete) return null;
    if (t.bought) return null; // one dip per coin
    if (t.trades < this.cfg.minTrades) return null;
    if (t.prices.length < 8) return null; // need history before judging a dip
    if (state.positions.has(mint)) return null;
    if (this.hasPendingBuy(state, mint)) return null;

    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!Number.isFinite(price) || price <= 0) return null;

    // Regime gate: the dip must be real (>= 10% off the peak) and the coin must
    // have stabilised (>= 2% back up off the low since the peak). A coin still
    // making new lows is a falling knife, not a dip.
    const dip = (t.peak - price) / t.peak;
    if (dip < this.cfg.dipPct) return null;
    const bounce = (price - t.lowAfterPeak) / t.lowAfterPeak;
    if (bounce < this.cfg.bouncePct) return null;

    // Size: the minimum that clears the 0.01 SOL round-trip bar with margin.
    // The per-batch cap is 1% of real reserves; a buy under the minimum is
    // skipped rather than shrunk below the bar.
    const cap = state.maxBuyLamports(mint);
    const realSol = Number(curve.real_quote_reserves) / 1e9;
    if (realSol < this.cfg.minRealReservesSol) return null;
    let size = BigInt(Math.round(this.cfg.targetBuySol * 1e9));
    if (size > cap) size = cap;
    if (size < BigInt(Math.round(this.cfg.minBuySol * 1e9))) return null;
    if (size > state.freeCashLamports() - state.txFeeLamports()) return null;

    t.entryPrice = price; // corrected to the fill price when the fill lands
    t.buySeq = state.seq;
    t.bought = true;
    this.buysSent += 1;
    return {
      side: 'buy',
      mint,
      quote_lamports: size,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  // --- global brake ---------------------------------------------------------
  // No bank target: each new coin is a fresh +EV bet and the pot is
  // winner-take-all by net PnL, so the bot keeps trading while the edge holds.
  // The only global stop is the brake below: if the final window turns out to
  // be a regime where launches do not pump, stop digging the hole.
  private updateGlobalState(state: BotState): void {
    const pnlSol = this.equitySol(state) - Number(this.startCash) / 1e9;
    if (pnlSol <= -this.cfg.brakeLossSol) this.stopped = true;
  }

  // --- helpers ------------------------------------------------------------
  private equitySol(state: BotState): number {
    let equity = Number(state.cash) / 1e9;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (Number.isFinite(price) && price > 0) {
        equity += Number(holding.token_amount) * price / 1e9;
      }
    }
    return equity;
  }

  private hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return true;
    }
    return false;
  }

  private hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  }
}

/** Price in SOL per token from virtual reserves (bigint-safe ratio). */
function priceOf(virtualQuote: bigint | string, virtualToken: bigint | string): number {
  const q = Number(BigInt(virtualQuote));
  const v = Number(BigInt(virtualToken));
  if (v <= 0) return 0;
  return q / v;
}
