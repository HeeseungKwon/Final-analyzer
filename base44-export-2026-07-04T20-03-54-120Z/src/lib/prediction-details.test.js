import test from "node:test";
import assert from "node:assert/strict";

import {
  getIndependentConfidence,
  getRecommendationDrivers,
  normalizeDataQuality,
  toPercentLabel,
} from "./prediction-details.js";

test("toPercentLabel formats decimal values as percentages", () => {
  assert.equal(toPercentLabel(0.321), "32%");
  assert.equal(toPercentLabel(0.321, 1), "32.1%");
});

test("normalizeDataQuality maps values to user-friendly badges", () => {
  assert.equal(normalizeDataQuality("ok").label, "Good");
  assert.equal(normalizeDataQuality("partial").label, "Partial");
  assert.equal(normalizeDataQuality("missing").label, "Limited");
});

test("getRecommendationDrivers infers concise user-facing labels", () => {
  const drivers = getRecommendationDrivers(
    { player_type: "hitter", projection: 0.42 },
    {
      expectedPA: 4.4,
      battingOrder: 2,
      parkFactor: 108,
      season: { pa: 320, home_runs: 22, avg: 0.255 },
      recent: { avg: 0.286 },
      derivedFeatures: { MatchupScore: 0.71 },
    }
  );

  assert.ok(drivers.includes("Elite Power"));
  assert.ok(drivers.includes("Strong Matchup"));
  assert.ok(drivers.includes("Favorable Ballpark"));
  assert.ok(drivers.includes("High Expected PA"));
  assert.ok(drivers.includes("Recent Hot Streak"));
});

test("getIndependentConfidence uses reliability signals when stored confidence mirrors model probability", () => {
  const prediction = { data_quality: "ok", floor: 0.28, ceiling: 0.46, player_type: "hitter" };
  const features = {
    confidenceScore: 41,
    season: { pa: 310 },
    recent: { pa: 72, avg: 0.285 },
    split: { pa: 100 },
    opponentPitcher: { bf: 520 },
    derivedFeatures: { MatchupScore: 0.68 },
    expectedPA: 4.3,
    battingOrder: 3,
  };
  const confidence = getIndependentConfidence(prediction, features, 0.41);

  assert.notEqual(confidence, 41);
  assert.ok(confidence >= 0 && confidence <= 100);
});
