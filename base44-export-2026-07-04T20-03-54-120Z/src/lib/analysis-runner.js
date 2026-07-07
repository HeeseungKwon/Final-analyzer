const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

// Client-side analysis runner that calls MLB API + scoring engine + persists to entities

import {
  fetchSchedule,
  fetchHitterStats,
  fetchHitterRecent,
  fetchPitcherStats,
  fetchTeamHittingSO,
  fetchGameLineup,
  currentMlbSeason,
  todayIsoDate,
} from "@/lib/mlb-api";
import { scoreHitter, scorePitcher, parkFactorFor, getHitterSimulationData } from "@/lib/scoring";
import { getRecommendationMarketPriority } from "@/lib/constants/markets";
import { enrichPredictionWithProjections, getAllMarketRankings } from "@/lib/projection-scorer";

// Support for gradual rollout: wrap new engine calls with fallback
const USE_NEW_ENGINE = true;

const MARKET_LIMITS = {
  hit_2: 10,
  hrr_2: 12,
  hrr_3: 10,
  total_bases: 12,
  home_run: 12,
  strikeouts: 8,
};

const MARKET_MIN_CONFIDENCE = {
  hit_2: 57,
  hrr_2: 55,
  hrr_3: 52,
  total_bases: 55,
  home_run: 58,
  strikeouts: 57,
};

const MARKET_TRUST_BONUS = {
  strikeouts: 8,
  total_bases: 5,
  hrr_2: 4,
  hrr_3: 3,
  home_run: 3,
  hit_2: 2,
};

const MARKET_RECOMMENDATION_FOCUS_BONUS = {
  // Tuned as a soft portfolio nudge rather than a hard gate: core hitter props
  // get a modest lift, while HR props take a modest penalty because they now
  // live in a separate section and should not crowd out the higher-probability
  // HRR / hits / TB recommendations.
  hrr_2: 8,
  hrr_3: 6,
  hit_2: 4,
  total_bases: 2,
  // Home runs stay supported, but the main hitter recommendation flow now
  // prioritizes higher-probability HRR/hits/TB props and surfaces HR picks
  // separately instead of letting them dominate the portfolio.
  home_run: -8,
};
// Small enough to preserve the underlying rec_score ordering, but large enough
// to break close calls in favor of the configured market priority order.
const PRIORITY_PENALTY_FACTOR = 0.75;

const PORTFOLIO_STYLE_WEIGHTS = {
  aggressive: 0.4,
  neutral: 0.4,
  conservative: 0.2,
};

const REDUNDANCY_RULES = {
  maxPicksPerPlayer: 2,
  maxPerGame: 6,
  hrr3EdgeDelta: 0.015,
  hrr3MinConfidence: 58,
};

