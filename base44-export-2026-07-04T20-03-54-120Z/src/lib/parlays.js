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

import { clamp, smooth, probToAmerican } from "@/lib/utils/math";
import { getRecommendationMarketPriority, isCoreHitterMarket } from "@/lib/constants/markets";

const PDT_TZ = "America/Los_Angeles";

const SLOT_LABELS = {
  morning: "Between 9am PDT and 12pm PDT",
  noon: "Between 12:01 pm and 3 pm PDT",
  afternoon: "Between 3:01 pm and 5pm PDT",
  left: "Games Left",
};

const PARLAY_RANK_WEIGHTS = {
  ev: 100,
  confidence: 0.52,
  correlationPenalty: 28,
  edge: 85,
};

// Keeps brute-force combination search responsive in the client for large slates.
const MAX_CANDIDATE_PARLAYS = 140;
// Reject only deeply negative cards; keep slightly negative options for thin slates.
const MIN_PARLAY_EV = -0.18;
// Parlays sharing >=67% of legs are considered redundant portfolio exposure.
const MAX_PARLAY_OVERLAP = 0.67;
const MAX_RANKED_POOL_SIZE = 18;
const MIN_PICK_EDGE = -0.04;
const MIN_STRUCTURED_POOL_SIZE = 4;
const MIN_HOME_RUN_POOL_SIZE = 6;
// Keep enough HR candidates in the mixed-card search without letting the
// lower-probability HR market overwhelm the core hitter pool.
const HOME_RUN_POOL_SIZE = Math.max(MIN_HOME_RUN_POOL_SIZE, Math.ceil(MAX_RANKED_POOL_SIZE / 2));

const CORRELATION_COMPONENTS = {
  base: 0.03,
  samePlayer: 0.56,
  sameGame: 0.18,
  sameFamily: 0.13,
  sameMarket: 0.06,
};

function pdtMinutesFromIso(isoUtc) {
  if (!isoUtc) return null;
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PDT_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "NaN");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function slotKeyFromMinutes(minutes) {
  if (minutes == null) return "left";
  if (minutes >= 9 * 60 && minutes <= 12 * 60) return "morning";
  if (minutes >= 12 * 60 + 1 && minutes <= 15 * 60) return "noon";
  if (minutes >= 15 * 60 + 1 && minutes <= 17 * 60) return "afternoon";
  return "left";
}

function splitPredictionsByTimeWindow(predictions) {
  const withSlots = predictions.map((p) => {
    const mins = pdtMinutesFromIso(p.game_time_utc);
    return { ...p, _slotKey: slotKeyFromMinutes(mins) };
  });

  const hasMorningGames = withSlots.some((p) => p._slotKey === "morning");
  if (!hasMorningGames) {
    return [{ key: "left", label: SLOT_LABELS.left, predictions: withSlots }];
  }

  const order = ["morning", "noon", "afternoon", "left"];
  return order
    .map((key) => ({
      key,
      label: SLOT_LABELS[key],
      predictions: withSlots.filter((p) => p._slotKey === key),
    }))
    .filter((s) => s.predictions.length > 0);
}

