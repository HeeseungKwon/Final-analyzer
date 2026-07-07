/**
 * Player Projection Score System
 * 
 * Extends the analyzer with:
 * - Expected Projections (mean values for Hits, TB, HR, Runs, RBI, HRR)
 * - Confidence Score (0-100) based on sample sizes and data quality
 * - Market Edge calculation (Model Prob - Market Prob)
 * - Projection Score (0-100) combining prob, projection, edge, and confidence
 * - Player Rankings by market
 * 
 * Integrates with existing scoring engine without modifying core architecture.
 */

import { clamp } from "@/lib/utils/math";

// Confidence score weights (must sum to 1.0)
const CONFIDENCE_WEIGHTS = {
  seasonSampleSize: 0.18,
  recentSampleSize: 0.12,
  handednessSampleSize: 0.10,
  pitcherSampleSize: 0.08,
  lineupConfirmed: 0.08,
  parkFactor: 0.08,
  weatherConditions: 0.06,
  vegasImplied: 0.12,
  statcastQuality: 0.18,
};

/**
 * Calculate expected (mean) projection for a stat based on simulation results
 * @param {number[]} simArray - Array of values from Monte Carlo simulation
 * @returns {number} Mean value
 */
function calculateExpectedProjection(simArray) {
  if (!simArray || simArray.length === 0) return 0;
  const sum = simArray.reduce((a, b) => a + b, 0);
  return sum / simArray.length;
}

/**
 * Calculate sample size credibility factor (0-1)
 * Uses logistic curve: 1 / (1 + exp(-slope * (n - inflection)))
 */
function sampleSizeCredibility(n, inflectionPoint = 50, slope = 0.15) {
  const x = n - inflectionPoint;
  return 1 / (1 + Math.exp(-slope * x));
}

/**
 * Build confidence score from multiple factors
 * Returns 0-100
 */
export function calculateConfidenceScore(ctx, dataQuality, simulation) {
  let score = 50; // Base score
  
  // 1. Season sample size (max +15 points)
  const seasonPA = ctx.season?.pa ?? 0;
  const seasonCred = sampleSizeCredibility(seasonPA, 200, 0.1);
  score += seasonCred * 15 * CONFIDENCE_WEIGHTS.seasonSampleSize / 0.18;
  
  // 2. Recent sample size (max +10 points)
  const recentPA = ctx.recent?.pa ?? 0;
  const recentCred = sampleSizeCredibility(recentPA, 50, 0.12);
  score += recentCred * 10 * CONFIDENCE_WEIGHTS.recentSampleSize / 0.12;
  
  // 3. Handedness split (if available, max +8 points)
  const hasHandednessSplit = ctx.season?.vs_rhp || ctx.season?.vs_lhp;
  const handednessCred = hasHandednessSplit ? 0.8 : 0.3;
  score += handednessCred * 8 * CONFIDENCE_WEIGHTS.handednessSampleSize / 0.10;
  
  // 4. Pitcher sample size (max +6 points)
  const pitcherPA = ctx.oppPitcherStats?.bf ?? 0;
  const pitcherCred = sampleSizeCredibility(pitcherPA, 300, 0.08);
  score += pitcherCred * 6 * CONFIDENCE_WEIGHTS.pitcherSampleSize / 0.08;
  
  // 5. Lineup confirmed (max +6 points)
  const lineupConfirmed = ctx.battingOrder ? 1.0 : 0.4;
  score += lineupConfirmed * 6 * CONFIDENCE_WEIGHTS.lineupConfirmed / 0.08;
  
  // 6. Park factor (max +6 points) - neutral = 100, extreme = 80-120
  const parkFactorNormalized = Math.max(0, 1 - Math.abs(ctx.parkFactor - 100) / 100);
  score += parkFactorNormalized * 6 * CONFIDENCE_WEIGHTS.parkFactor / 0.08;
  
  // 7. Weather conditions (max +4 points) - we assume neutral if not specified
  const weatherScore = ctx.weatherAdjustment ? 0.8 : 0.5;
  score += weatherScore * 4 * CONFIDENCE_WEIGHTS.weatherConditions / 0.06;
  
  // 8. Vegas implied team total (max +9 points)
  const impliedTotal = ctx.teamImpliedTotal ?? 4.5;
  const vegasNormalized = Math.max(0, 1 - Math.abs(impliedTotal - 4.5) / 2.5);
  score += vegasNormalized * 9 * CONFIDENCE_WEIGHTS.vegasImplied / 0.12;
  
  // 9. Statcast quality metrics (max +14 points)
  // Higher barrel%, hard hit%, and consistent exit velo = higher confidence
  const barrelPct = ctx.statcastMetrics?.barrel_pct ?? 0.05;
  const hardHitPct = ctx.statcastMetrics?.hard_hit_pct ?? 0.35;
  const exitVeloConsistency = ctx.statcastMetrics?.exit_velo_consistency ?? 0.5;
  
  const statcastScore = (
    Math.min(barrelPct / 0.10, 1) * 0.4 +
    Math.min(hardHitPct / 0.50, 1) * 0.4 +
    exitVeloConsistency * 0.2
  );
  score += statcastScore * 14 * CONFIDENCE_WEIGHTS.statcastQuality / 0.18;
  
  // Data quality adjustment
  if (dataQuality === "missing") score *= 0.5;
  else if (dataQuality === "partial") score *= 0.8;
  
  return clamp(score, 0, 100);
}

