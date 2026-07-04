/**
 * Date Utility Functions
 * 
 * Handles date formatting and manipulation used throughout the analyzer
 * for query filtering, display, and cache key generation.
 */

/**
 * Formats today's date as YYYY-MM-DD
 * Used as default date selector in pages and query cache keys
 * 
 * @returns {string} Date string in ISO 8601 format (YYYY-MM-DD)
 * 
 * @example
 * getTodayDateString() // "2026-07-04"
 */
export function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Formats a Date object to YYYY-MM-DD string
 * 
 * @param {Date} date - Date object to format
 * @returns {string} Formatted date string
 * 
 * @example
 * formatDate(new Date('2026-07-15')) // "2026-07-15"
 */
export function formatDate(date) {
  if (!date || !(date instanceof Date)) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Formats a time string for display (e.g., "14:30 ET")
 * Used to show game times in a compact, user-friendly format
 * 
 * @param {string} isoTimeString - ISO 8601 timestamp string or Date string
 * @returns {string} Formatted time (HH:MM) or empty string if invalid
 * 
 * @example
 * formatGameTime('2026-07-04T19:30:00Z') // "19:30"
 */
export function formatGameTime(isoTimeString) {
  if (!isoTimeString) return '';
  try {
    const date = new Date(isoTimeString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}