function parseFeatures(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function probabilityProjection(p, features) {
  if (Number.isFinite(p.projection) && p.projection >= 0 && p.projection <= 1) {
    return p.projection;
  }
  if (Number.isFinite(features?.pOverLine)) {
    return features.pOverLine;
  }
  return null;
}

function probabilityFloorOrSmooth(floor, projection, threshold, minProb, maxProb) {
  if (Number.isFinite(floor) && floor >= 0 && floor <= 1) {
    return clamp(floor, 0, 1);
  }
  return clamp(smooth((projection - threshold) / 1.2, minProb, maxProb), 0, 1);
}

/**
 * Calculates the probability used in parlay leg combinations
 * Different markets use different blend ratios of projection and floor/ceiling
 * 
 * @param {Object} p - Prediction object with market, projection, floor
 * @returns {number} Leg probability [0, 1]
 */
function legProbabilityFor(p) {
  const features = parseFeatures(p.features);
  const projectedProb = probabilityProjection(p, features);
  switch (p.market) {
    case "hit_2":
      return clamp(0.5 * p.floor + 0.5 * p.projection, 0, 1);
    case "home_run":
      return clamp(0.7 * p.projection + 0.3 * p.floor, 0, 1);
    case "total_bases":
      if (projectedProb != null) return clamp(0.7 * projectedProb + 0.3 * (features?.tbOver1_5Prob ?? p.floor), 0, 1);
      return probabilityFloorOrSmooth(p.floor, p.projection, 1.5, 0.35, 0.75);
    case "hrr_2":
      if (projectedProb != null) return clamp(0.7 * projectedProb + 0.3 * (features?.hrrOver1_5Prob ?? p.floor), 0, 1);
      return probabilityFloorOrSmooth(p.floor, p.projection, 2.5, 0.35, 0.75);
    case "hrr_3":
      if (projectedProb != null) return clamp(0.7 * projectedProb + 0.3 * (features?.hrrOver2_5Prob ?? p.floor), 0, 1);
      return probabilityFloorOrSmooth(p.floor, p.projection, 3.5, 0.3, 0.70);
    case "strikeouts":
      return clamp(smooth((p.projection - 6.5) / 3.0, 0.4, 0.8), 0, 1);
    default:
      return 0.5;
  }
}

/**
 * Converts a parlay leg to the output format
 * Includes Vegas/park verdict for HR picks
 */
function toLeg(p, reason) {
  const features = parseFeatures(p.features);
  const legObj = {
    predictionId: p.id,
    playerId: p.player_id,
    player: p.player_name,
    teamName: p.team_name ?? "",
    market: p.market,
    gamePk: p.game_pk,
    legProb: legProbabilityFor(p),
    impliedProb: impliedProbForPrediction(p),
    projection: p.projection,
    confidence: p.confidence,
    tier: p._tier ?? null,
    reason,
  };

  // For HR picks, include verdict info for transparency
  if (p.market === "home_run" && p.features) {
    legObj.verdict = p.verdict;
    legObj.vegasProb = features.vegasHrProb;
    legObj.parkProb = features.parkHrProb;
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
  const avgConfidence = legs.reduce((sum, l) => sum + Number(l.confidence ?? 0), 0) / Math.max(1, legs.length);
  const implied = legs.reduce((acc, leg) => acc * clamp(Number(leg.impliedProb ?? 0.545), 0.05, 0.95), 1);
  const avgEdge = combined - implied;
  return {
    name,
    strategy,
    legs,
    combinedProb: combined,
    breakEvenProb: be,
    edge: combined - be,
    ev: combined * Math.pow(1.8333333333, legs.length) - 1,
    avgConfidence,
    avgEdge,
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

function marketFamily(market) {
  if (market === "home_run") return "home_run";
  if (market === "strikeouts") return "pitcher_k";
  if (market === "hrr_3") return "hrr_ladder";
  return "contact_combo";
}

function impliedProbForPrediction(p) {
  const features = parseFeatures(p.features);
  const fallback = {
    hit_2: 0.33,
    total_bases: 0.53,
    hrr_2: 0.56,
    hrr_3: 0.34,
    home_run: 0.14,
    strikeouts: 0.46,
  };
  return clamp(Number(features?.impliedMarketProb ?? fallback[p.market] ?? 0.545), 0.05, 0.95);
}

function pairCorrelation(a, b) {
  let corr = CORRELATION_COMPONENTS.base;
  if (a.player_id === b.player_id) corr += CORRELATION_COMPONENTS.samePlayer;
  if (a.game_pk === b.game_pk) corr += CORRELATION_COMPONENTS.sameGame;
  if (marketFamily(a.market) === marketFamily(b.market)) corr += CORRELATION_COMPONENTS.sameFamily;
  if (a.market === b.market) corr += CORRELATION_COMPONENTS.sameMarket;
  return clamp(corr, 0, 0.85);
}

function parlayCorrelation(rawLegs) {
  if (rawLegs.length <= 1) return 0;
  let pairSum = 0;
  let pairs = 0;
  for (let i = 0; i < rawLegs.length; i++) {
    for (let j = i + 1; j < rawLegs.length; j++) {
      pairSum += pairCorrelation(rawLegs[i], rawLegs[j]);
      pairs += 1;
    }
  }
  return pairSum / Math.max(1, pairs);
}

function overlapRatio(a, b) {
  const aSet = new Set(a.legs.map((l) => l.predictionId));
  const bSet = new Set(b.legs.map((l) => l.predictionId));
  let inter = 0;
  for (const id of aSet) if (bSet.has(id)) inter += 1;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : inter / union;
}

function enrichParlayRanking(parlay, rawLegs) {
  const correlation = parlayCorrelation(rawLegs);
  const confidence = parlay.avgConfidence ?? 0;
  const ev = parlay.ev ?? 0;
  const rankingScore =
    ev * PARLAY_RANK_WEIGHTS.ev +
    confidence * PARLAY_RANK_WEIGHTS.confidence -
    correlation * PARLAY_RANK_WEIGHTS.correlationPenalty +
    (parlay.avgEdge ?? 0) * PARLAY_RANK_WEIGHTS.edge;
  return {
    ...parlay,
    correlation,
    rankingScore,
  };
}

function dedupeAndRankParlays(candidates, limit = 8) {
  const sorted = [...candidates].sort((a, b) => b.rankingScore - a.rankingScore);
  const out = [];
  for (const cand of sorted) {
    if (out.length >= limit) break;
    // Shared legs above MAX_PARLAY_OVERLAP means the parlay is mostly duplicate exposure.
    if (out.some((existing) => overlapRatio(existing, cand) >= MAX_PARLAY_OVERLAP)) continue;
    out.push(cand);
  }
  return out;
}

function sortStructuredPicksByRank(a, b) {
  return (
    getRecommendationMarketPriority(a.market) - getRecommendationMarketPriority(b.market) ||
    b._edge - a._edge ||
    b._legProb - a._legProb ||
    (b.rec_score ?? 0) - (a.rec_score ?? 0) ||
    (b.confidence ?? 0) - (a.confidence ?? 0)
  );
}

function getCandidatePlayerOverlapCount(candidate, selectedPlayers) {
  if (!selectedPlayers.size) return 0;
  return candidate.legs.reduce((count, leg) => count + (selectedPlayers.has(leg.playerId) ? 1 : 0), 0);
}

function pickBestStructuredCandidate(candidates, selectedParlays) {
  if (candidates.length === 0) return null;
  const selectedPlayers = new Set(
    selectedParlays.flatMap((parlay) => (parlay.legs ?? []).map((leg) => leg.playerId))
  );
  return candidates.sort((a, b) => {
    const overlapDiff = getCandidatePlayerOverlapCount(a, selectedPlayers) - getCandidatePlayerOverlapCount(b, selectedPlayers);
    if (overlapDiff !== 0) return overlapDiff;
    return b.rankingScore - a.rankingScore;
  })[0] ?? null;
}

/**
 * Enumerates structured selected-game parlays that must satisfy an exact
 * home-run-leg count while still optimizing for EV, confidence, and low
 * correlation across unique players.
 */
function buildStructuredParlayCandidates({
  pool,
  size,
  name,
  strategy,
  selectedGameCount,
  exactHomeRunLegs = 0,
}) {
  if (pool.length < size) return [];

  const candidates = [];
  const maxPerGame = adaptiveMaxPerGame(selectedGameCount, size);

  const search = (start, chosen, byGame, byPlayer, homeRunLegs) => {
    // Stop once enough viable cards have been found; this bounded search keeps
    // client-side combinatorics responsive while still producing a large
    // candidate set for EV/correlation ranking on typical slates.
    if (candidates.length >= MAX_CANDIDATE_PARLAYS) return;

    const remaining = size - chosen.length;
    const remainingHomeRunsNeeded = exactHomeRunLegs - homeRunLegs;
    // Prune branches that can no longer satisfy the exact HR-leg requirement.
    if (remainingHomeRunsNeeded > remaining) return;
    if (homeRunLegs > exactHomeRunLegs) return;

    if (chosen.length === size) {
      if (homeRunLegs !== exactHomeRunLegs) return;
      const legs = chosen.map((pick) => toLeg(pick, `portfolio-optimized ${size}-leg build`));
      const parlay = assembleParlay(name, strategy, legs, size);
      if (!parlay) return;
      const enriched = enrichParlayRanking(parlay, chosen);
      candidates.push(enriched);
      return;
    }

    for (let i = start; i < pool.length; i++) {
      const pick = pool[i];
      const isHr = pick.market === "home_run";
      if ((byGame.get(pick.game_pk) ?? 0) >= maxPerGame) continue;
      if ((byPlayer.get(pick.player_id) ?? 0) >= 1) continue;
      if (pick._edge < MIN_PICK_EDGE) continue;

      chosen.push(pick);
      byGame.set(pick.game_pk, (byGame.get(pick.game_pk) ?? 0) + 1);
      byPlayer.set(pick.player_id, (byPlayer.get(pick.player_id) ?? 0) + 1);
      search(i + 1, chosen, byGame, byPlayer, homeRunLegs + (isHr ? 1 : 0));
      chosen.pop();
      byGame.set(pick.game_pk, (byGame.get(pick.game_pk) ?? 1) - 1);
      byPlayer.set(pick.player_id, (byPlayer.get(pick.player_id) ?? 1) - 1);
    }
  };

  search(0, [], new Map(), new Map(), 0);
  return dedupeAndRankParlays(candidates, MAX_CANDIDATE_PARLAYS);
}

function adaptiveMaxPerGame(selectedGameCount, legSize) {
  return Math.max(1, Math.ceil(legSize / Math.max(1, Math.min(selectedGameCount, legSize))));
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

function tierForPrediction(p) {
  const rec = Number(p.rec_score ?? 0);
  const conf = Number(p.confidence ?? 0);
  const leg = Number(p._legProb ?? legProbabilityFor(p));

  if (rec >= 86 || conf >= 84 || leg >= 0.7) return "s";
  if (rec >= 74 || conf >= 72 || leg >= 0.6) return "a";
  if (rec >= 62 || conf >= 62 || leg >= 0.52) return "b";
  return "c";
}

function pickTierMix(ranked, n, plan, opts = {}) {
  const { maxPerGame = 2, maxPerPlayer = 1, bannedPlayerIds = new Set(), allowMarkets = null } = opts;
  const byGame = new Map();
  const byPlayer = new Map();
  const out = [];

  const allowedMarkets = allowMarkets ? new Set(allowMarkets) : null;

  const canAdd = (p) => {
    if (out.length >= n) return false;
    if (bannedPlayerIds.has(p.player_id)) return false;
    if (allowedMarkets && !allowedMarkets.has(p.market)) return false;
    if ((byGame.get(p.game_pk) ?? 0) >= maxPerGame) return false;
    if ((byPlayer.get(p.player_id) ?? 0) >= maxPerPlayer) return false;
    if (out.some((x) => x.id === p.id)) return false;
    return true;
  };

  const add = (p) => {
    out.push(p);
    byGame.set(p.game_pk, (byGame.get(p.game_pk) ?? 0) + 1);
    byPlayer.set(p.player_id, (byPlayer.get(p.player_id) ?? 0) + 1);
  };

  const tierBuckets = {
    s: ranked.filter((p) => p._tier === "s"),
    a: ranked.filter((p) => p._tier === "a"),
    b: ranked.filter((p) => p._tier === "b"),
    c: ranked.filter((p) => p._tier === "c"),
  };

  for (const segment of plan) {
    const bucket = tierBuckets[segment.tier] ?? [];
    let picked = 0;
    for (const p of bucket) {
      if (picked >= segment.count || out.length >= n) break;
      if (!canAdd(p)) continue;
      add(p);
      picked += 1;
    }
  }

  if (out.length < n) {
    for (const p of ranked) {
      if (out.length >= n) break;
      if (!canAdd(p)) continue;
      add(p);
    }
  }

  return out;
}

/**
 * Builds core portfolio parlays.
 *
 * When selectedGamePks is provided (Set or Array), builds parlays only from
 * those games without any time-window splitting (used by the Parlays builder UI).
 * When selectedGamePks is omitted, falls back to the original time-window
 * behaviour (used by the Review page).
 */
export function buildParlays(predictions, selectedGamePks) {
  // ── New game-selected mode ──────────────────────────────────────────────
  if (selectedGamePks !== undefined && selectedGamePks !== null) {
    const pkSet = selectedGamePks instanceof Set ? selectedGamePks : new Set(selectedGamePks);
    if (pkSet.size === 0) return [];
    const strictPool = predictions.filter((p) => pkSet.has(p.game_pk) && p.data_quality === "ok" && p.recommended);
    const broaderPool = predictions.filter((p) => pkSet.has(p.game_pk) && p.data_quality !== "missing");
    const fallbackPool = strictPool.length >= MIN_STRUCTURED_POOL_SIZE
      ? strictPool
      : broaderPool;
    if (fallbackPool.length < MIN_STRUCTURED_POOL_SIZE) return [];

    const scoredPool = [...fallbackPool]
      .map((p) => {
        const legProb = legProbabilityFor(p);
        const impliedProb = impliedProbForPrediction(p);
        const edge = legProb - impliedProb;
        return {
          ...p,
          _legProb: legProb,
          _impliedProb: impliedProb,
          _edge: edge,
          _tier: tierForPrediction(p),
        };
      })
      .sort(sortStructuredPicksByRank);

    const corePool = scoredPool
      .filter((p) => isCoreHitterMarket(p.market))
      .slice(0, MAX_RANKED_POOL_SIZE);
    const homeRunPool = scoredPool
      .filter((p) => p.market === "home_run")
      .slice(0, HOME_RUN_POOL_SIZE);
    if (corePool.length < MIN_STRUCTURED_POOL_SIZE) return [];

    const structuredParlays = [];

    const mixedCandidates = buildStructuredParlayCandidates({
      pool: [...homeRunPool, ...corePool]
        .sort(sortStructuredPicksByRank)
        .slice(0, MAX_RANKED_POOL_SIZE),
      size: 4,
      name: "Best 4-Leg Card (1 HR)",
      strategy: "Exactly one home run leg plus three core hitter props, optimized for EV with diversified player exposure.",
      selectedGameCount: pkSet.size,
      exactHomeRunLegs: 1,
    });
    const bestMixed = pickBestStructuredCandidate(mixedCandidates, structuredParlays);
    if (bestMixed) structuredParlays.push(bestMixed);

    const nonHr4Candidates = buildStructuredParlayCandidates({
      pool: corePool,
      size: 4,
      name: "Best 4-Leg Core Card",
      strategy: "Four high-probability hitter props from HRR, hits, and total bases markets only.",
      selectedGameCount: pkSet.size,
      exactHomeRunLegs: 0,
    });
    const bestNonHr4 = pickBestStructuredCandidate(nonHr4Candidates, structuredParlays);
    if (bestNonHr4) structuredParlays.push(bestNonHr4);

    if (corePool.length >= 5) {
      const nonHr5Candidates = buildStructuredParlayCandidates({
        pool: corePool,
        size: 5,
        name: "Best 5-Leg Core Card",
        strategy: "Five-leg all-core hitter parlay built from the strongest non-HR props on the slate.",
        selectedGameCount: pkSet.size,
        exactHomeRunLegs: 0,
      });
      const bestNonHr5 = pickBestStructuredCandidate(nonHr5Candidates, structuredParlays);
      if (bestNonHr5) structuredParlays.push(bestNonHr5);
    }

    return structuredParlays;
  }

  // ── Legacy time-window mode (Review page backward compat) ──────────────
  const pool = predictions.filter((p) => p.data_quality === "ok");
  if (pool.length === 0) return [];

  const slots = splitPredictionsByTimeWindow(pool);
  const parlays = [];

  for (const slot of slots) {
    const ranked = [...slot.predictions]
      .map((p) => ({ ...p, _legProb: legProbabilityFor(p) }))
      .map((p) => ({ ...p, _tier: tierForPrediction(p) }))
      .sort((a, b) => b._legProb - a._legProb || (b.rec_score ?? 0) - (a.rec_score ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0));

    const usedPlayers = new Set();

    const candsA = ranked.filter(
      (p) => ["hit_2", "hrr_2", "hrr_3", "strikeouts", "total_bases"].includes(p.market) && p._legProb >= 0.48
    );
    const legsA = pickTierMix(
      candsA,
      4,
      [
        { tier: "s", count: 1 },
        { tier: "a", count: 2 },
        { tier: "b", count: 1 },
      ],
      { maxPerGame: 1, maxPerPlayer: 1, bannedPlayerIds: usedPlayers }
    ).map((p) =>
      toLeg(p, `time-window high-floor core (tier ${String(p._tier).toUpperCase()})`)
    );
    const parA = assembleParlay(
      `${slot.label} — Core 4-Leg A`,
      "4 legs from safer profile markets (2+ hit / HRR / K / TB), diversified by game.",
      legsA,
      4
    );
    if (parA) {
      parlays.push({ ...parA, timeWindow: slot.label });
      for (const l of parA.legs) usedPlayers.add(l.playerId);
    }

    const tierPriority = { s: 0, a: 1, b: 2, c: 3 };
    const marketRanked = [...ranked].sort((a, b) =>
      (tierPriority[a._tier] - tierPriority[b._tier]) || (b._legProb - a._legProb) || ((b.rec_score ?? 0) - (a.rec_score ?? 0))
    );

    const legsBPool = [];
    const seenMarkets = new Set();
    const seenGamesLegacy = new Set();
    const seenIdsLegacy = new Set();
    for (const p of marketRanked) {
      if (legsBPool.length >= 4) break;
      if (usedPlayers.has(p.player_id)) continue;
      if (seenMarkets.has(p.market)) continue;
      if (seenGamesLegacy.has(p.game_pk)) continue;
      legsBPool.push(p);
      seenMarkets.add(p.market);
      seenGamesLegacy.add(p.game_pk);
      seenIdsLegacy.add(p.id);
    }
    if (legsBPool.length < 4) {
      for (const p of ranked) {
        if (legsBPool.length >= 4) break;
        if (usedPlayers.has(p.player_id)) continue;
        if (seenIdsLegacy.has(p.id)) continue;
        if (seenGamesLegacy.has(p.game_pk)) continue;
        legsBPool.push(p);
        seenGamesLegacy.add(p.game_pk);
        seenIdsLegacy.add(p.id);
      }
    }
    const legsB = legsBPool.map((p) => toLeg(p, `time-window balanced market mix (tier ${String(p._tier).toUpperCase()})`));
    const parB = assembleParlay(
      `${slot.label} — Core 4-Leg B`,
      "4 legs with market diversity and one-game separation.",
      legsB,
      4
    );
    if (parB) {
      parlays.push({ ...parB, timeWindow: slot.label });
      for (const l of parB.legs) usedPlayers.add(l.playerId);
    }

    const cands5 = ranked.filter((p) => p._legProb >= 0.48);
    let legs5 = pickTierMix(
      cands5,
      5,
      [
        { tier: "s", count: 1 },
        { tier: "a", count: 2 },
        { tier: "b", count: 2 },
      ],
      { maxPerGame: 2, maxPerPlayer: 1, bannedPlayerIds: usedPlayers }
    );
    if (legs5.length < 5) {
      legs5 = pickTierMix(
        cands5,
        5,
        [
          { tier: "s", count: 1 },
          { tier: "a", count: 2 },
          { tier: "b", count: 2 },
        ],
        { maxPerGame: 2, maxPerPlayer: 1 }
      );
    }
    const par5 = assembleParlay(
      `${slot.label} — 5-Leg`,
      "5-leg leverage parlay for the same time window.",
      legs5.map((p) => toLeg(p, `time-window leverage leg (tier ${String(p._tier).toUpperCase()})`)),
      5
    );
    if (par5) parlays.push({ ...par5, timeWindow: slot.label });

    const cands6 = ranked.filter((p) => p._legProb >= 0.5);
    let legs6 = pickTierMix(
      cands6,
      6,
      [
        { tier: "s", count: 1 },
        { tier: "a", count: 2 },
        { tier: "b", count: 2 },
        { tier: "c", count: 1 },
      ],
      { maxPerGame: 2, maxPerPlayer: 1, bannedPlayerIds: usedPlayers }
    );
    if (legs6.length < 6) {
      legs6 = pickTierMix(
        cands6,
        6,
        [
          { tier: "s", count: 1 },
          { tier: "a", count: 2 },
          { tier: "b", count: 2 },
          { tier: "c", count: 1 },
        ],
        { maxPerGame: 2, maxPerPlayer: 1 }
      );
    }
    const par6 = assembleParlay(
      `${slot.label} — 6-Leg`,
      "6-leg leverage parlay for the same time window.",
      legs6.map((p) => toLeg(p, `time-window leverage leg (tier ${String(p._tier).toUpperCase()})`)),
      6
    );
    if (par6) parlays.push({ ...par6, timeWindow: slot.label });

    const aggressivePool = ranked.filter(
      (p) =>
        ["home_run", "hit_2", "total_bases"].includes(p.market) &&
        ["b", "c"].includes(p._tier)
    );
    let twoLegAggressive = pickTierMix(
      aggressivePool,
      2,
      [
        { tier: "c", count: 1 },
        { tier: "b", count: 1 },
      ],
      { maxPerGame: 1, maxPerPlayer: 1 }
    );
    if (twoLegAggressive.length < 2) {
      twoLegAggressive = pickTierMix(
        ranked.filter((p) => ["home_run", "hit_2", "total_bases"].includes(p.market)),
        2,
        [
          { tier: "c", count: 1 },
          { tier: "b", count: 1 },
          { tier: "a", count: 1 },
        ],
        { maxPerGame: 1, maxPerPlayer: 1 }
      );
    }
    const par2Aggressive = assembleParlay(
      `${slot.label} — Aggressive 2-Leg`,
      "2-leg all-aggressive parlay for this time window (high-variance markets only).",
      twoLegAggressive.map((p) =>
        toLeg(p, `100% aggressive leg (${p.market}, tier ${String(p._tier).toUpperCase()})`)
      ),
      2
    );
    if (par2Aggressive) parlays.push({ ...par2Aggressive, timeWindow: slot.label });
  }

  return parlays;
}

/**
 * Builds HR prospect parlays (2-3 legs).
 *
 * Strategy: Include BOTH strong and middling HR picks.
 * - STRONG: Model probability > both Vegas and ballpark (high confidence)
 * - MIDDLING: Model probability between Vegas and ballpark (potential hidden edge)
 *
 * When selectedGamePks is provided, filters to those games and skips time-window
 * splitting (used by the Parlays builder UI).
 * When selectedGamePks is omitted, falls back to original time-window behaviour.
 */
export function buildHRParlays(predictions, selectedGamePks) {
  // ── New game-selected mode ──────────────────────────────────────────────
  if (selectedGamePks !== undefined && selectedGamePks !== null) {
    const pkSet = selectedGamePks instanceof Set ? selectedGamePks : new Set(selectedGamePks);
    if (pkSet.size === 0) return [];

    // Primary pool: "ok" quality HR picks. Fallback to "partial" quality when empty.
    let hrPool = predictions.filter(
      (p) => pkSet.has(p.game_pk) && p.market === "home_run" && p.data_quality === "ok"
    );
    if (hrPool.length === 0) {
      hrPool = predictions.filter(
        (p) => pkSet.has(p.game_pk) && p.market === "home_run" && p.data_quality !== "missing"
      );
    }
    if (hrPool.length === 0) return [];

    // Prefer strong/middling verdicts; fall back to all HR picks if none qualify.
    let qualifyingPicks = hrPool.filter((p) => p.verdict === "strong" || p.verdict === "middling");
    if (qualifyingPicks.length === 0) qualifyingPicks = hrPool;
    if (qualifyingPicks.length === 0) return [];

    const ranked = [...qualifyingPicks].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const parlays = [];
    const used = new Set();

    // Adaptive per-game limit: scale up when fewer games are selected so
    // the user sees parlays even with 1-2 games.
    const adaptiveMax2 = Math.max(1, Math.ceil(2 / Math.min(pkSet.size, 2)));
    const adaptiveMax3 = Math.max(1, Math.ceil(3 / Math.min(pkSet.size, 3)));

    const verdictReason = (p) =>
      p.verdict === "strong"
        ? "model beats Park & Vegas"
        : p.verdict === "middling"
          ? "model between Park & Vegas (hidden edge)"
          : `HR pick (confidence ${Number(p.confidence ?? 0).toFixed(0)})`;

    const twoLeg = pickDiverse(ranked, 2, { maxPerGame: adaptiveMax2, maxPerPlayer: 1, bannedPlayerIds: used }).map((p) =>
      toLeg(p, verdictReason(p))
    );
    const par2 = assembleParlay("HR 2-Leg", "2-leg HR parlay (strong + middling picks allowed).", twoLeg, 2);
    if (par2) { parlays.push(par2); for (const l of par2.legs) used.add(l.playerId); }

    let threeLegPool = pickDiverse(ranked, 3, { maxPerGame: adaptiveMax3, maxPerPlayer: 1, bannedPlayerIds: used });
    if (threeLegPool.length < 3) threeLegPool = pickDiverse(ranked, 3, { maxPerGame: adaptiveMax3, maxPerPlayer: 1 });
    const threeLeg = threeLegPool.map((p) => toLeg(p, verdictReason(p)));
    const par3 = assembleParlay("HR 3-Leg", "3-leg HR parlay (strong + middling picks allowed).", threeLeg, 2);
    if (par3) parlays.push(par3);

    return parlays;
  }

  // ── Legacy time-window mode ─────────────────────────────────────────────
  const pool = predictions.filter((p) => p.market === "home_run" && p.data_quality === "ok");
  if (pool.length === 0) return [];

  // Filter for STRONG and MIDDLING verdicts
  // Exclude FADE to maintain edge focus
  const qualifyingPicks = pool.filter(
    (p) => p.verdict === "strong" || p.verdict === "middling"
  );

  if (qualifyingPicks.length === 0) return [];

  const slots = splitPredictionsByTimeWindow(qualifyingPicks);
  const parlays = [];

  for (const slot of slots) {
    const ranked = [...slot.predictions].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const used = new Set();

    const twoLeg = pickDiverse(ranked, 2, { maxPerGame: 1, maxPerPlayer: 1, bannedPlayerIds: used }).map((p) =>
      toLeg(
        p,
        p.verdict === "strong"
          ? "model beats Park & Vegas"
          : "model between Park & Vegas (hidden edge)"
      )
    );
    const par2 = assembleParlay(
      `${slot.label} — HR 2-Leg`,
      "2-leg HR parlay for this time window (strong + middling picks allowed).",
      twoLeg,
      2
    );
    if (par2) {
      parlays.push({ ...par2, timeWindow: slot.label });
      for (const l of par2.legs) used.add(l.playerId);
    }

    let threeLegPool = pickDiverse(ranked, 3, { maxPerGame: 1, maxPerPlayer: 1, bannedPlayerIds: used });
    if (threeLegPool.length < 3) threeLegPool = pickDiverse(ranked, 3, { maxPerGame: 1, maxPerPlayer: 1 });
    const threeLeg = threeLegPool.map((p) =>
      toLeg(
        p,
        p.verdict === "strong"
          ? "model beats Park & Vegas"
          : "model between Park & Vegas (hidden edge)"
      )
    );
    const par3 = assembleParlay(
      `${slot.label} — HR 3-Leg`,
      "3-leg HR parlay for this time window (strong + middling picks allowed).",
      threeLeg,
      2
    );
    if (par3) parlays.push({ ...par3, timeWindow: slot.label });
  }

  return parlays;
}

/**
 * Builds a custom parlay from a user-selected array of picks.
 *
 * @param {Object[]} selectedPicks - Prediction objects chosen by the user
 * @param {string}   [name]        - Optional display name for the parlay
 * @returns {Object|null} Parlay object, or null if fewer than 2 picks supplied
 */
export function buildCustomParlay(selectedPicks, name) {
  if (!selectedPicks || selectedPicks.length < 2) return null;

  const legs = selectedPicks.map((p) => ({
    predictionId: p.id,
    playerId: p.player_id,
    player: p.player_name,
    teamName: p.team_name ?? "",
    market: p.market,
    gamePk: p.game_pk,
    legProb: legProbabilityFor(p),
    impliedProb: impliedProbForPrediction(p),
    projection: p.projection,
    confidence: p.confidence,
    tier: null,
    reason: "user-selected",
  }));

  const combined = legs.reduce((acc, l) => acc * l.legProb, 1);
  const be = breakEvenProbForLegs(legs.length);

  return {
    name: name ?? `Custom ${legs.length}-Leg`,
    strategy: "User-selected custom parlay",
    legs,
    combinedProb: combined,
    breakEvenProb: be,
    edge: combined - be,
    fairAmericanOdds: probToAmerican(combined),
  };
}