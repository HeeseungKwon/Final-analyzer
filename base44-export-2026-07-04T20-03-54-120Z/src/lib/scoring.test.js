import test from "node:test";
import assert from "node:assert/strict";

import { scoreHitter } from "./scoring.js";

function buildContext(overrides = {}) {
  return {
    season: {
      pa: 320,
      hits: 82,
      doubles: 18,
      triples: 2,
      home_runs: 14,
      bb: 28,
      hbp: 3,
      so: 64,
      avg: 0.256,
      slg: 0.445,
      quality: "ok",
    },
    recent: {
      pa: 70,
      hits: 19,
      doubles: 4,
      triples: 0,
      home_runs: 3,
      bb: 6,
      hbp: 1,
      so: 15,
      avg: 0.271,
      slg: 0.500,
      quality: "ok",
    },
    split: {
      pa: 90,
      hits: 24,
      doubles: 5,
      triples: 1,
      home_runs: 5,
      bb: 8,
      hbp: 1,
      so: 18,
      avg: 0.267,
      slg: 0.578,
      quality: "ok",
    },
    battingOrder: 3,
    teamImpliedTotal: 4.9,
    onbaseRateAhead: 0.332,
    onbaseRateBehind: 0.329,
    oppPitcherK: 0.225,
    oppPitcherGbFbRatio: 0.95,
    oppPitcherStats: {
      bf: 520,
      hits_allowed: 132,
      hr_allowed: 21,
      bb: 42,
      quality: "ok",
    },
    parkFactor: 102,
    ...overrides,
  };
}

test("scoreHitter keeps confidence bounded and rewards stronger HR power profiles", () => {
  const lowerPower = buildContext();
  const higherPower = buildContext({
    season: {
      ...buildContext().season,
      doubles: 24,
      home_runs: 26,
      slg: 0.570,
    },
    recent: {
      ...buildContext().recent,
      doubles: 6,
      home_runs: 6,
      slg: 0.640,
    },
    split: {
      ...buildContext().split,
      doubles: 8,
      home_runs: 8,
      slg: 0.690,
    },
  });

  const lowerHr = scoreHitter("Lower Power", lowerPower).find((pick) => pick.market === "home_run");
  const higherHr = scoreHitter("Higher Power", higherPower).find((pick) => pick.market === "home_run");

  assert.ok(lowerHr);
  assert.ok(higherHr);
  assert.ok(lowerHr.confidence >= 0 && lowerHr.confidence <= 100);
  assert.ok(higherHr.confidence >= 0 && higherHr.confidence <= 100);
  assert.ok(higherHr.projection > lowerHr.projection);
  assert.ok(higherHr.confidence >= lowerHr.confidence);
});
