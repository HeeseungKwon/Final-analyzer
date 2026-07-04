/**
 * Advanced Parlay Builder with Vegas Integration
 * 
 * Builds algorithmic parlays with intelligent pick selection:
 * - Balanced edge parlays across diverse markets
 * - HR prospect parlays with Vegas + ballpark comparison
 * - Middling picks (model probability between Vegas and park) included for edge opportunities
 * - Strong picks (model beats both baselines) prioritized
 * 
 * Key principle: Include both STRONG and MIDDLING HR picks.
 * Strong picks = high-confidence model advantage. Middling picks = potential hidden edges
 * where the model's view sits between Vegas and ballpark, creating valuation opportunities.
 */

import { clamp, smooth, probToAmerican, blend } from "@/lib/utils/math";
import { computeHRVerdict } from "@/lib/scoring-advanced";

/**
 * Calculates the probability used in parlay leg combinations
 * Different markets use different blend ratios of projection and floor/ceiling
 * 
 * @param {Object} p - Prediction object with market, projection, floor
 * @returns {number} Leg probability [0, 1]
 */
function legProbabilityFor(p) {
  switch (p.market) {
    case "hit_1":
      return clamp(0.55 * p.floor + 0.45 * p.projection, 0, 1);
    case "hit_2":
      return clamp(0.5 * p.floor + 0.5 * p.projection, 0, 1);
    case "home_run":
      return clamp(0.7 * p.projection + 0.3 * p.floor, 0, 1);
    case "total_bases":
      return clamp(smooth((p.projection - 1.5) / 1.2, 0.4, 0.75), 0, 1);
    case "hrr":
      return clamp(smooth((p.projection - 1.5) / 1.2, 0.4, 0.75), 0, 1);
    case "strikeouts":
      return clamp(smooth((p.projection - 5.5) / 3.0, 0.4, 0.8), 0, 1);
    default:
      return 0.5;
  }
}

/**
 * Converts a parlay leg to the output format
 * Includes Vegas/park verdict for HR picks
 */
function toLeg(p, reason) {
  const legObj = {
    predictionId: p.id,
    player: p.player_name,
    market: p.market,
    gamePk: p.game_pk,
    legProb: legProbabilityFor(p),
    projection: p.projection,
    confidence: p.confidence,
    reason,
  };

  // For HR picks, include verdict info for transparency
  if (p.market === "home_run" && p.features) {
    legObj.verdict = p.verdict;
    legObj.vegasProb = p.features.vegasHrProb;
    legObj.parkProb = p.features.parkHrProb;
  }

  return legObj;
}

/**
 * Assembles a parlay from legs
 * Calculates combined probability, breakeven threshold, and edge
 */
function assembleParlay(name, strategy, legs, minLegs = 4) {
  if (legs.length < minLegs) return null;
  const combined = legs.reduce((a, l) => a * l.legProb, 1);
  const be = breakEvenProbForLegs(legs.length);
  return {
    name,
    strategy,
    legs,
    combinedProb: combined,
    breakEvenProb: be,
    edge: combined - be,
    fairAmericanOdds: probToAmerican(combined),
  };
}

/**
 * Breakeven probability for N legs at -120 juice
 * Accounts for standard sportsbook vigorish
 * At -120: each leg needs to win 54.5% to breakeven on a parlay
 */
function breakEvenProbForLegs(n) {
  return Math.pow(0.545, n);
}

/**
 * Diverse pick selection with constraints
 * Ensures parlays don't become concentrated bets
 */
function pickDiverse(pool, n, opts = {}) {
  const { maxPerGame = 2, maxPerPlayer = 1, bannedPlayerIds = new Set() } = opts;
  const byGame = new Map();
  const byPlayer = new Map();
  const out = [];

  for (const p of pool) {
    if (out.length >= n) break;
    if (bannedPlayerIds.has(p.player_id)) continue;
    if ((byGame.get(p.game_pk) ?? 0) >= maxPerGame) continue;
    if ((byPlayer.get(p.player_id) ?? 0) >= maxPerPlayer) continue;
    out.push(p);
    byGame.set(p.game_pk, (byGame.get(p.game_pk) ?? 0) + 1);
    byPlayer.set(p.player_id, (byPlayer.get(p.player_id) ?? 0) + 1);
  }

  return out;
}

/**
 * Builds 5 core portfolio parlays
 * Each uses a different strategy to diversify edge sources
 */