function parseFeatures(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rankForPortfolio(row) {
  const features = parseFeatures(row.features);
  const marketBonus = MARKET_TRUST_BONUS[row.market] ?? 0;
  const focusBonus = MARKET_RECOMMENDATION_FOCUS_BONUS[row.market] ?? 0;
  const modelEdge = Number(features.modelEdge ?? 0);
  const impliedProb = Number(features.impliedMarketProb ?? 0.5);

  const pOver = Number(features.pOverLine);
  const pOverBonus = Number.isFinite(pOver) ? Math.max(0, (pOver - 0.5) * 45) : 0;
  const edgeBonus = Math.max(-4, Math.min(12, modelEdge * 100 * 0.65));
  const variancePenalty = Number(features.variancePenalty ?? 0) * 6;
  const marketAlignment = Math.max(0, 8 - Math.abs((pOver || impliedProb) - impliedProb) * 12);

  const spread = Math.max(0, (row.ceiling ?? 0) - (row.floor ?? 0));
  const certaintyBonus = Math.max(0, 8 - spread * 12);

  // Bonus for STRONG/MIDDLING HR picks (model beats or sits between baselines)
  let verdictBonus = 0;
  if (row.market === "home_run") {
    if (row.verdict === "strong") verdictBonus = 10;
    else if (row.verdict === "middling") verdictBonus = 5;
  }

  const priorityPenalty = getRecommendationMarketPriority(row.market) * PRIORITY_PENALTY_FACTOR;

  return (row.rec_score ?? 0) + marketBonus + focusBonus + pOverBonus + edgeBonus + certaintyBonus + marketAlignment + verdictBonus - variancePenalty - priorityPenalty;
}

function styleForPortfolio(row) {
  const features = parseFeatures(row.features);
  const spread = Math.max(0, (row.ceiling ?? 0) - (row.floor ?? 0));
  const pOver = Number(features.pOverLine ?? NaN);

  if (
    row.market === "home_run" ||
    row.market === "hit_2" ||
    (["total_bases", "hrr_2", "hrr_3"].includes(row.market) && spread > 0.18) ||
    (Number.isFinite(pOver) && pOver < 0.58)
  ) {
    return "aggressive";
  }

  if (
    (row.market === "strikeouts") &&
    (row.confidence ?? 0) >= 72 &&
    spread <= (row.market === "strikeouts" ? 3.2 : 0.28)
  ) {
    return "conservative";
  }

  return "neutral";
}

function rebalanceRecommendations(rows) {
  // Target up to 50 unique players per day. A player with multiple market
  // types (HR, HRR, TB, Hits) counts as ONE unique player toward this target.
  // When fewer than 50 valid candidates exist all available players are returned.
  const TARGET_UNIQUE_PLAYERS = 50;
  // Keep at most two markets per player to reduce redundant exposure while
  // still allowing one secondary market when edge is materially distinct.
  const MAX_PICKS_PER_PLAYER = REDUNDANCY_RULES.maxPicksPerPlayer;
  const POWER_MARKETS = new Set(["home_run", "hrr_2", "hrr_3", "total_bases"]);

  const candidates = rows
    .map((row, idx) => ({
      row,
      idx,
      portfolioScore: rankForPortfolio(row),
      style: styleForPortfolio(row),
    }))
    .filter(({ row }) => row.data_quality !== "missing")
    .filter(({ row }) => (row.confidence ?? 0) >= (MARKET_MIN_CONFIDENCE[row.market] ?? 58))
    .sort((a, b) => b.portfolioScore - a.portfolioScore);

  const byMarket = new Map();
  const byPlayer = new Map();
  const byGame = new Map();
  const playerFamilies = new Map();
  const playerPowerTaken = new Set();
  const selected = new Set();
  // Dedupe key: unique player identities selected (counts toward the 50-player target)
  const uniqueSelectedPlayers = new Set();

  const eligiblePlayers = new Set(candidates.map((c) => c.row.player_id));
  // Cap target at the number of actually available players to avoid crashing
  const targetUniquePlayers = Math.min(TARGET_UNIQUE_PLAYERS, eligiblePlayers.size);

  const canTake = (c) => {
    if (selected.has(c.idx)) return false;
    // Do not admit new players once the unique-player target is reached;
    // additional market picks for already-selected players are still allowed.
    if (!uniqueSelectedPlayers.has(c.row.player_id) && uniqueSelectedPlayers.size >= targetUniquePlayers) return false;

    const marketCount = byMarket.get(c.row.market) ?? 0;
    if (marketCount >= (MARKET_LIMITS[c.row.market] ?? 10)) return false;

    const playerCount = byPlayer.get(c.row.player_id) ?? 0;
    if (playerCount >= MAX_PICKS_PER_PLAYER) return false;

    if (POWER_MARKETS.has(c.row.market) && playerPowerTaken.has(c.row.player_id)) return false;

    const gameCount = byGame.get(c.row.game_pk) ?? 0;
    if (gameCount >= REDUNDANCY_RULES.maxPerGame) return false;

    const families = playerFamilies.get(c.row.player_id) ?? new Set();
    const family = marketFamily(c.row.market);
    if (families.has(family)) return false;

    return true;
  };

  const take = (c) => {
    selected.add(c.idx);
    byMarket.set(c.row.market, (byMarket.get(c.row.market) ?? 0) + 1);
    byPlayer.set(c.row.player_id, (byPlayer.get(c.row.player_id) ?? 0) + 1);
    byGame.set(c.row.game_pk, (byGame.get(c.row.game_pk) ?? 0) + 1);
    uniqueSelectedPlayers.add(c.row.player_id);
    if (POWER_MARKETS.has(c.row.market)) {
      playerPowerTaken.add(c.row.player_id);
    }
    const families = playerFamilies.get(c.row.player_id) ?? new Set();
    families.add(marketFamily(c.row.market));
    playerFamilies.set(c.row.player_id, families);
  };

  // Phase 1: Fill style buckets targeting unique players per style
  const styleTargets = {
    aggressive: Math.round(targetUniquePlayers * PORTFOLIO_STYLE_WEIGHTS.aggressive),
    neutral: Math.round(targetUniquePlayers * PORTFOLIO_STYLE_WEIGHTS.neutral),
  };
  styleTargets.conservative = Math.max(0, targetUniquePlayers - styleTargets.aggressive - styleTargets.neutral);

  const styleBuckets = {
    aggressive: candidates.filter((c) => c.style === "aggressive"),
    neutral: candidates.filter((c) => c.style === "neutral"),
    conservative: candidates.filter((c) => c.style === "conservative"),
  };

  for (const style of ["aggressive", "neutral", "conservative"]) {
    let uniqueInStyle = 0;
    for (const c of styleBuckets[style]) {
      if (uniqueInStyle >= styleTargets[style]) break;
      // Skip players already admitted via another style
      if (uniqueSelectedPlayers.has(c.row.player_id)) continue;
      if (!canTake(c)) continue;
      take(c);
      uniqueInStyle += 1;
    }
  }

  // Phase 2: Single pass over all candidates — fills remaining unique-player slots
  // AND adds additional market-type picks for already-selected players.
  // canTake() blocks new players once targetUniquePlayers is reached while still
  // allowing extra market picks for players already in the selection.
  for (const c of candidates) {
    if (!canTake(c)) continue;
    take(c);
  }

  rows.forEach((r, idx) => {
    r.recommended = selected.has(idx);
  });
}

function marketFamily(market) {
  if (market === "strikeouts") return "pitcher_k";
  if (market === "home_run") return "home_run";
  if (market === "hrr_3") return "hrr_ladder";
  return "contact_combo";
}

function pruneRedundantRecommendations(rows) {
  const recommendedByPlayer = new Map();
  rows.forEach((row, idx) => {
    if (!row.recommended) return;
    if (!recommendedByPlayer.has(row.player_id)) recommendedByPlayer.set(row.player_id, []);
    recommendedByPlayer.get(row.player_id).push({ row, idx, features: parseFeatures(row.features) });
  });

  for (const picks of recommendedByPlayer.values()) {
    if (picks.length <= 1) continue;
    picks.sort((a, b) => (b.row.rec_score ?? 0) - (a.row.rec_score ?? 0));

    const keep = new Set();
    const familyBest = new Map();
    for (const pick of picks) {
      const family = marketFamily(pick.row.market);
      const existing = familyBest.get(family);
      if (!existing || (pick.row.rec_score ?? 0) > (existing.row.rec_score ?? 0)) {
        familyBest.set(family, pick);
      }
    }

    for (const best of familyBest.values()) keep.add(best.idx);

    const hrr2 = picks.find((p) => p.row.market === "hrr_2");
    const hrr3 = picks.find((p) => p.row.market === "hrr_3");
    if (hrr2 && hrr3) {
      const hrr3Edge = Number(hrr3.features.modelEdge ?? 0);
      const hrr2Edge = Number(hrr2.features.modelEdge ?? 0);
      if (
        hrr3Edge >= hrr2Edge + REDUNDANCY_RULES.hrr3EdgeDelta &&
        (hrr3.row.confidence ?? 0) >= REDUNDANCY_RULES.hrr3MinConfidence
      ) {
        keep.add(hrr3.idx);
      } else {
        keep.delete(hrr3.idx);
      }
    }

    picks.forEach((pick) => {
      rows[pick.idx].recommended = keep.has(pick.idx);
    });
  }
}

/**
 * Top-up and overflow stage for daily recommended picks.
 *
 * Policy (applied after rebalanceRecommendations):
 *
 * MIN_DAILY_PICKS = 50
 *   After primary rebalancing, if fewer than 50 picks are recommended, the best
 *   near-threshold candidates (sorted by portfolioScore desc) are promoted until
 *   50 is reached or candidates run out.  The relaxed confidence gate is 42 (vs
 *   the primary gate of 55-58) so that near-miss picks are considered.
 *
 * HIGH_CONF_THRESHOLD = 78  (rec_score)
 *   After reaching 50, any pick whose rec_score ≥ 78 is included regardless of
 *   count.  This allows the total to exceed 50 on high-confidence slates without
 *   admitting low-quality picks.
 *
 * Stability: near-threshold candidates are sorted deterministically by
 * portfolioScore (desc) then by player_id (asc) so that equal-score ties do not
 * cause random ordering across runs.
 */
function topUpRecommendations(rows) {
  // Minimum recommended picks to guarantee per analysis run.
  const MIN_DAILY_PICKS = 50;

  // Relaxed confidence gate for top-up candidates (vs primary gate of 55–58).
  // Set at 42 to capture near-miss picks that are slightly below the primary
  // MARKET_MIN_CONFIDENCE thresholds (55–58) but still represent real signal.
  // Picks at this level are treated as "honorable mentions" that only appear
  // when the primary selection falls short of the 50-pick minimum.
  const TOPUP_MIN_CONFIDENCE = 42;

  // rec_score threshold for automatic overflow above MIN_DAILY_PICKS.
  // 78 was chosen to sit between the grade-A boundary (72) and grade-S boundary
  // (85) in pickGrade.js, capturing picks the model is highly confident in
  // without opening the floodgates to all grade-A picks on large slates.
  const HIGH_CONF_THRESHOLD = 78;

  // Only operate on non-final (non-"missing" quality) rows that are not yet recommended.
  const notYetRec = rows
    .map((row, idx) => ({
      row,
      idx,
      portfolioScore: rankForPortfolio(row),
    }))
    .filter(({ row }) => !row.recommended)
    .filter(({ row }) => row.data_quality !== "missing")
    .filter(({ row }) => (row.confidence ?? 0) >= TOPUP_MIN_CONFIDENCE)
    // Stable sort: primary desc portfolioScore, secondary asc player_id for determinism
    .sort((a, b) =>
      b.portfolioScore - a.portfolioScore ||
      String(a.row.player_id).localeCompare(String(b.row.player_id))
    );

  const currentCount = rows.filter((r) => r.recommended).length;

  let promoted = 0;
  for (const c of notYetRec) {
    const totalRec = currentCount + promoted;

    // Always include high-confidence picks regardless of count ceiling
    if ((c.row.rec_score ?? 0) >= HIGH_CONF_THRESHOLD) {
      rows[c.idx].recommended = true;
      promoted += 1;
      continue;
    }

    // Top-up to minimum 50 picks
    if (totalRec < MIN_DAILY_PICKS) {
      rows[c.idx].recommended = true;
      promoted += 1;
    }
  }
}

function expectedPAForBattingOrder(order) {
  if (!order || order <= 0) return 3.8;
  if (order <= 2) return 4.5;
  if (order <= 5) return 4.2;
  if (order <= 7) return 3.9;
  return 3.6;
}

export async function runAnalysis(dateArg, onProgress) {
  const date = dateArg || todayIsoDate();
  const season = currentMlbSeason(new Date(date));
  const log = (msg) => onProgress?.(msg);

  log("Fetching schedule...");
  const games = await fetchSchedule(date);
  if (games.length === 0) {
    return { date, games: 0, predictions: 0, excluded: 0, message: "No games scheduled." };
  }

  log(`Found ${games.length} games. Fetching lineups...`);

  for (const g of games) {
    try {
      const lineup = await fetchGameLineup(g.game_pk);
      g.home_lineup_players = lineup.home;
      g.away_lineup_players = lineup.away;
      g.home_lineup = lineup.home.map((p) => p.id);
      g.away_lineup = lineup.away.map((p) => p.id);
    } catch {
      // lineups not available
    }
  }

  log("Clearing old data...");
  try {
    const oldGames = await db.entities.Game.filter({ game_date: date });
    if (oldGames.length > 0) await db.entities.Game.deleteMany({ game_date: date });
  } catch {}
  try {
    const oldPreds = await db.entities.Prediction.filter({ game_date: date });
    if (oldPreds.length > 0) await db.entities.Prediction.deleteMany({ game_date: date });
  } catch {}
  try {
    const oldExcl = await db.entities.ExcludedPlayer.filter({ game_date: date });
    if (oldExcl.length > 0) await db.entities.ExcludedPlayer.deleteMany({ game_date: date });
  } catch {}

  log("Saving games...");
  await db.entities.Game.bulkCreate(
    games.map((g) => ({
      game_pk: g.game_pk,
      game_date: g.game_date,
      game_time_utc: g.game_time_utc ?? "",
      home_team_id: g.home_team_id,
      home_team_name: g.home_team_name,
      away_team_id: g.away_team_id,
      away_team_name: g.away_team_name,
      venue_name: g.venue_name ?? "",
      home_probable_pitcher_id: g.home_probable_pitcher_id ?? 0,
      home_probable_pitcher_name: g.home_probable_pitcher_name ?? "",
      away_probable_pitcher_id: g.away_probable_pitcher_id ?? 0,
      away_probable_pitcher_name: g.away_probable_pitcher_name ?? "",
      status: g.status,
    }))
  );

  const teamHitK = new Map();
  async function getTeamHitK(id) {
    if (!teamHitK.has(id)) {
      const r = await fetchTeamHittingSO(id, season);
      teamHitK.set(id, r?.k_percent ?? null);
    }
    return teamHitK.get(id);
  }

  const pitcherStatCache = new Map();
  async function getSPStats(pid) {
    if (!pid) return null;
    if (!pitcherStatCache.has(pid)) {
      const s = await fetchPitcherStats(pid, season);
      pitcherStatCache.set(pid, s ?? null);
    }
    return pitcherStatCache.get(pid);
  }

  const predictionRows = [];
  const excludedRows = [];
  let processedGames = 0;

  for (const g of games) {
    processedGames++;
    log(`Scoring game ${processedGames}/${games.length}: ${g.away_team_name} @ ${g.home_team_name}...`);

    for (const side of ["home", "away"]) {
      const teamId = side === "home" ? g.home_team_id : g.away_team_id;
      const teamName = side === "home" ? g.home_team_name : g.away_team_name;
      const oppSP = side === "home" ? g.away_probable_pitcher_id : g.home_probable_pitcher_id;
      const lineupPlayers = side === "home" ? g.home_lineup_players : g.away_lineup_players;

      if (lineupPlayers.length === 0) {
        excludedRows.push({
          game_date: date,
          player_name: `${side === "home" ? g.home_team_name : g.away_team_name} lineup`,
          reason: "Starting lineup not available at analysis time.",
        });
        continue;
      }

      const oppSPStats = await getSPStats(oppSP);
      const oppSPk = oppSPStats?.k_percent ?? null;
      const oppSPhrPerBF = oppSPStats && (oppSPStats.bf ?? 0) > 0
        ? (oppSPStats.hr_allowed ?? 0) / oppSPStats.bf
        : null;

      for (const lp of lineupPlayers) {
        try {
          const [seasonStats, recent] = await Promise.all([
            fetchHitterStats(lp.id, season),
            fetchHitterRecent(lp.id, season, 15),
          ]);
          if (!seasonStats && !recent) {
            excludedRows.push({ game_date: date, player_id: lp.id, player_name: lp.fullName, reason: "No hitting stats available" });
            continue;
          }

          const baseCtx = {
            season: seasonStats,
            recent,
            oppPitcherK: oppSPk,
            oppPitcherHrPerBF: oppSPhrPerBF,
            oppPitcherGbFbRatio: oppSPStats?.gb_fb_ratio ?? null,
            oppBullpenK: null,
            expectedPA: expectedPAForBattingOrder(lp.battingOrder),
            battingOrder: lp.battingOrder,
            parkFactor: parkFactorFor(g.home_team_id),
            teamImpliedTotal: null,
            onbaseRateAhead: null,
            onbaseRateBehind: null,
            vegasHrProb: null,
          };

          const modernScores = scoreHitter(lp.fullName, baseCtx);
          
          // Get simulation data for projection scoring
          let simulationData = null;
          try {
            simulationData = getHitterSimulationData(baseCtx);
          } catch {}

          for (const s of modernScores) {
            // Base prediction row
            let predRow = {
              game_pk: g.game_pk,
              game_date: date,
              player_id: lp.id,
              player_name: lp.fullName,
              team_id: teamId,
              team_name: teamName,
              player_type: "hitter",
              market: s.market,
              confidence: Math.round(s.confidence * 100) / 100,
              projection: Math.round(s.projection * 10000) / 10000,
              floor: Math.round(s.floor * 10000) / 10000,
              ceiling: Math.round(s.ceiling * 10000) / 10000,
              trigger_text: s.trigger,
              trigger_strength: Math.round(s.triggerStrength * 100) / 100,
              features: JSON.stringify(s.features ?? {}),
              data_quality: s.dataQuality,
              recommended: s.recommended,
              rec_score: Math.round(s.recScore * 100) / 100,
              verdict: s.verdict ?? "",
              verdict_note: s.verdictNote ?? "",
            };
            
            // Enrich with projection scores if simulation data available
            if (simulationData) {
              try {
                const enriched = enrichPredictionWithProjections(
                  predRow,
                  baseCtx,
                  simulationData,
                  {
                    "hit_2": s.market === "hit_2" ? s.projection : null,
                    "total_bases": s.market === "total_bases" ? s.projection : null,
                    "hrr_2": s.market === "hrr_2" ? s.projection : null,
                    "hrr_3": s.market === "hrr_3" ? s.projection : null,
                    "home_run": s.market === "home_run" ? s.projection : null,
                  },
                  s.dataQuality
                );
                predRow = enriched;
              } catch {}
            }
            
            predictionRows.push(predRow);
          }
        } catch (e) {
          excludedRows.push({ game_date: date, player_id: lp.id, player_name: lp.fullName, reason: `Error: ${e.message}` });
        }
      }
    }

    for (const side of ["home", "away"]) {
      const pid = side === "home" ? g.home_probable_pitcher_id : g.away_probable_pitcher_id;
      const pname = side === "home" ? g.home_probable_pitcher_name : g.away_probable_pitcher_name;
      const teamId = side === "home" ? g.home_team_id : g.away_team_id;
      const teamName = side === "home" ? g.home_team_name : g.away_team_name;
      const oppTeamId = side === "home" ? g.away_team_id : g.home_team_id;
      if (!pid || !pname) {
        excludedRows.push({
          game_date: date,
          player_name: `${side === "home" ? g.home_team_name : g.away_team_name} starter`,
          reason: "Probable pitcher not announced",
        });
        continue;
      }
      try {
        const st = await fetchPitcherStats(pid, season);
        if (!st) {
          excludedRows.push({ game_date: date, player_id: pid, player_name: pname, reason: "No pitching stats available" });
          continue;
        }
        const oppTeamKRate = await getTeamHitK(oppTeamId);
        const modernScores = scorePitcher(pname, {
          season: st,
          oppTeamK: oppTeamKRate,
          expectedIP: 5.5,
        });

        for (const s of modernScores) {
          predictionRows.push({
            game_pk: g.game_pk,
            game_date: date,
            player_id: pid,
            player_name: pname,
            team_id: teamId,
            team_name: teamName,
            player_type: "pitcher",
            market: s.market,
            confidence: Math.round(s.confidence * 100) / 100,
            projection: Math.round(s.projection * 10000) / 10000,
            floor: Math.round(s.floor * 10000) / 10000,
            ceiling: Math.round(s.ceiling * 10000) / 10000,
            trigger_text: s.trigger,
            trigger_strength: Math.round(s.triggerStrength * 100) / 100,
            features: JSON.stringify(s.features ?? {}),
            data_quality: s.dataQuality,
            recommended: s.recommended,
            rec_score: Math.round(s.recScore * 100) / 100,
            verdict: s.verdict ?? "",
            verdict_note: s.verdictNote ?? "",
          });
        }
      } catch (e) {
        excludedRows.push({ game_date: date, player_id: pid, player_name: pname, reason: `Error: ${e.message}` });
      }
    }
  }

  rebalanceRecommendations(predictionRows);
  topUpRecommendations(predictionRows);
  pruneRedundantRecommendations(predictionRows);

  log(`Saving ${predictionRows.length} predictions...`);
  const BATCH = 50;
  for (let i = 0; i < predictionRows.length; i += BATCH) {
    await db.entities.Prediction.bulkCreate(predictionRows.slice(i, i + BATCH));
  }

  if (excludedRows.length > 0) {
    log(`Saving ${excludedRows.length} exclusions...`);
    await db.entities.ExcludedPlayer.bulkCreate(excludedRows);
  }

  log("Done!");
  return {
    date,
    games: games.length,
    predictions: predictionRows.length,
    excluded: excludedRows.length,
    message: `Analysis complete: ${games.length} games, ${predictionRows.length} predictions, ${excludedRows.length} excluded.`,
  };
}
