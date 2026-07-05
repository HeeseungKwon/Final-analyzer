/**
 * Market Configuration Constants
 * 
 * Centralized definitions for all MLB player prop markets supported by the analyzer.
 * This module serves as the single source of truth for market metadata, labels,
 * and projection unit specifications.
 */

/**
 * Market Keys
 * Used to identify and filter different prop markets in predictions and parlays
 */
export const MARKET_KEYS = {
  HIT_1: 'hit_1',
  HIT_2: 'hit_2',
  HRR: 'hrr',
  TOTAL_BASES: 'total_bases',
  HOME_RUN: 'home_run',
  STRIKEOUTS: 'strikeouts',
};

/**
 * Human-readable market labels
 * Maps market keys to display-friendly names for UI rendering
 */
export const MARKET_LABELS = {
  hit_1: '1+ Hit',
  hit_2: '2+ Hits',
  hrr: 'Hits+Runs+RBIs 1.5',
  total_bases: 'Total Bases 1.5',
  home_run: 'Home Run',
  strikeouts: 'Strikeouts 5.5',
};

/**
 * Short-form market labels for compact displays (tables, parlays)
 * Used in places where space is limited
 */
export const MARKET_SHORT_LABELS = {
  hit_1: '1+ Hit',
  hit_2: '2+ Hits',
  hrr: 'HRR 1.5',
  total_bases: 'TB 1.5',
  home_run: 'HR',
  strikeouts: 'K 5.5',
};

/**
 * Projection unit specifications
 * Describes what each market's projection value represents and provides
 * user-facing descriptions for context
 */
export const MARKET_PROJECTION_UNIT = {
  hit_1: {
    unit: 'probability',
    label: 'P(1+ hit)',
    description: 'Probability the hitter records at least 1 hit.',
  },
  hit_2: {
    unit: 'probability',
    label: 'P(2+ hits)',
    description: 'Probability the hitter records 2 or more hits.',
  },
  home_run: {
    unit: 'probability',
    label: 'P(HR)',
    description: 'Probability the hitter hits at least 1 home run.',
  },
  total_bases: {
    unit: 'count',
    label: 'Exp. total bases',
    description: 'Expected total bases (1B=1, 2B=2, 3B=3, HR=4). Line = 1.5.',
  },
  hrr: {
    unit: 'count',
    label: 'Exp. H+R+RBI',
    description: 'Expected Hits + Runs + RBIs combined. Line = 1.5.',
  },
  strikeouts: {
    unit: 'count',
    label: 'Exp. K',
    description: 'Expected strikeouts for the starting pitcher. Line = 5.5.',
  },
};

/**
 * Exported market list for Today page filter tabs
 * Defines the selectable filters available to end users
 */
export const MARKETS_FOR_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'hit_1', label: '1+ Hit' },
  { key: 'hit_2', label: '2+ Hits' },
  { key: 'hrr', label: 'HRR' },
  { key: 'total_bases', label: 'Total Bases' },
  { key: 'home_run', label: 'Home Run' },
  { key: 'strikeouts', label: 'Strikeouts' },
];

/**
 * Helper function to get market label
 * @param {string} marketKey - The market identifier
 * @param {string} variant - 'full' (default) or 'short' for compact display
 * @returns {string} The market label
 */
export function getMarketLabel(marketKey, variant = 'full') {
  if (variant === 'short') {
    return MARKET_SHORT_LABELS[marketKey] ?? marketKey;
  }
  return MARKET_LABELS[marketKey] ?? marketKey;
}

/**
 * Helper function to get projection unit info
 * @param {string} marketKey - The market identifier
 * @returns {object|null} The projection unit specification or null if not found
 */
export function getMarketProjectionUnit(marketKey) {
  return MARKET_PROJECTION_UNIT[marketKey] ?? null;
}