export function buildParlays(predictions) {
  const pool = predictions.filter((p) => p.data_quality === "ok");
  if (pool.length === 0) return [];

  // Rank all picks by leg probability and confidence
  const ranked = [...pool]
    .map((p) => ({ ...p, _legProb: legProbabilityFor(p) }))
    .sort((a, b) => b._legProb - a._legProb || b.confidence - a.confidence);

  const parlays = [];

  // 1) Safety Net: High-floor, low-variance picks
  {
    const cands = ranked.filter((p) => p.market === "hit_1" || p.market === "hrr");
    const legs = pickDiverse(cands, 5, { maxPerGame: 1 }).map((p) =>
      toLeg(p, "high-floor consistency")
    );
    const par = assembleParlay(
      "Safety Net",
      "5 legs of the highest-floor 1+ hit / HRR spots, max 1 per game.",
      legs
    );
    if (par) parlays.push(par);
  }

  // 2) Balanced Mixer: One leg per market, one per game
  {
    const seenMarkets = new Set();
    const legs = [];
    for (const p of ranked) {
      if (legs.length >= 4) break;
      if (seenMarkets.has(p.market)) continue;
      if (legs.some((l) => l.gamePk === p.game_pk)) continue;
      legs.push(toLeg(p, "top rec-score in its market"));
      seenMarkets.add(p.market);
    }
    const par = assembleParlay(
      "Balanced Mixer",
      "4 legs across 4 different markets and 4 different games.",
      legs
    );
    if (par) parlays.push(par);
  }

  // 3) Pitcher Lean: K props + safe hits in unrelated games
  {
    const ks = ranked.filter((p) => p.market === "strikeouts").slice(0, 2);
    const hits = pickDiverse(
      ranked.filter((p) => p.market === "hit_1" && !ks.some((k) => k.game_pk === p.game_pk)),
      2,
      { maxPerGame: 1 }
    );
    const legs = [...ks, ...hits].map((p) =>
      toLeg(
        p,
        p.market === "strikeouts" ? "starter K matchup" : "safe hit outside a K game"
      )
    );
    const par = assembleParlay(
      "Pitcher Lean",
      "2 K props + 2 safe 1+ hit legs in unrelated games.",
      legs
    );
    if (par) parlays.push(par);
  }

  // 4) Slugger Stack: Total Bases + Home Runs (strong verdicts only)
  {
    const tb = ranked.filter((p) => p.market === "total_bases").slice(0, 3);
    // Include only STRONG HR verdicts in the stack (model beats both baselines)
    const hr = ranked.filter(
      (p) => p.market === "home_run" && p.verdict === "strong"
    ).slice(0, 2);
    const combined = [...tb, ...hr];
    const legs = pickDiverse(combined, 4, { maxPerGame: 2 }).map((p) =>
      toLeg(
        p,
        p.market === "home_run"
          ? `HR: model ${(p.projection * 100).toFixed(1)}% (beats Park & Vegas)`
          : "top total-bases spot"
      )
    );
    const par = assembleParlay(
      "Slugger Stack",
      "Total Bases + HR mix. HR legs use strong verdicts where model beats both Park AND Vegas.",
      legs
    );
    if (par) parlays.push(par);
  }

  // 5) Leverage: High-confidence, high-variance 6-leg parlay
  {
    const cands = ranked.filter((p) => legProbabilityFor(p) > 0.5);
    const legs = pickDiverse(cands, 6, { maxPerGame: 2 }).map((p) =>
      toLeg(p, "positive edge vs -120 juice")
    );
    const par = assembleParlay(
      "Leverage 6-leg",
      "6 legs, each with modeled edge over typical -120 pricing. Highest payoff, highest variance.",
      legs
    );
    if (par) parlays.push(par);
  }

  return parlays;
}

/**
 * Builds HR prospect parlays (2-3 legs)
 * 
 * Strategy: Include BOTH strong and middling HR picks
 * - STRONG: Model probability > both Vegas and ballpark (high confidence)
 * - MIDDLING: Model probability between Vegas and ballpark (potential hidden edge)
 * 
 * This diversifies the source of edge beyond pure confidence scores.
 * Middling picks represent situations where our model sees value the market might miss.
 * 
 * Ranking: By model confidence (high confidence picks ranked first)
 */
export function buildHRParlays(predictions) {
  const pool = predictions.filter((p) => p.market === "home_run" && p.data_quality === "ok");
  if (pool.length === 0) return [];

  // Filter for STRONG and MIDDLING verdicts
  // Exclude FADE to maintain edge focus
  const qualifyingPicks = pool.filter(
    (p) => p.verdict === "strong" || p.verdict === "middling"
  );

  if (qualifyingPicks.length === 0) return [];

  // Rank by confidence (our model's conviction)
  const ranked = [...qualifyingPicks].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
  );

  const templates = [
    { name: "HR Prospects — Top 2", size: 2 },
    { name: "HR Prospects — Trio A", size: 3 },
    { name: "HR Prospects — Trio B", size: 3 },
  ];

  const used = new Set();
  const parlays = [];

  for (const t of templates) {
    const legs = [];
    for (const p of ranked) {
      if (legs.length >= t.size) break;
      if (used.has(p.player_id)) continue;
      if (legs.some((l) => l.gamePk === p.game_pk)) continue;
      const verdictLabel =
        p.verdict === "strong"
          ? "model beats Park & Vegas"
          : "model between Park & Vegas (hidden edge)";
      legs.push(toLeg(p, verdictLabel));
    }
    if (legs.length < t.size) continue;
    for (const l of legs) used.add(pool.find((p) => p.id === l.predictionId)?.player_id);
    const par = assembleParlay(
      t.name,
      `${t.size}-leg home run parlay. Includes strong picks (model > both baselines) + middling picks (model between baselines). Ranked by model confidence.`,
      legs,
      2
    );
    if (par) parlays.push(par);
  }

  return parlays;
}