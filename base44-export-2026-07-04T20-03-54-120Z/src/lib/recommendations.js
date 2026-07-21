/**
 * Market-Specific Recommendations Engine
 * 
 * Implements z-score based normalization to fairly rank picks across different betting markets.
 * 
 * Algorithm:
 * 1. Group predictions by market
 * 2. Calculate mean and standard deviation for each market
 * 3. Compute z-score for each pick within its market
 * 4. Rank picks within each market by confidence
 * 5. For overall ranking, average z-scores across markets
 * 
 * Benefits:
 * - Preserves distribution shape (important for calibration)
 * - Accounts for market volatility
 * - Statistically robust with small samples
 * - Fair cross-market comparison
 * - Modular: easy to add new markets
 */

/**
 * Group predictions by market key
 * @param {Array} predictions - Array of prediction objects
 * @returns {Object} Map of market key to array of predictions
 */
export function groupPredictionsByMarket(predictions) {
  const grouped = {};
  
  for (const pred of predictions) {
    const market = pred.market || 'unknown';
    if (!grouped[market]) {
      grouped[market] = [];
    }
    grouped[market].push(pred);
  }
  
  return grouped;
}

function normalizePlayerName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function getPlayerIdentity(prediction) {
  const playerId = Number(prediction?.player_id ?? prediction?.playerId);
  if (Number.isFinite(playerId) && playerId > 0) {
    return `id:${playerId}`;
  }
  const normalizedName = normalizePlayerName(prediction?.player_name ?? prediction?.playerName);
  return normalizedName ? `name:${normalizedName}` : "unknown-player";
}

function comparePredictionRank(a, b) {
  const scoreA = Number(a?.projection_score ?? a?.confidence ?? 0);
  const scoreB = Number(b?.projection_score ?? b?.confidence ?? 0);
  if (scoreA !== scoreB) return scoreA - scoreB;

  const projA = Number(a?.projection ?? 0);
  const projB = Number(b?.projection ?? 0);
  if (projA !== projB) return projA - projB;

  const edgeA = Number(a?.market_edge ?? 0);
  const edgeB = Number(b?.market_edge ?? 0);
  return edgeA - edgeB;
}

export function dedupePredictionsByMarketPlayer(predictions) {
  const bestByPlayerMarket = new Map();

  for (const prediction of predictions ?? []) {
    const market = prediction?.market || "unknown";
    const identity = getPlayerIdentity(prediction);
    const key = `${market}::${identity}`;
    const existing = bestByPlayerMarket.get(key);
    if (!existing || comparePredictionRank(prediction, existing) > 0) {
      bestByPlayerMarket.set(key, prediction);
    }
  }

  return Array.from(bestByPlayerMarket.values());
}

/**
 * Calculate mean and standard deviation for a set of confidence scores
 * @param {Array} confidences - Array of confidence values (0-100)
 * @returns {Object} {mean, stddev, count}
 */
export function calculateMarketStats(confidences) {
  if (!confidences || confidences.length === 0) {
    return { mean: 0, stddev: 0, count: 0 };
  }
  
  const count = confidences.length;
  const mean = confidences.reduce((a, b) => a + b, 0) / count;
  
  if (count === 1) {
    return { mean, stddev: 0, count };
  }
  
  const variance = confidences.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / count;
  const stddev = Math.sqrt(variance);
  
  return { mean, stddev, count };
}

/**
 * Calculate z-score for a single confidence value
 * Uses a minimum stddev of 0.1 to avoid division by zero issues
 * @param {number} confidence - Confidence value (0-100)
 * @param {number} mean - Market mean
 * @param {number} stddev - Market standard deviation
 * @returns {number} Z-score
 */
export function calculateZScore(confidence, mean, stddev) {
  const minStddev = 0.1; // Prevent division issues with very tight distributions
  const adjustedStddev = Math.max(stddev, minStddev);
  return (confidence - mean) / adjustedStddev;
}

/**
 * Normalize predictions by adding z-scores for each market
 * @param {Array} predictions - Array of prediction objects
 * @returns {Array} Predictions with added z_score field
 */
export function normalizePicksByMarket(predictions) {
  const deduped = dedupePredictionsByMarketPlayer(predictions);
  const grouped = groupPredictionsByMarket(deduped);
  const statsPerMarket = {};
  
  // Calculate stats for each market
  for (const [market, picks] of Object.entries(grouped)) {
    const confidences = picks.map(p => Number(p.confidence) || 0);
    statsPerMarket[market] = calculateMarketStats(confidences);
  }
  
  // Add z-score to each prediction
  const normalized = deduped.map(pred => {
    const market = pred.market || 'unknown';
    const stats = statsPerMarket[market] || { mean: 0, stddev: 0 };
    const zScore = calculateZScore(Number(pred.confidence) || 0, stats.mean, stats.stddev);
    
    return {
      ...pred,
      z_score: zScore,
      market_stats: stats, // Include for debugging/inspection
    };
  });
  
  return normalized;
}

/**
 * Rank picks within a single market by confidence (descending)
 * @param {Array} picks - Predictions from same market
 * @returns {Array} Sorted picks
 */
export function rankPicksWithinMarket(picks) {
  return [...picks].sort((a, b) => {
    const confA = Number(a.confidence) || 0;
    const confB = Number(b.confidence) || 0;
    return confB - confA; // Descending
  });
}

/**
 * Rank picks overall by average z-score across all markets
 * Only include picks that have z-score data
 * @param {Array} predictions - Array of normalized predictions with z_score
 * @returns {Array} Top picks sorted by average z-score
 */
