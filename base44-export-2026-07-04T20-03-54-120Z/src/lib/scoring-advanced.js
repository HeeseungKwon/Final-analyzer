/**
 * Advanced Scoring Enhancements
 * 
 * Extends the core scoring module with multi-source analysis:
 * - Vegas probability integration for HR picks
 * - Ballpark factor comparison
 * - Multi-source evidence scoring for recommendation logic
 * - "Middling" pick detection when model beats both baselines
 */

import { blend, clamp, toConfidence } from './utils/math';

/**
 * Computes HR recommendation verdict based on multiple probability sources
 * 
 * Core Logic:
 * - STRONG: Model probability significantly exceeds BOTH ballpark AND Vegas baselines
 * - MIDDLING: Model sits between the two baseline estimates (hidden gem signal)
 * - FADE: Model is lower than the higher of the two baselines
 * 
 * This addresses the user's requirement: recommend picks when player HR probability
 * is higher than both ballpark probability AND Vegas probability.
 * 
 * @param {number} modelProb - Our model's HR probability [0, 1]
 * @param {number} parkProb - Park-neutral baseline probability [0, 1]
 * @param {number} vegasProb - Vegas odds implied probability [0, 1] or null
 * @param {number} threshold - Minimum difference to trigger verdict (default 0.005)
 * @returns {Object} { verdict, verdictNote, beatsBothBaselines, sourceComparison }
 * 
 * @example
 * computeHRVerdict(0.15, 0.10, 0.12)
 * // { verdict: 'strong', beatsBothBaselines: true, ... }
 * 
 * computeHRVerdict(0.12, 0.10, 0.15)
 * // { verdict: 'middling', beatsBothBaselines: false, ... }
 */
export function computeHRVerdict(modelProb, parkProb, vegasProb, threshold = 0.005) {
  if (vegasProb != null) {
    const hi = Math.max(parkProb, vegasProb);
    const lo = Math.min(parkProb, vegasProb);
    
    const beatsBoth = modelProb > hi + threshold;
    const middling = modelProb > lo - threshold && modelProb <= hi + threshold;
    
    let verdict = 'fade';
    if (beatsBoth) verdict = 'strong';
    else if (middling) verdict = 'middling';
    
    return {
      verdict,
      beatsBothBaselines: beatsBoth,
      isMiddling: middling,
      sourceComparison: {
        model: (modelProb * 100).toFixed(1),
        parkBaseline: (parkProb * 100).toFixed(1),
        vegas: (vegasProb * 100).toFixed(1),
      },
      verdictNote: `Model ${(modelProb * 100).toFixed(1)}% vs Park ${(parkProb * 100).toFixed(1)}% vs Vegas ${(vegasProb * 100).toFixed(1)}%. ` +
                   (beatsBoth ? 'Beats both baselines (STRONG).' :
                    middling ? 'Between park and Vegas (MIDDLING — potential edge).' :
                    'Below higher baseline (FADE).'),
    };
  } else {
    const beatsPark = modelProb > parkProb + threshold;
    const middling = modelProb > parkProb - threshold && modelProb <= parkProb + threshold;
    
    let verdict = 'fade';
    if (beatsPark) verdict = 'strong';
    else if (middling) verdict = 'middling';
    
    return {
      verdict,
      beatsBothBaselines: beatsPark,
      isMiddling: middling,
      sourceComparison: {
        model: (modelProb * 100).toFixed(1),
        parkBaseline: (parkProb * 100).toFixed(1),
        vegas: null,
      },
      verdictNote: `Model ${(modelProb * 100).toFixed(1)}% vs Park-neutral baseline ${(parkProb * 100).toFixed(1)}% ` +
                   `(no Vegas data). ${beatsPark ? 'Beats baseline (STRONG).' : middling ? 'Close to baseline (MIDDLING).' : 'Below baseline (FADE).'}`,
    };
  }
}

/**
 * Computes multi-source evidence score for recommendations
 * 
 * Integrates multiple data sources to produce a more robust recommendation score:
 * - Model confidence (45% weight for HR, 40% for other markets)
 * - Matchup strength via trigger evaluation (20-30% weight)
 * - Baseline comparison (10-20% weight for HR)
 * - Floor/ceiling spread indicating model certainty (5-10% weight)
 * - Lineup slot adjustment for HR (multiplicative factor)
 * 
 * Unlike pure confidence-based recommendations, this holistic approach accounts for:
 * 1. Matchup favorability (weak opponent pitcher vs strong hitter)
 * 2. Model uncertainty (wider floor/ceiling = less confident)
 * 3. Recency form (hot streak vs cold)
 * 4. Baseline agreement (does Vegas/park support our view?)
 * 
 * @param {Object} prediction - Full prediction object with market, confidence, features, etc.
 * @param {string} market - Market type ('home_run', 'hit_1', etc.)
 * @param {number} confidence - Model confidence [0, 100]
 * @param {number} floor - 10th percentile projection
 * @param {number} ceiling - 90th percentile projection
 * @param {number} triggerStrength - Matchup signal [-1, 1]; 0 = neutral
 * @param {Object} features - Context including verdict, parkFactor, liftVsPark, etc.
 * @param {number} battingOrder - Hitter's batting order (1-9)
 * @returns {Object} { recScore, recommendation, scoreBreakdown }
 * 
 * @example
 * const score = computeMultiSourceScore({
 *   market: 'home_run',
 *   confidence: 75,
 *   floor: 0.06,
 *   ceiling: 0.15,
 *   triggerStrength: 0.3,
 *   features: { verdict: 'strong', liftVsPark: 0.15 },
 *   battingOrder: 3,
 * })
 * // { recScore: 72.5, recommendation: true, scoreBreakdown: {...} }
 */
