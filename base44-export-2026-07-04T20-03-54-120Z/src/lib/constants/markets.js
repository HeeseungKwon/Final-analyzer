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
  HIT_2: 'hit_2',
  HRR_2: 'hrr_2',
  HRR_3: 'hrr_3',
  TOTAL_BASES: 'total_bases',
  HOME_RUN: 'home_run',
  STRIKEOUTS: 'strikeouts',
};

export const CORE_HITTER_MARKETS = [
  MARKET_KEYS.HRR_2,
  MARKET_KEYS.HRR_3,
  MARKET_KEYS.HIT_2,
  MARKET_KEYS.TOTAL_BASES,
];

// Reused by recommendation sorting and parlay building, so keep the normalized
// lookup set module-scoped instead of recreating it at every call site.
const CORE_HITTER_MARKET_SET = new Set(CORE_HITTER_MARKETS);

export const RECOMMENDATION_MARKET_PRIORITY = {
  [MARKET_KEYS.HRR_2]: 0,
  [MARKET_KEYS.HRR_3]: 1,
  [MARKET_KEYS.HIT_2]: 2,
  [MARKET_KEYS.TOTAL_BASES]: 3,
  [MARKET_KEYS.HOME_RUN]: 4,
  [MARKET_KEYS.STRIKEOUTS]: 5,
};

/**
 * Human-readable market labels
 * Maps market keys to display-friendly names for UI rendering
 */
export const MARKET_LABELS = {
  hit_2: '2+ Hits',
  hrr_2: 'HRR O1.5',
  hrr_3: 'HRR O2.5',
  total_bases: 'TB O1.5',
  home_run: 'Home Run',
  strikeouts: 'Strikeouts 6.5',
};

/**
 * Short-form market labels for compact displays (tables, parlays)
 * Used in places where space is limited
 */
export const MARKET_SHORT_LABELS = {
  hit_2: '2+ Hits',
  hrr_2: 'HRR O1.5',
  hrr_3: 'HRR O2.5',
  total_bases: 'TB O1.5',
  home_run: 'HR',
  strikeouts: 'K 6.5',
};

/**
 * Projection unit specifications
 * Describes what each market's projection value represents and provides
 * user-facing descriptions for context
 */
export const MARKET_PROJECTION_UNIT = {
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
    unit: 'probability',
    label: 'P(TB ≥ 2)',
    description: 'Probability total bases reach at least 2 for the TB O1.5 benchmark.',
  },
  hrr_2: {
    unit: 'probability',
    label: 'P(HRR ≥ 2)',
    description: 'Probability hits + runs + RBIs reach at least 2 for the HRR O1.5 benchmark.',
  },
  hrr_3: {
    unit: 'probability',
    label: 'P(HRR ≥ 3)',
    description: 'Probability hits + runs + RBIs reach at least 3 for the HRR O2.5 benchmark.',
  },
  strikeouts: {
    unit: 'count',
    label: 'Exp. K',
    description: 'Expected strikeouts for the starting pitcher. Line = 6.5.',
  },
};

export const PROBABILITY_MARKETS = new Set(
  Object.entries(MARKET_PROJECTION_UNIT)
    .filter(([, config]) => config.unit === 'probability')
    .map(([marketKey]) => marketKey)
);

/**
 * Exported market list for Today page filter tabs
 * Defines the selectable filters available to end users
 */
export const MARKETS_FOR_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'hit_2', label: '2+ Hits' },
  { key: 'hrr_2', label: 'HRR O1.5' },
  { key: 'hrr_3', label: 'HRR O2.5' },
  { key: 'total_bases', label: 'TB O1.5' },
  { key: 'home_run', label: 'Home Run' },
  { key: 'strikeouts', label: 'Strikeouts' },
];

const LEGACY_MARKET_ALIASES = {
  'TB 2.5': 'total_bases',
  'Total Bases 2.5': 'total_bases',
  'TB O1.5': 'total_bases',
  'HRR 2.5': 'hrr_2',
  'Hits+Runs+RBIs 2.5': 'hrr_2',
  'HRR O1.5': 'hrr_2',
  'HRR 3.5': 'hrr_3',
  'Hits+Runs+RBIs 3.5': 'hrr_3',
  'HRR O2.5': 'hrr_3',
};

export function normalizeMarketKey(marketKey) {
  return LEGACY_MARKET_ALIASES[marketKey] ?? marketKey;
}

/**
 * Returns true when the market belongs to the core hitter recommendation set:
 * 2+ HRR, 3+ HRR, 2+ Hits, or TB O1.5.
 */
export function isCoreHitterMarket(marketKey) {
  return CORE_HITTER_MARKET_SET.has(normalizeMarketKey(marketKey));
}

/**
 * Lower numbers represent higher recommendation priority. Unknown markets sort
 * to the end so new or unsupported market keys cannot displace the core order.
 */
export function getRecommendationMarketPriority(marketKey) {
  const key = normalizeMarketKey(marketKey);
  return RECOMMENDATION_MARKET_PRIORITY[key] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Helper function to get market label
 * @param {string} marketKey - The market identifier
 * @param {string} variant - 'full' (default) or 'short' for compact display
 * @returns {string} The market label
 */
export function getMarketLabel(marketKey, variant = 'full') {
  const key = normalizeMarketKey(marketKey);
  if (variant === 'short') {
    return MARKET_SHORT_LABELS[key] ?? key;
  }
  return MARKET_LABELS[key] ?? key;
}

/**
 * Helper function to get projection unit info
 * @param {string} marketKey - The market identifier
 * @returns {object|null} The projection unit specification or null if not found
 */
export function getMarketProjectionUnit(marketKey) {
  return MARKET_PROJECTION_UNIT[normalizeMarketKey(marketKey)] ?? null;
}

export function isProbabilityMarket(marketKey) {
  return PROBABILITY_MARKETS.has(normalizeMarketKey(marketKey));
}