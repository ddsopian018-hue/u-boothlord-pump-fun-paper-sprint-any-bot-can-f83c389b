// DipSnap — Pump.fun Paper Sprint entry (pumpfun-replay/v2).
//
// A minimum-size dip-buy paper bot (v3 — the v2 launch-snipe lost -0.487 SOL
// on dev because the 2-slot fill latency eats the launch edge; see
// strategy.ts): it buys a coin only after a >= 10% dip off its recent peak
// that has bounced >= 2% off the low, at the minimum size that clears the
// 0.01 SOL round-trip bar (0.015 SOL), sells at +20% / -10% / 400 batches
// held, and stops after 30 buys. The measured parameters live here at the
// entrypoint so the strategy stays a pure function of its config.
//
// Run by the grader as: node /bot/main.ts

import { runBot } from './vendor/makefun-bot.ts';
import { DipSnapStrategy, type DipSnapConfig } from './strategy.ts';

// Measured on the kit's dev window (128k events, 1,222 coins): the dip-buy's
// price PnL is ~breakeven and its loss is the ~2.4%-of-size fee spread, so
// buying the minimum size is what keeps the total bleed near zero.
const CONFIG: DipSnapConfig = {
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

const strategy = new DipSnapStrategy(CONFIG);

await runBot({
  onHello: (state) => strategy.onHello(state),
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state) => strategy.onDone(state),
});