export function computeMultiSourceScore(prediction) {
  const {
    market,
    confidence,
    floor,
    ceiling,
    triggerStrength = 0,
    features = {},
    battingOrder = 5,
    dataQuality = 'ok',
  } = prediction;

  // Prevent recommendations on poor data
  if (dataQuality === 'missing') {
    return {
      recScore: 0,
      recommendation: false,
      scoreBreakdown: { reason: 'Insufficient data quality' },
    };
  }

  let recScore = 0;
  const scoreBreakdown = {};

  if (market === 'home_run') {
    // HR scoring: multi-source evidence
    const confidenceComponent = confidence * 0.45;
    scoreBreakdown.confidence = confidenceComponent;

    const triggerComponent = Math.max(0, triggerStrength) * 20;
    scoreBreakdown.trigger = triggerComponent;

    // Baseline lift: prefer picks where model beats both baselines
    const liftVsPark = features?.liftVsPark ?? 0;
    const lineupWeight = battingOrder && battingOrder <= 6 ? 1 : 0.7;
    const liftComponent = Math.max(0, Math.min(liftVsPark, 1)) * 20 * lineupWeight;
    scoreBreakdown.liftVsPark = liftComponent;

    // Spread component: narrower spread = more confident
    const spread = Math.max(0, ceiling - floor);
    const spreadComponent = Math.min(spread * 10, 10);
    scoreBreakdown.spread = spreadComponent;

    // Bonus for "middling" picks (between park and Vegas)
    const isMiddling = features?.verdict === 'middling' ? 5 : 0;
    scoreBreakdown.middlingBonus = isMiddling;

    recScore = confidenceComponent + triggerComponent + liftComponent + spreadComponent + isMiddling;
  } else {
    // Non-HR markets: simpler logic
    const confidenceComponent = confidence * 0.4;
    scoreBreakdown.confidence = confidenceComponent;

    const triggerComponent = Math.max(0, triggerStrength) * 30;
    scoreBreakdown.trigger = triggerComponent;

    const floorBonus = floor > 0.5 ? 15 : 0;
    scoreBreakdown.floor = floorBonus;

    recScore = confidenceComponent + triggerComponent + floorBonus;
  }

  recScore = Math.min(100, Math.max(0, recScore));

  return {
    recScore,
    recommendation: recScore >= 55 && dataQuality !== 'missing',
    scoreBreakdown,
  };
}

/**
 * Evaluates if a pick qualifies as a "middling pick" for parlays
 * 
 * Middling picks represent hidden-value situations where the model identifies
 * an edge that Vegas and ballpark factors might undervalue. These are ideal for
 * parlays because they diversify the source of edge (not purely confidence-driven).
 * 
 * @param {Object} prediction - Prediction with market, features, confidence
 * @returns {boolean} True if pick is a middling pick
 */
export function isMiddlingPick(prediction) {
  if (prediction.market !== 'home_run') return false;
  return prediction.features?.verdict === 'middling';
}

/**
 * Categorizes picks into tiers for parlay construction
 * 
 * TIER 1 (High Confidence): recScore >= 70, model + matchup strongly aligned
 * TIER 2 (Medium Confidence): recScore 55-69, good model fit with some matchup support
 * TIER 3 (Middling/Edge): recScore 45-54 but verdict='middling', hidden edge plays
 * TIER 4 (Low Confidence): recScore < 45, mostly avoid
 * 
 * @param {Object} prediction - Prediction with recScore and verdict
 * @returns {string} Tier label for parlay construction
 */
export function categorizePredictionTier(prediction) {
  const { recScore = 0, features = {} } = prediction;
  
  if (recScore >= 70) return 'tier1_high_confidence';
  if (recScore >= 55) return 'tier2_medium_confidence';
  if (recScore >= 45 && features.verdict === 'middling') return 'tier3_middling_edge';
  return 'tier4_low_confidence';
}