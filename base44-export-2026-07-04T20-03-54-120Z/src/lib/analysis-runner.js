const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

// Client-side analysis runner that calls MLB API + scoring engine + persists to entities

import {
  fetchSchedule,
  fetchHitterStats,
  fetchHitterRecent,
  fetchHitterSplitVsHand,
  fetchPitcherHand,
  fetchPitcherStats,
  fetchTeamHittingStats,
  fetchTeamHittingSO,
  fetchGameLineup,
  currentMlbSeason,
  todayIsoDate,
} from "@/lib/mlb-api";
import { edgeBasedScoring, scoreHitter, scorePitcher, parkFactorFor, getHitterSimulationData } from "@/lib/scoring";
import { fetchRealtimeOdds } from "@/lib/sportsbook-api";
import { enrichPredictionWithProjections } from "@/lib/projection-scorer";

const DEFAULT_PITCHER_ERA = 4.0;

function parseFeatures(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rebalanceRecommendations(rows) {
  rows.forEach((row) => {
    const features = parseFeatures(row.features);
    // Downstream pages/entities still read the legacy `rec_score` field, so it
    // now carries the probability-first recommendation score when available.
    row.rec_score = Number.isFinite(Number(features.recommendationScore))
      ? Math.round(Number(features.recommendationScore) * 100) / 100
      : edgeToRecScore(features.edge);
    row.recommended = Boolean(features.recommended ?? row.recommended);
  });
}

function pruneRedundantRecommendations() {
  // Edge-based mode intentionally keeps every qualified pick visible rather than
  // pruning by portfolio heuristics. The function remains as a no-op so the
  // existing runAnalysis flow stays compatible with persisted entities/pages.
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
  // Legacy top-up logic forced a minimum pick count. The redesigned engine keeps
  // recommendations strict: only +5% edge plays stay recommended.
  // TODO: remove this compatibility hook once all callers stop depending on the
  // legacy recommendation pipeline shape.
  return rows;
}

function expectedPAForBattingOrder(order) {
  if (!order || order <= 0) return 3.8;
  if (order <= 2) return 4.5;
  if (order <= 5) return 4.2;
  if (order <= 7) return 3.9;
  return 3.6;
}

function edgeToRecScore(edge) {
  return Math.round(Number(edge ?? 0) * 10000) / 100;
}

function buildEdgeFeatures(baseFeatures, edgeMetrics, oddsInfo) {
  return {
    ...(baseFeatures ?? {}),
    pOverLine: edgeMetrics.modelProbability,
    modelProbability: edgeMetrics.modelProbability,
    marketOdds: edgeMetrics.marketOdds,
    marketLine: edgeMetrics.marketLine,
    impliedProbability: edgeMetrics.impliedProbability,
    impliedMarketProb: edgeMetrics.impliedProbability,
    edge: edgeMetrics.edge,
    modelEdge: edgeMetrics.edge,
    expectedValue: edgeMetrics.expectedValue,
    roi: edgeMetrics.roi,
    kellyFraction: edgeMetrics.kellyFraction,
    recommendedStake: edgeMetrics.recommendedStake,
    edgeGrade: edgeMetrics.edgeGrade,
    recommendationScore: edgeMetrics.recommendationScore,
    recommendationComponents: edgeMetrics.recommendationComponents,
    recommendationReasons: edgeMetrics.recommendationReasons,
    oddsSource: oddsInfo.source,
    sportsbookProvider: oddsInfo.provider,
    oddsFallback: oddsInfo.fallbackUsed,
    oddsFallbackReason: oddsInfo.fallbackReason,
    oddsEventId: oddsInfo.eventId,
    recommended: edgeMetrics.recommended,
  };
}

/**
 * @param {string} [dateArg]       Analysis date (YYYY-MM-DD, defaults to today)
 * @param {Function} [onProgress]  Progress callback
 * @param {object} [opts]          { refreshOdds: boolean } — pass true to bypass the sportsbook snapshot
 */
export async function runAnalysis(dateArg, onProgress, opts = {}) {
  const date = dateArg || todayIsoDate();
  const season = currentMlbSeason(new Date(date));
  const log = (msg) => onProgress?.(msg);
  const refreshOdds = Boolean(opts?.refreshOdds);

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

  // Team hitting stats (OBP + runs/game) — used for onbaseRateAhead/Behind and teamImpliedTotal proxy
  const teamHittingCache = new Map();
  async function getTeamHitting(id) {
    if (!teamHittingCache.has(id)) {
      const r = await fetchTeamHittingStats(id, season);
      teamHittingCache.set(id, r ?? { obp: 0.320, runsPerGame: 4.5 });
    }
    return teamHittingCache.get(id);
  }

  // Pitcher throwing-hand cache
  const pitcherHandCache = new Map();
  async function getOppPitcherHand(pid) {
    if (!pid) return null;
    if (!pitcherHandCache.has(pid)) {
      const h = await fetchPitcherHand(pid);
      pitcherHandCache.set(pid, h ?? null);
    }
    return pitcherHandCache.get(pid);
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

      const [oppSPStats, oppSPHand, teamStats] = await Promise.all([
        getSPStats(oppSP),
        getOppPitcherHand(oppSP),
        getTeamHitting(teamId),
      ]);
      const oppPitcherStats = oppSPStats
        ? {
            bf: oppSPStats.bf ?? 0,
            hits_allowed: oppSPStats.hits_allowed ?? 0,
            hr_allowed: oppSPStats.hr_allowed ?? 0,
            bb: oppSPStats.bb ?? 0,
            era: oppSPStats.era ?? DEFAULT_PITCHER_ERA,
            k_percent: oppSPStats.k_percent ?? 0,
          }
        : null;
      const oppSPk = oppSPStats?.k_percent ?? null;
      const oppSPhrPerBF = oppSPStats && (oppSPStats.bf ?? 0) > 0
        ? (oppSPStats.hr_allowed ?? 0) / oppSPStats.bf
        : null;

      for (const lp of lineupPlayers) {
        try {
          const [seasonStats, recent, splitStats] = await Promise.all([
            fetchHitterStats(lp.id, season),
            fetchHitterRecent(lp.id, season, 15),
            fetchHitterSplitVsHand(lp.id, season, oppSPHand),
          ]);
          if (!seasonStats && !recent) {
            excludedRows.push({ game_date: date, player_id: lp.id, player_name: lp.fullName, reason: "No hitting stats available" });
            continue;
          }

          const baseCtx = {
            season: seasonStats,
            recent,
            split: splitStats,
            oppPitcherStats,
            oppPitcherK: oppSPk,
            oppPitcherHrPerBF: oppSPhrPerBF,
            oppPitcherGbFbRatio: oppSPStats?.gb_fb_ratio ?? null,
            oppBullpenK: null,
            expectedPA: expectedPAForBattingOrder(lp.battingOrder),
            battingOrder: lp.battingOrder,
            parkFactor: parkFactorFor(g.home_team_id),
            // Team's season R/G used as proxy for run-scoring environment
            teamImpliedTotal: teamStats?.runsPerGame ?? 4.5,
            // Team OBP used as proxy for runners-on-base context ahead/behind
            onbaseRateAhead: teamStats?.obp ?? 0.320,
            onbaseRateBehind: teamStats?.obp ?? 0.320,
            vegasHrProb: null,
          };

          const modernScores = scoreHitter(lp.fullName, baseCtx);
          
          // Get simulation data for projection scoring
          let simulationData = null;
          try {
            simulationData = getHitterSimulationData(baseCtx);
          } catch {}

          const scoredPredictions = await Promise.all(modernScores.map(async (s) => {
            const oddsInfo = await fetchRealtimeOdds(g.game_pk, s.market, lp.fullName, {
              gameDate: g.game_date,
              homeTeamName: g.home_team_name,
              awayTeamName: g.away_team_name,
            }, { refreshOdds });
            const edgeMetrics = edgeBasedScoring({
              market: s.market,
              projection: s.projection,
              floor: s.floor,
              ceiling: s.ceiling,
              confidence: s.confidence,
              dataQuality: s.dataQuality,
              marketOdds: oddsInfo.marketOdds,
              impliedProbability: oddsInfo.impliedProbability,
              marketLine: oddsInfo.marketLine,
              triggerStrength: s.triggerStrength,
              features: s.features,
            });
            const features = buildEdgeFeatures(s.features, edgeMetrics, oddsInfo);

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
              features: JSON.stringify(features),
              data_quality: s.dataQuality,
              recommended: edgeMetrics.recommended,
              rec_score: Math.round(edgeMetrics.recommendationScore * 100) / 100,
              verdict: edgeMetrics.recommended ? "recommended" : edgeMetrics.edge > 0 ? "marginal" : "avoid",
              verdict_note: `Score ${edgeMetrics.recommendationScore.toFixed(1)} · Model ${(edgeMetrics.modelProbability * 100).toFixed(1)}% vs market ${(edgeMetrics.impliedProbability * 100).toFixed(1)}% (${edgeMetrics.marketOdds > 0 ? "+" : ""}${edgeMetrics.marketOdds})`,
            };
            
            // Enrich with market-specific projection scores
            if (simulationData) {
              try {
                const offensiveContext = {
                  impliedRuns: baseCtx.teamImpliedTotal ?? 4.5,
                  obpAhead: baseCtx.onbaseRateAhead ?? 0.320,
                  obpBehind: baseCtx.onbaseRateBehind ?? 0.310,
                };
                // Calculate slate norms based on today's data (simplified)
                const slateNorms = {
                  minHR: 0, maxHR: 2.5,
                  minHits: 0, maxHits: 2.5,
                  minTB2: 0, maxTB2: 3,
                  minTB3: 0, maxTB3: 4,
                  minHRR: 0, maxHRR: 2.5,
                };
                
                const enriched = enrichPredictionWithProjections(
                  predRow,
                  simulationData,
                  baseCtx,
                  oppPitcherStats,
                  s.market,
                  offensiveContext,
                  slateNorms
                );
                predRow = enriched;
              } catch (err) {
                // Enrichment failed but base prediction still valid
                console.error("Projection enrichment error:", err);
              }
            }
            
            return predRow;
          }));

          predictionRows.push(...scoredPredictions);
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
          const oddsInfo = await fetchRealtimeOdds(g.game_pk, s.market, pname, {
            gameDate: g.game_date,
            homeTeamName: g.home_team_name,
            awayTeamName: g.away_team_name,
          }, { refreshOdds });
          const edgeMetrics = edgeBasedScoring({
            market: s.market,
            projection: s.projection,
            floor: s.floor,
            ceiling: s.ceiling,
            confidence: s.confidence,
            dataQuality: s.dataQuality,
            marketOdds: oddsInfo.marketOdds,
            impliedProbability: oddsInfo.impliedProbability,
            marketLine: oddsInfo.marketLine,
            triggerStrength: s.triggerStrength,
            features: s.features,
          });

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
            features: JSON.stringify(buildEdgeFeatures(s.features, edgeMetrics, oddsInfo)),
            data_quality: s.dataQuality,
            recommended: edgeMetrics.recommended,
            rec_score: Math.round(edgeMetrics.recommendationScore * 100) / 100,
            verdict: edgeMetrics.recommended ? "recommended" : edgeMetrics.edge > 0 ? "marginal" : "avoid",
            verdict_note: `Score ${edgeMetrics.recommendationScore.toFixed(1)} · Model ${(edgeMetrics.modelProbability * 100).toFixed(1)}% vs market ${(edgeMetrics.impliedProbability * 100).toFixed(1)}% (${edgeMetrics.marketOdds > 0 ? "+" : ""}${edgeMetrics.marketOdds})`,
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
