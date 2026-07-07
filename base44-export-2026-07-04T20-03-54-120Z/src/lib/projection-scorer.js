/**
 * Market-Specific Projection Score System
 * 
 * Generates market-tailored projection scores with:
 * - Market-specific weighting formulas (HR, Hits, TB, HRR)
 * - Detailed confidence scoring (25% season, 10% recent, 10% split, etc.)
 * - Edge normalization (+10%→100, +5%→75, 0%→50, negative scales down)
 * - Market-specific statcast/contact/power metrics
 * - Pool normalization (best→100, worst→0 per market/date)
 * - Star rating system (⭐ to ⭐⭐⭐⭐⭐)
 * 
 * Reuses existing analyzer outputs; no duplicate calculations.
 */

import { clamp } from "@/lib/utils/math";

// Confidence score component weights (must sum to 1.0)
const CONFIDENCE_WEIGHTS = {
  seasonSampleSize: 0.25,
  recentSampleSize: 0.10,
  splitSampleSize: 0.10,
  pitcherSampleQuality: 0.10,
  statcastQuality: 0.20,
  confirmedLineup: 0.10,
  weatherParkCertainty: 0.05,
  vegasImpliedTotal: 0.05,
  bullpenCertainty: 0.05,
};

// Market-specific projection score weights
const MARKET_WEIGHTS = {
  "1+ HR": {
    modelProb: 0.35,
    expectedValue: 0.30,
    marketMetrics: 0.20, // Statcast power metrics
    confidence: 0.10,
    edge: 0.05,
  },
  "home_run": {
    modelProb: 0.35,
    expectedValue: 0.30,
    marketMetrics: 0.20,
    confidence: 0.10,
    edge: 0.05,
  },
  "2+ Hits": {
    modelProb: 0.35,
    expectedValue: 0.30,
    marketMetrics: 0.20, // Contact profile
    confidence: 0.10,
    edge: 0.05,
  },
  "2+ Total Bases": {
    modelProb: 0.35,
    expectedValue: 0.30,
    marketMetrics: 0.20, // Power profile
    confidence: 0.10,
    edge: 0.05,
  },
  "3+ Total Bases": {
    modelProb: 0.35,
    expectedValue: 0.30,
    marketMetrics: 0.20, // Power profile
    confidence: 0.10,
    edge: 0.05,
  },
  "hrr_2": {
    modelProb: 0.30,
    expectedValue: 0.30,
    marketMetrics: 0.25, // Run production context
    confidence: 0.10,
    edge: 0.05,
  },
  "2+ HRR": {
    modelProb: 0.30,
    expectedValue: 0.30,
    marketMetrics: 0.25, // Run production context
    confidence: 0.10,
    edge: 0.05,
  },
  "3+ HRR": {
    modelProb: 0.30,
    expectedValue: 0.30,
    marketMetrics: 0.25, // Run production context
    confidence: 0.10,
    edge: 0.05,
  },
  "hrr_3": {
    modelProb: 0.30,
    expectedValue: 0.30,
    marketMetrics: 0.25, // Run production context
    confidence: 0.10,
    edge: 0.05,
  },
};

/**
 * Sample size credibility using logistic curve
 * Returns 0-1 where 1 = maximum credibility
 */
function sampleSizeCredibility(n, inflectionPoint = 50, slope = 0.15) {
  if (n <= 0) return 0;
  const x = n - inflectionPoint;
  return 1 / (1 + Math.exp(-slope * x));
}

/**
 * Calculate confidence score (0-100)
 * Considers 9 components: season PA, recent PA, split quality, pitcher sample,
 * statcast metrics, lineup confirmation, weather/park, Vegas total, bullpen
 */