export function rankPicksOverall(predictions) {
  // Filter out predictions without z-scores or invalid data
  const validPreds = predictions.filter(p => Number.isFinite(p.z_score));
  
  if (validPreds.length === 0) {
    return [];
  }
  
  // Sort by z-score descending
  return [...validPreds].sort((a, b) => {
    const zScoreA = Number(a.z_score) || 0;
    const zScoreB = Number(b.z_score) || 0;
    return zScoreB - zScoreA;
  });
}

/**
 * Generate complete recommendations object with market-specific and overall rankings
 * 
 * @param {Array} predictions - All predictions from a date
 * @param {Object} options - Configuration options
 * @param {string[]} options.marketsToInclude - Markets to display (if null, use all)
 * @param {number} options.topN - Number of top picks per market to return (default: 10)
 * @returns {Object} {overallBestPicks, marketSpecificRankings}
 */
export function generateRecommendations(predictions, options = {}) {
  const { marketsToInclude = null, topN = 10 } = options;
  
  // Normalize all predictions with z-scores
  const normalized = normalizePicksByMarket(predictions);
  
  // Get market-specific rankings
  const grouped = groupPredictionsByMarket(normalized);
  const marketSpecificRankings = {};
  
  for (const [market, picks] of Object.entries(grouped)) {
    // Skip markets not in include list (if specified)
    if (marketsToInclude && !marketsToInclude.includes(market)) {
      continue;
    }
    
    const ranked = rankPicksWithinMarket(picks);
    marketSpecificRankings[market] = ranked.slice(0, topN);
  }

  // Ensure each market can surface at least one top opportunity in overall picks.
  const marketLeaders = Object.values(marketSpecificRankings)
    .map((ranked) => ranked[0])
    .filter(Boolean);
  const selected = new Set(marketLeaders);
  const remaining = normalized.filter((pick) => !selected.has(pick));
  const overallBestPicks = [
    ...rankPicksOverall(marketLeaders),
    ...rankPicksOverall(remaining),
  ].slice(0, topN);
  
  return {
    overallBestPicks,
    marketSpecificRankings,
    allNormalized: normalized, // Include for parlay building, filtering, etc.
  };
}

/**
 * Filter and organize predictions for recommendation display
 * Includes: recommended picks (confidence >= 60), minimum projection threshold
 * 
 * @param {Array} predictions - All predictions
 * @param {Object} options - Filter options
 * @param {number} options.minConfidence - Minimum confidence to include (default: 60)
 * @param {number} options.minProjection - Minimum projection value (default: 0.60)
 * @returns {Array} Filtered predictions
 */
export function filterRecommendedPicks(predictions, options = {}) {
  const { minConfidence = 60, minProjection = 0.60 } = options;

  return dedupePredictionsByMarketPlayer(predictions).filter(p => {
    const conf = Number(p.confidence) || 0;
    const proj = Number(p.projection) || 0;
    return conf >= minConfidence && proj >= minProjection;
  });
}

/**
 * Get top picks by market for a specific game or set of games
 * Useful for parlay building
 * 
 * @param {Array} predictions - Predictions filtered to relevant scope
 * @param {Object} options - Options
 * @param {string[]} options.marketPriority - Markets to prioritize in order
 * @param {number} options.topNPerMarket - Top N picks per market (default: 5)
 * @returns {Object} {market1: [...picks], market2: [...picks], ...}
 */
export function getTopPicksByMarket(predictions, options = {}) {
  const { marketPriority = [], topNPerMarket = 5 } = options;
  
  const normalized = normalizePicksByMarket(predictions);
  const grouped = groupPredictionsByMarket(normalized);
  const result = {};
  
  // Prioritize markets if list provided
  const marketOrder = marketPriority.length > 0 ? marketPriority : Object.keys(grouped).sort();
  
  for (const market of marketOrder) {
    if (grouped[market]) {
      const ranked = rankPicksWithinMarket(grouped[market]);
      result[market] = ranked.slice(0, topNPerMarket);
    }
  }
  
  return result;
}

/**
 * Add z-scores to predictions in-place without modifying array structure
 * Useful for updating existing prediction arrays with market-normalized rankings
 * 
 * @param {Array} predictions - Predictions to augment
 * @returns {Array} Same array with z_score added to each prediction
 */
export function augmentPredictionsWithZScores(predictions) {
  const normalized = normalizePicksByMarket(predictions);
  
  // Copy z-scores and market_stats back to original predictions
  for (let i = 0; i < predictions.length; i++) {
    const normalized_pred = normalized[i];
    predictions[i].z_score = normalized_pred.z_score;
    predictions[i].market_stats = normalized_pred.market_stats;
  }
  
  return predictions;
}

/**
 * Compute pick statistics for a market
 * Useful for displaying market context
 * 
 * @param {Array} picks - Predictions from one market
 * @returns {Object} Statistics
 */
export function getMarketStatistics(picks) {
  if (!picks || picks.length === 0) {
    return {
      count: 0,
      meanConfidence: 0,
      medianConfidence: 0,
      minConfidence: 0,
      maxConfidence: 0,
      stddevConfidence: 0,
    };
  }
  
  const confidences = picks.map(p => Number(p.confidence) || 0);
  const sorted = [...confidences].sort((a, b) => a - b);
  const count = confidences.length;
  const mean = confidences.reduce((a, b) => a + b, 0) / count;
  const median = count % 2 === 0
    ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
    : sorted[Math.floor(count / 2)];
  
  const variance = confidences.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / count;
  const stddev = Math.sqrt(variance);
  
  return {
    count,
    meanConfidence: Math.round(mean * 100) / 100,
    medianConfidence: Math.round(median * 100) / 100,
    minConfidence: Math.min(...confidences),
    maxConfidence: Math.max(...confidences),
    stddevConfidence: Math.round(stddev * 100) / 100,
  };
}
