import test from "node:test";
import assert from "node:assert/strict";

import { filterRecommendedPicks } from "./recommendations.js";

test("filterRecommendedPicks keeps only recommended picks above confidence and projection thresholds", () => {
  const filtered = filterRecommendedPicks([
    { id: 1, player_id: 7, player_name: "A", market: "home_run", recommended: true, confidence: 68, projection: 0.64 },
    { id: 2, player_id: 7, player_name: "A", market: "home_run", recommended: true, confidence: 62, projection: 0.61 },
    { id: 3, player_id: 8, player_name: "B", market: "home_run", recommended: false, confidence: 91, projection: 0.92 },
    { id: 4, player_id: 9, player_name: "C", market: "total_bases", recommended: true, confidence: 55, projection: 0.72 },
    { id: 5, player_id: 10, player_name: "D", market: "hit_2", recommended: true, confidence: 71, projection: 0.58 },
  ]);

  assert.deepEqual(filtered.map((pick) => pick.id), [1]);
});