export function calculateConfidenceScore(ctx, dataQuality, oppPitcherStats) {
  let score = 0;

  // 1. Season sample size (25%) - inflection at 200 PA
  const seasonPA = ctx.season?.pa ?? 0;
  const seasonCred = sampleSizeCredibility(seasonPA, 200, 0.1);
  score += seasonCred * 100 * CONFIDENCE_WEIGHTS.seasonSampleSize;

  // 2. Recent sample size (10%) - inflection at 50 PA
  const recentPA = ctx.recent?.pa ?? 0;
  const recentCred = sampleSizeCredibility(recentPA, 50, 0.12);
  score += recentCred * 100 * CONFIDENCE_WEIGHTS.recentSampleSize;

  // 3. Split sample size (10%) - do we have good vs handedness splits?
  const hasGoodSplits = (ctx.season?.vs_rhp?.pa ?? 0) >= 30 && (ctx.season?.vs_lhp?.pa ?? 0) >= 30;
  const splitCred = hasGoodSplits ? 0.95 : (ctx.season?.pa ?? 0) > 100 ? 0.6 : 0.3;
  score += splitCred * 100 * CONFIDENCE_WEIGHTS.splitSampleSize;

  // 4. Pitcher sample quality (10%) - inflection at 300 BF
  const pitcherBF = oppPitcherStats?.bf ?? 0;
  const pitcherCred = sampleSizeCredibility(pitcherBF, 300, 0.08);
  score += pitcherCred * 100 * CONFIDENCE_WEIGHTS.pitcherSampleQuality;

  // 5. Statcast quality (20%) - barrel%, hard hit%, exit velo consistency
  const barrelPct = ctx.statcastMetrics?.barrel_pct ?? 0.05;
  const hardHitPct = ctx.statcastMetrics?.hard_hit_pct ?? 0.35;
  const babip = ctx.season?.babip ?? 0.3;
  const statcastScore = (
    Math.min(barrelPct / 0.12, 1) * 0.35 +
    Math.min(hardHitPct / 0.50, 1) * 0.35 +
    Math.min(Math.abs(babip - 0.3) / 0.05, 1) * 0.30
  ) * 100;
  score += statcastScore * CONFIDENCE_WEIGHTS.statcastQuality;

  // 6. Confirmed lineup (10%)
  const lineupConfirmed = ctx.battingOrder ? 1.0 : 0.5;
  score += lineupConfirmed * 100 * CONFIDENCE_WEIGHTS.confirmedLineup;

  // 7. Weather & park certainty (5%)
  const weatherAdjustment = Math.abs(ctx.weatherAdjustment ?? 0);
  const weatherCertainty = 1 - Math.min(weatherAdjustment / 0.15, 1); // More extreme weather = less certainty
  const parkFactor = ctx.parkFactor ?? 100;
  const parkCertainty = 1 - Math.abs(parkFactor - 100) / 200; // Extreme parks = less certainty
  const weatherParkScore = ((weatherCertainty + parkCertainty) / 2) * 100;
  score += weatherParkScore * CONFIDENCE_WEIGHTS.weatherParkCertainty;

  // 8. Vegas implied total (5%) - extremes indicate less certainty
  const vegasImplied = ctx.teamImpliedTotal ?? 4.5;
  const vegasCertainty = 1 - Math.min(Math.abs(vegasImplied - 4.5) / 2, 1);
  score += vegasCertainty * 100 * CONFIDENCE_WEIGHTS.vegasImpliedTotal;

  // 9. Bullpen certainty (5%) - quality of team's bullpen matters for HR/RBI projections
  const oppBullpenERA = ctx.oppBullpenStats?.era ?? 4.0;
  const bullpenCertainty = 1 - Math.min(Math.abs(oppBullpenERA - 3.5) / 2, 1);
  score += bullpenCertainty * 100 * CONFIDENCE_WEIGHTS.bullpenCertainty;

  // Apply data quality multiplier
  const qualityMultipliers = {
    missing: 0.5,
    partial: 0.8,
    ok: 1.0,
  };
  const multiplier = qualityMultipliers[dataQuality] ?? 1.0;
  score *= multiplier;

  return clamp(score, 0, 100);
}

/**
 * Normalize edge to 0-100 score
 * +10% → 100, +5% → 75, 0% → 50, -5% → 25, etc.
 * Linear: edge_decimal / 0.1 * 50 + 50
 */