/**
 * Calculate market edge: Model Probability - Market Implied Probability
 * Returns -1 to +1 (can be displayed as -100 to +100 in percentages)
 */
export function calculateMarketEdge(modelProb, marketProb) {
  if (marketProb == null) return 0;
  return clamp(modelProb - marketProb, -1, 1);
}

/**
 * Extract or calculate expected projections from simulation
 */
export function extractProjectedStats(simulation) {
  if (!simulation) {
    return {
      expectedHits: 0,
      expectedTotalBases: 0,
      expectedHomeRuns: 0,
      expectedRuns: 0,
      expectedRBI: 0,
      expectedHRR: 0,
    };
  }
  
  return {
    expectedHits: calculateExpectedProjection(simulation.hits),
    expectedTotalBases: calculateExpectedProjection(simulation.totalBases),
    expectedHomeRuns: calculateExpectedProjection(simulation.homeRuns),
    expectedRuns: calculateExpectedProjection(simulation.runs),
    expectedRBI: calculateExpectedProjection(simulation.rbi),
    expectedHRR: calculateExpectedProjection(simulation.hrr),
  };
}

/**
 * Calculate Projection Score (0-100) combining:
 * - Model Probability (40%)
 * - Expected Projection aligned with market (30%)
 * - Market Edge (20%)
 * - Confidence Score (10%)
 */
export function calculateProjectionScore(
  modelProb,
  expectedProjection,
  marketThreshold,
  marketEdge,
  confidenceScore,
  weights = { prob: 0.40, projection: 0.30, edge: 0.20, confidence: 0.10 }
) {
  // Normalize model probability to 0-100
  const probComponent = modelProb * 100;
  
  // Projection component: measure how far above/below threshold
  // If threshold is 2 hits, and expected is 2.5, that's +0.5 advantage
  const projectionDelta = expectedProjection - marketThreshold;
  const projectionComponent = 50 + Math.min(50, Math.max(-50, projectionDelta * 30));
  
  // Edge component: normalized to 0-100
  const edgeComponent = 50 + (marketEdge * 100);
  
  // Confidence component: already 0-100
  const confidenceComponent = confidenceScore;
  
  // Weighted combination
  const score = 
    probComponent * weights.prob +
    projectionComponent * weights.projection +
    edgeComponent * weights.edge +
    confidenceComponent * weights.confidence;
  
  return clamp(score, 0, 100);
}

/**
 * Build enriched prediction with projection data
 * Augments existing prediction row with new scoring fields
 */
