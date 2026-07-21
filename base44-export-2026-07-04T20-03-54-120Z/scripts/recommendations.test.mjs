import test from "node:test";
import assert from "node:assert/strict";
import { dedupePredictionsByMarketPlayer, generateRecommendations } from "../src/lib/recommendations.js";

test("dedupe keeps highest-ranked prediction per player within a market using player_id", () => {
  const picks = [
    { id: "a", market: "home_run", player_id: 1, player_name: "Aaron Judge", confidence: 18, projection: 0.18 },
    { id: "b", market: "home_run", player_id: 1, player_name: "Aaron Judge", confidence: 22, projection: 0.22 },
    { id: "c", market: "home_run", player_id: 2, player_name: "Juan Soto", confidence: 19, projection: 0.19 },
  ];

  const deduped = dedupePredictionsByMarketPlayer(picks);

  assert.equal(deduped.length, 2);
  assert.ok(deduped.some((p) => p.id === "b"));
  assert.ok(!deduped.some((p) => p.id === "a"));
});

test("dedupe falls back to player name when player_id is missing", () => {
  const picks = [
    { id: "a", market: "total_bases", player_name: "Mookie Betts", confidence: 51, projection: 0.51 },
    { id: "b", market: "total_bases", player_name: "mookie betts", confidence: 57, projection: 0.57 },
  ];

  const deduped = dedupePredictionsByMarketPlayer(picks);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, "b");
});

test("overall recommendations include market leaders for cross-market fairness", () => {
  const picks = [
    { id: "hr1", market: "home_run", player_id: 1, player_name: "HR Leader", confidence: 18, projection: 0.18 },
    { id: "hr2", market: "home_run", player_id: 2, player_name: "HR 2", confidence: 14, projection: 0.14 },
    { id: "hrr1", market: "hrr_2", player_id: 3, player_name: "HRR Leader", confidence: 62, projection: 0.62 },
    { id: "hrr2", market: "hrr_2", player_id: 4, player_name: "HRR 2", confidence: 58, projection: 0.58 },
    { id: "hits1", market: "hit_2", player_id: 5, player_name: "Hits Leader", confidence: 54, projection: 0.54 },
    { id: "hits2", market: "hit_2", player_id: 6, player_name: "Hits 2", confidence: 49, projection: 0.49 },
  ];

  const { overallBestPicks } = generateRecommendations(picks, { topN: 3 });
  const markets = new Set(overallBestPicks.map((pick) => pick.market));

  assert.equal(overallBestPicks.length, 3);
  assert.ok(markets.has("home_run"));
  assert.ok(markets.has("hrr_2"));
  assert.ok(markets.has("hit_2"));
});
