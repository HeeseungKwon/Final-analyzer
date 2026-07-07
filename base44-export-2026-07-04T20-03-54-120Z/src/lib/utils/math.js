/**
 * Mathematical Utility Functions
 * 
 * Reusable math operations used throughout the analyzer for calculations,
 * probability transformations, and constraint management.
 */

/**
 * Clamps a value within a specified range
 * Ensures the output is bounded by [lo, hi]
 * 
 * @param {number} x - The value to clamp
 * @param {number} lo - Lower bound (inclusive)
 * @param {number} hi - Upper bound (inclusive)
 * @returns {number} The clamped value
 * 
 * @example
 * clamp(1.5, 0, 1) // Returns 1
 * clamp(-0.5, 0, 1) // Returns 0
 * clamp(0.5, 0, 1) // Returns 0.5
 */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Sigmoid smoothing function with configurable anchor and slope
 * Maps a normalized input [0, 1] to a smooth S-curve with custom inflection
 * 
 * Used to convert linear scales (e.g., projection - threshold) into smooth probabilities
 * that respect domain constraints and avoid hard boundaries.
 * 
 * Formula: sigmoid(x * slope * 6) * (1 - anchor) + anchor
 * - At x=0: output ≈ anchor (lower asymptote)
 * - At x=1: output ≈ 1 (upper asymptote)
 * - slope controls steepness of the S-curve transition
 * 
 * @param {number} x - Normalized input value around 0 (typically scaled difference from threshold)
 * @param {number} anchor - Lower asymptote; minimum output value [0, 1]
 * @param {number} slope - Steepness of sigmoid curve; higher = faster transition
 * @returns {number} Smoothed probability value in range [anchor, 1]
 * 
 * @example
 * // For strikeouts: expects (projection - 5.5) / 3.0
 * smooth(0, 0.4, 0.8) // Near threshold: ~0.4
 * smooth(1, 0.4, 0.8) // Well above threshold: ~1.0
 */
export function smooth(x, anchor, slope) {
  return 1 / (1 + Math.exp(-x * slope * 6)) * (1 - anchor) + anchor;
}

/**
 * Converts a probability to American Odds format
 * Used for displaying fair odds and parlay breakeven calculations
 * 
 * American Odds:
 * - Positive: underdog odds; e.g., +120 means bet $100 to win $120
 * - Negative: favorite odds; e.g., -120 means bet $120 to win $100
 * 
 * Formula:
 * - If decimal odds < 2: american = -100 / (decimal - 1)
 * - If decimal odds >= 2: american = 100 * (decimal - 1)
 * 
 * @param {number} p - Probability in range [0, 1]
 * @returns {string} American odds formatted as '+XXX' or '-XXX', or edge case strings
 * 
 * @example
 * probToAmerican(0.5) // '-120' (fair 50/50 at standard -120 vig)
 * probToAmerican(0.667) // '-200' (2:1 favorite)
 * probToAmerican(0.333) // '+100' (underdog)
 */
export function probToAmerican(p) {
  if (p <= 0) return '+∞';
  if (p >= 1) return '-∞';
  const dec = 1 / p;
  const american = dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
  return american > 0 ? `+${american}` : `${american}`;
}

/**
 * Blends two values with configurable weight toward the second value
 * Used to combine season and recent statistics for improved hitter/pitcher scores
 * 
 * @param {number|null} season - Season-to-date statistic
 * @param {number|null} recent - Recent (e.g., last 15 games) statistic
 * @param {number} wRecent - Weight applied to recent value (0-1); default 0.35
 * @returns {number|null} Blended value, or null if both inputs are null
 * 
 * @example
 * blend(0.250, 0.300, 0.35) // 0.265 (weighted average, favoring season)
 * blend(0.250, null, 0.35)  // 0.250 (season only)
 * blend(null, null, 0.35)   // null (insufficient data)
 */
export function blend(season, recent, wRecent = 0.35) {
  if (season == null && recent == null) return null;
  if (season == null) return recent;
  if (recent == null) return season;
  return season * (1 - wRecent) + recent * wRecent;
}

/**
 * Converts a probability to a confidence score (0-100)
 * Logistic scaling centered at an anchor point, with customizable slope
 * 
 * Formula: 100 / (1 + e^(-(prob - anchor) * slope / 18))
 * - At anchor point: confidence = 50
 * - Above anchor: confidence rises smoothly without saturating too early
 * - Below anchor: confidence falls smoothly without collapsing to 0 too early
 * 
 * Used to display model confidence in a human-friendly 0-100 range
 * Different markets use different anchor/slope pairs for calibration
 * 
 * @param {number} prob - Input probability [0, 1]
 * @param {number} anchor - Center point; probability that maps to confidence 50 (default 0.5)
 * @param {number} slope - Scaling factor; higher slope = more sensitive to prob changes (default 120)
 * @returns {number} Confidence score in range [0, 100]
 * 
 * @example
 * // HR market: anchor=0.10, slope=300 (high sensitivity)
 * toConfidence(0.15, 0.10, 300) // ~65
 * toConfidence(0.10, 0.10, 300) // 50
 * 
 * // Hit market: anchor=0.65, slope=130 (lower sensitivity)
 * toConfidence(0.65, 0.65, 130) // 50
 * toConfidence(0.75, 0.65, 130) // ~77
 */
export function toConfidence(prob, anchor = 0.5, slope = 120) {
  const midpoint = clamp(Number(anchor) || 0.5, 0, 1);
  const probability = clamp(Number(prob) || 0, 0, 1);
  const steepness = Math.max(1, Number(slope) || 120) / 18;
  return clamp(100 / (1 + Math.exp(-(probability - midpoint) * steepness)), 0, 100);
}