export function enrichPredictionWithProjections(prediction, ctx, simulation, marketProbs, dataQuality) {
  const projectedStats = extractProjectedStats(simulation);
  const confidenceScore = calculateConfidenceScore(ctx, dataQuality, simulation);
  
  // Determine market threshold based on market type
  let marketThreshold = 2;
  if (prediction.market === "2+ Hits") marketThreshold = 2;
  else if (prediction.market === "2+ Total Bases") marketThreshold = 2;
  else if (prediction.market === "3+ Total Bases") marketThreshold = 3;
  else if (prediction.market === "1+ HR" || prediction.market === "home_run") marketThreshold = 1;
  else if (prediction.market === "2+ HRR" || prediction.market === "hrr_2") marketThreshold = 2;
  else if (prediction.market === "3+ HRR" || prediction.market === "hrr_3") marketThreshold = 3;
  
  // Get model probability
  const modelProb = marketProbs?.[prediction.market] ?? 0;
  
  // Calculate market edge (using prediction.projected_odds if available to derive market prob)
  const marketProb = prediction.implied_market_prob ?? null;
  const edge = calculateMarketEdge(modelProb, marketProb);
  
  // Calculate projection score
  const projectionScore = calculateProjectionScore(
    modelProb,
    prediction.market === "1+ HR" || prediction.market === "home_run"
      ? projectedStats.expectedHomeRuns
      : prediction.market === "2+ HRR" || prediction.market === "hrr_2"
        ? projectedStats.expectedHRR
        : prediction.market === "3+ HRR" || prediction.market === "hrr_3"
          ? projectedStats.expectedHRR
          : prediction.market === "2+ Hits"
            ? projectedStats.expectedHits
            : prediction.market === "2+ Total Bases"
              ? projectedStats.expectedTotalBases
              : prediction.market === "3+ Total Bases"
                ? projectedStats.expectedTotalBases
                : 0,
    marketThreshold,
    edge,
    confidenceScore
  );
  
  return {
    ...prediction,
    // Projected stats
    expected_hits: Math.round(projectedStats.expectedHits * 100) / 100,
    expected_total_bases: Math.round(projectedStats.expectedTotalBases * 100) / 100,
    expected_home_runs: Math.round(projectedStats.expectedHomeRuns * 100) / 100,
    expected_runs: Math.round(projectedStats.expectedRuns * 100) / 100,
    expected_rbi: Math.round(projectedStats.expectedRBI * 100) / 100,
    expected_hrr: Math.round(projectedStats.expectedHRR * 100) / 100,
    // Confidence and scoring
    confidence_score: Math.round(confidenceScore * 100) / 100,
    market_edge: Math.round(edge * 10000) / 10000,
    projection_score: Math.round(projectionScore * 100) / 100,
  };
}

/**
 * Rank players by market
 * Returns players sorted by projection_score descending
 */
export function rankPlayersByMarket(predictions, market) {
  return predictions
    .filter(p => p.market === market && p.projection_score != null)
    .sort((a, b) => (b.projection_score - a.projection_score))
    .map((p, index) => ({ ...p, rank: index + 1 }));
}

/**
 * Get rankings for all markets
 */
export function getAllMarketRankings(predictions) {
  const markets = [
    "2+ Hits",
    "2+ Total Bases",
    "3+ Total Bases",
    "1+ HR",
    "home_run",
    "2+ HRR",
    "3+ HRR",
    "hrr_2",
    "hrr_3",
  ];
  
  const rankings = {};
  for (const market of markets) {
    const ranked = rankPlayersByMarket(predictions, market);
    if (ranked.length > 0) {
      rankings[market] = ranked;
    }
  }
  
  return rankings;
}

/**
 * Summary statistics for a set of predictions
 */
export function getProjectionSummary(predictions, market) {
  const marketPreds = predictions.filter(p => p.market === market);
  if (marketPreds.length === 0) return null;
  
  const scores = marketPreds.map(p => p.projection_score ?? 0);
  const edges = marketPreds.map(p => p.market_edge ?? 0);
  
  return {
    market,
    count: marketPreds.length,
    topScore: Math.max(...scores),
    avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    avgEdge: edges.reduce((a, b) => a + b, 0) / edges.length,
    positiveedgeCount: edges.filter(e => e > 0).length,
  };
}
