import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARKET_LABELS,
  MARKET_SHORT_LABELS,
  getMarketLabel,
} from "../src/lib/constants/markets.js";
import { scoreHitter } from "../src/lib/scoring.js";

function poissonAtLeast(lambda, k) {
  const l = Math.max(0, lambda);
  if (k <= 0) return 1;
  if (l === 0) return 0;
  let term = Math.exp(-l);
  let cum = term;
  for (let i = 1; i < k; i++) {
    term = (term * l) / i;
    cum += term;
  }
  return Math.max(0, Math.min(1, 1 - cum));
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, received ${actual}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

assert.equal(MARKET_LABELS.total_bases, "TB O1.5");
assert.equal(MARKET_LABELS.hrr_2, "HRR O1.5");
assert.equal(MARKET_LABELS.hrr_3, "HRR O2.5");
assert.equal(MARKET_SHORT_LABELS.total_bases, "TB O1.5");
assert.equal(MARKET_SHORT_LABELS.hrr_2, "HRR O1.5");
assert.equal(MARKET_SHORT_LABELS.hrr_3, "HRR O2.5");
assert.equal(getMarketLabel("TB 2.5", "short"), "TB O1.5");
assert.equal(getMarketLabel("HRR 2.5", "short"), "HRR O1.5");
assert.equal(getMarketLabel("HRR 3.5", "short"), "HRR O2.5");

const ctx = {
  season: {
    pa: 320,
    ab: 286,
    hits: 83,
    doubles: 19,
    triples: 2,
    home_runs: 15,
    runs: 47,
    rbi: 58,
    quality: "ok",
  },
  recent: {
    pa: 64,
    ab: 57,
    hits: 19,
    doubles: 4,
    triples: 1,
    home_runs: 4,
    runs: 12,
    rbi: 13,
    quality: "ok",
  },
  expectedPA: 4.4,
  battingOrder: 2,
  oppPitcherK: 0.208,
  oppPitcherHrPerBF: 0.036,
  parkFactor: 108,
};

const byMarket = new Map(scoreHitter("Validation Batter", ctx).map((score) => [score.market, score]));

for (const market of ["total_bases", "hrr_2", "hrr_3"]) {
  assert.ok(byMarket.has(market), `Missing ${market} output`);
  assert.ok(byMarket.get(market).projection >= 0 && byMarket.get(market).projection <= 1, `${market} projection should be a probability`);
}

assertClose(
  byMarket.get("total_bases").projection,
  poissonAtLeast(byMarket.get("total_bases").features.expectedCount, 2),
  "TB O1.5 should map to TB >= 2"
);
assertClose(
  byMarket.get("hrr_2").projection,
  poissonAtLeast(byMarket.get("hrr_2").features.expectedCount, 2),
  "HRR O1.5 should map to HRR >= 2"
);
assertClose(
  byMarket.get("hrr_3").projection,
  poissonAtLeast(byMarket.get("hrr_3").features.expectedCount, 3),
  "HRR O2.5 should map to HRR >= 3"
);

const activeOutputFiles = [
  "../src/components/mlb/PredRow.jsx",
  "../src/components/mlb/PicksReviewTable.jsx",
  "../src/pages/Today.jsx",
  "../src/pages/Parlays.jsx",
  "../src/pages/Review.jsx",
  "../src/lib/scoring.js",
];

const legacyLabels = ["TB 2.5", "Total Bases 2.5", "HRR 2.5", "HRR 3.5", "Hits+Runs+RBIs 2.5", "Hits+Runs+RBIs 3.5"];

for (const relativeFile of activeOutputFiles) {
  const contents = fs.readFileSync(path.resolve(__dirname, relativeFile), "utf8");
  for (const label of legacyLabels) {
    assert.ok(!contents.includes(label), `${relativeFile} still contains legacy label ${label}`);
  }
}

console.log("Benchmark validation passed.");