export function calculateEdgeScore(edgeDecimal) {
  if (edgeDecimal === null || edgeDecimal === undefined) {
    return 50; // Neutral if no edge data
  }
  // Linear scale
  return clamp(50 + (edgeDecimal / 0.1) * 50, 0, 100);
}

/**
 * Normalize a score component relative to today's slate
 * slateMin/slateMax: min/max values in today's player pool
 */
export function normalizeToSlate(value, slateMin, slateMax) {
  if (slateMax === slateMin) return 50; // If all same, neutral
  return clamp(((value - slateMin) / (slateMax - slateMin)) * 100, 0, 100);
}

/**
 * Extract mean (expected) values from Monte Carlo simulation
 */
export function extractProjectedStats(simulationData) {
  const mean = (arr) => {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  return {
    expectedHits: mean(simulationData?.hits ?? []),
    expectedTotalBases: mean(simulationData?.totalBases ?? []),
    expectedHomeRuns: mean(simulationData?.homeRuns ?? []),
    expectedRuns: mean(simulationData?.runs ?? []),
    expectedRBI: mean(simulationData?.rbi ?? []),
    expectedHRR: mean(simulationData?.hrr ?? []),
  };
}

/**
 * Calculate statcast power metrics score (for HR markets)
 * Returns 0-100
 */
function calculatePowerMetricsScore(ctx) {
  const barrelPct = ctx.statcastMetrics?.barrel_pct ?? 0.05;
  const hardHitPct = ctx.statcastMetrics?.hard_hit_pct ?? 0.35;
  const exitVelo = ctx.statcastMetrics?.avg_exit_velo ?? 85;
  const fbRate = ctx.statcastMetrics?.fly_ball_rate ?? 0.35;
  const hrfb = ctx.statcastMetrics?.hr_fb_rate ?? 0.10;

  const barrelScore = Math.min(barrelPct / 0.12, 1) * 20;
  const hardHitScore = Math.min(hardHitPct / 0.50, 1) * 20;
  const exitVeloScore = Math.min(exitVelo / 92, 1) * 20;
  const fbRateScore = Math.min(fbRate / 0.45, 1) * 20;
  const hrfbScore = Math.min(hrfb / 0.15, 1) * 20;

  return barrelScore + hardHitScore + exitVeloScore + fbRateScore + hrfbScore;
}

/**
 * Calculate contact profile score (for Hits markets)
 * Returns 0-100
 */
function calculateContactProfileScore(ctx) {
  const strikeoutRate = ctx.season?.strikeout_rate ?? 0.20;
  const contactRate = ctx.season?.contact_rate ?? 0.80;
  const battingAvg = ctx.season?.batting_avg ?? 0.250;
  const xBA = ctx.season?.xba ?? 0.300;
  const babip = ctx.season?.babip ?? 0.300;
  const expectedPA = ctx.expectedPA ?? 3.5;

  const kScore = Math.min((1 - strikeoutRate) / 0.80, 1) * 20;
  const contactScore = Math.min(contactRate / 1.0, 1) * 20;
  const avgScore = Math.min(battingAvg / 0.300, 1) * 20;
  const xbaScore = Math.min(xBA / 0.330, 1) * 20;
  const paScore = Math.min(expectedPA / 4.5, 1) * 20;

  return kScore + contactScore + avgScore + xbaScore + paScore;
}

/**
 * Calculate power profile score (for TB markets)
 * Returns 0-100
 */
function calculatePowerProfileScore(ctx) {
  const iso = ctx.season?.iso ?? 0.150;
  const xslg = ctx.season?.xslug ?? 0.370;
  const barrelPct = ctx.statcastMetrics?.barrel_pct ?? 0.05;
  const hardHitPct = ctx.statcastMetrics?.hard_hit_pct ?? 0.35;
  const linedriveRate = ctx.statcastMetrics?.line_drive_rate ?? 0.20;

  const isoScore = Math.min(iso / 0.200, 1) * 20;
  const xslgScore = Math.min(xslg / 0.450, 1) * 20;
  const barrelScore = Math.min(barrelPct / 0.12, 1) * 20;
  const hardHitScore = Math.min(hardHitPct / 0.50, 1) * 20;
  const ldScore = Math.min(linedriveRate / 0.30, 1) * 20;

  return isoScore + xslgScore + barrelScore + hardHitScore + ldScore;
}

/**
 * Calculate run production context score (for HRR markets)
 * Returns 0-100
 */
function calculateRunProductionContextScore(ctx, team) {
  const expectedPA = ctx.expectedPA ?? 3.5;
  const battingOrder = ctx.battingOrder ?? 8;
  const teamImpliedRuns = team?.impliedRuns ?? 4.5;
  const obpAhead = team?.obpAhead ?? 0.320;
  const obpBehind = team?.obpBehind ?? 0.310;

  // Lineups better for run production
  const orderScore = (1 - Math.min(battingOrder / 9, 1)) * 25;
  const paScore = Math.min(expectedPA / 4.5, 1) * 25;
  const runsScore = Math.min(teamImpliedRuns / 5.5, 1) * 25;
  const obpScore = ((obpAhead + obpBehind) / 2 / 0.340) * 25;

  return orderScore + paScore + runsScore + obpScore;
}

/**
 * Calculate market-specific projection score (0-100)
 */
export function calculateMarketProjectionScore(
  prediction,
  simulationData,
  ctx,
  oppPitcherStats,
  market,
  oppTeamStats,
  slateNorms
) {
  const weights = MARKET_WEIGHTS[market] || MARKET_WEIGHTS["2+ Hits"];

  // Get base metrics
  const modelProbScore = clamp(Number(prediction.projection ?? 0.5) * 100, 0, 100);
  const projectedStats = extractProjectedStats(simulationData);

  // Normalize expected value to slate
  let expectedValueScore = 50;
  if (market.includes("HR") || market === "home_run" || market === "1+ HR") {
    expectedValueScore = normalizeToSlate(
      projectedStats.expectedHomeRuns,
      slateNorms?.minHR ?? 0,
      slateNorms?.maxHR ?? 2.5
    );
  } else if (market.includes("3+ Total")) {
    expectedValueScore = normalizeToSlate(
      projectedStats.expectedTotalBases,
      slateNorms?.minTB3 ?? 0,
      slateNorms?.maxTB3 ?? 4
    );
  } else if (market.includes("2+ Total")) {
    expectedValueScore = normalizeToSlate(
      projectedStats.expectedTotalBases,
      slateNorms?.minTB2 ?? 0,
      slateNorms?.maxTB2 ?? 3
    );
  } else if (market.includes("HRR") || market.includes("hrr")) {
    expectedValueScore = normalizeToSlate(
      projectedStats.expectedHRR,
      slateNorms?.minHRR ?? 0,
      slateNorms?.maxHRR ?? 2.5
    );
  } else {
    // Hits markets
    expectedValueScore = normalizeToSlate(
      projectedStats.expectedHits,
      slateNorms?.minHits ?? 0,
      slateNorms?.maxHits ?? 2.5
    );
  }

  // Calculate market-specific metrics
  let metricsScore = 50;
  if (market.includes("HR") || market === "home_run" || market === "1+ HR") {
    metricsScore = calculatePowerMetricsScore(ctx);
  } else if (market.includes("HRR") || market.includes("hrr")) {
    metricsScore = calculateRunProductionContextScore(ctx, oppTeamStats);
  } else if (market.includes("Total")) {
    metricsScore = calculatePowerProfileScore(ctx);
  } else {
    // Hits markets
    metricsScore = calculateContactProfileScore(ctx);
  }

  // Get confidence and edge scores
  const confidenceScore = calculateConfidenceScore(ctx, prediction.data_quality, oppPitcherStats);
  const edgeScore = calculateEdgeScore(prediction.market_edge);

  // Weighted synthesis
  const projectionScore =
    modelProbScore * weights.modelProb +
    expectedValueScore * weights.expectedValue +
    metricsScore * weights.marketMetrics +
    confidenceScore * weights.confidence +
    edgeScore * weights.edge;

  return clamp(projectionScore, 0, 100);
}

/**
 * Generate star rating from projection score
 * 95-100 → ⭐⭐⭐⭐⭐ Elite
 * 90-94 → ⭐⭐⭐⭐⭐ Strong
 * 85-89 → ⭐⭐⭐⭐ Excellent
 * 80-84 → ⭐⭐⭐⭐ Good
 * 75-79 → ⭐⭐⭐ Value
 * 70-74 → ⭐⭐⭐ Lean
 * <70 → Pass
 */
export function getPlayerRating(projectionScore) {
  if (projectionScore >= 95) return { stars: 5, label: "Elite Play" };
  if (projectionScore >= 90) return { stars: 5, label: "Strong Play" };
  if (projectionScore >= 85) return { stars: 4, label: "Excellent" };
  if (projectionScore >= 80) return { stars: 4, label: "Good" };
  if (projectionScore >= 75) return { stars: 3, label: "Value Play" };
  if (projectionScore >= 70) return { stars: 3, label: "Lean" };
  return { stars: 0, label: "Pass" };
}

/**
 * Rank players by market with projection scores
 */
export function rankPlayersByMarket(predictions, market) {
  const filtered = predictions.filter(
    (p) =>
      p.market === market &&
      p.projection_score != null &&
      p.expected_hits != null
  );

  const ranked = filtered
    .sort((a, b) => (b.projection_score ?? 0) - (a.projection_score ?? 0))
    .map((p, idx) => ({
      ...p,
      rank: idx + 1,
      rating: getPlayerRating(p.projection_score),
    }));

  return ranked;
}

/**
 * Get all market rankings
 */
export function getAllMarketRankings(predictions) {
  const markets = [
    "1+ HR",
    "2+ Hits",
    "2+ Total Bases",
    "3+ Total Bases",
    "hrr_2",
    "2+ HRR",
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
 * Get summary stats for a market
 */
export function getProjectionSummary(predictions, market) {
  const filtered = predictions.filter(
    (p) => p.market === market && p.projection_score != null
  );

  if (filtered.length === 0) return null;

  const scores = filtered.map((p) => p.projection_score);
  const edges = filtered.map((p) => p.market_edge ?? 0);

  const topScore = Math.max(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const avgEdge = edges.reduce((a, b) => a + b, 0) / edges.length;
  const positiveedgeCount = edges.filter((e) => e > 0).length;

  return {
    market,
    count: filtered.length,
    topScore,
    avgScore,
    avgEdge,
    positiveedgeCount,
  };
}

/**
 * Enrich prediction with all projection metrics
 * Returns prediction with added fields for display/export
 */
export function enrichPredictionWithProjections(
  prediction,
  simulationData,
  ctx,
  oppPitcherStats,
  market,
  oppTeamStats,
  slateNorms
) {
  try {
    const projectedStats = extractProjectedStats(simulationData);
    const confidence = calculateConfidenceScore(ctx, prediction.data_quality, oppPitcherStats);
    const projectionScore = calculateMarketProjectionScore(
      prediction,
      simulationData,
      ctx,
      oppPitcherStats,
      market,
      oppTeamStats,
      slateNorms
    );
    const rating = getPlayerRating(projectionScore);

    return {
      ...prediction,
      expected_hits: projectedStats.expectedHits,
      expected_total_bases: projectedStats.expectedTotalBases,
      expected_home_runs: projectedStats.expectedHomeRuns,
      expected_runs: projectedStats.expectedRuns,
      expected_rbi: projectedStats.expectedRBI,
      expected_hrr: projectedStats.expectedHRR,
      confidence_score: confidence,
      projection_score: projectionScore,
      player_rating: rating.label,
      player_stars: rating.stars,
    };
  } catch (err) {
    console.error("Error enriching prediction with projections:", err);
    return prediction; // Return base prediction if enrichment fails
  }
}
