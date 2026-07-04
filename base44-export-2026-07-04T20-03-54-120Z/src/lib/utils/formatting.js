/**
 * Formatting Utility Functions
 * 
 * Handles consistent formatting of numbers, percentages, and statistics
 * for display across the application.
 */

/**
 * Formats a probability as a percentage string
 * 
 * @param {number} prob - Probability value [0, 1]
 * @param {number} decimals - Number of decimal places to display (default 1)
 * @returns {string} Formatted percentage (e.g., "67.5%")
 * 
 * @example
 * formatPercent(0.675) // "67.5%"
 * formatPercent(0.5, 0)  // "50%"
 * formatPercent(0.3333, 2) // "33.33%"
 */
export function formatPercent(prob, decimals = 1) {
  if (prob == null) return '—';
  return `${(prob * 100).toFixed(decimals)}%`;
}

/**
 * Formats a number with optional decimal places
 * Used for consistency in displaying stats (ERA, AVG, etc.)
 * 
 * @param {number} num - Number to format
 * @param {number} decimals - Number of decimal places (default 2)
 * @param {string} fallback - Fallback string if num is null/undefined (default '—')
 * @returns {string} Formatted number
 * 
 * @example
 * formatNumber(3.47, 2)  // "3.47"
 * formatNumber(0.275, 3) // "0.275"
 * formatNumber(null, 2)  // "—"
 */
export function formatNumber(num, decimals = 2, fallback = '—') {
  if (num == null) return fallback;
  return num.toFixed(decimals);
}

/**
 * Formats a batting average for display
 * Converts decimal format (0.275) to traditional format (.275)
 * 
 * @param {number} avg - Batting average [0, 1]
 * @returns {string} Formatted average (e.g., ".275")
 * 
 * @example
 * formatBattingAvg(0.275) // ".275"
 * formatBattingAvg(null)   // "—"
 */
export function formatBattingAvg(avg) {
  if (avg == null) return '—';
  return `.${Math.round(avg * 1000)}`;
}

/**
 * Formats an edge/EV (expected value) for display with sign
 * 
 * @param {number} edge - Edge value (can be positive or negative)
 * @param {number} decimals - Decimal places to display (default 1)
 * @returns {string} Formatted edge with +/- sign (e.g., "+2.5 pts", "-1.2 pts")
 * 
 * @example
 * formatEdge(2.5) // "+2.5 pts"
 * formatEdge(-1.2) // "-1.2 pts"
 * formatEdge(0) // "+0.0 pts"
 */
export function formatEdge(edge, decimals = 1) {
  if (edge == null) return '—';
  const sign = edge >= 0 ? '+' : '';
  return `${sign}${(edge * 100).toFixed(decimals)} pts`;
}

/**
 * Formats confidence score with optional styling hint
 * 
 * @param {number} conf - Confidence value [0, 100]
 * @param {number} decimals - Decimal places (default 0 for integer display)
 * @returns {string} Formatted confidence
 * 
 * @example
 * formatConfidence(85.7) // "86"
 * formatConfidence(67.2, 1) // "67.2"
 */
export function formatConfidence(conf, decimals = 0) {
  if (conf == null) return '—';
  return Math.round(conf).toFixed(decimals);
}
