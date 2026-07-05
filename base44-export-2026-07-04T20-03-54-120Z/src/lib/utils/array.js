/**
 * Array and Collection Utility Functions
 * 
 * Handles common array operations, sorting, filtering, and grouping
 * used throughout the analyzer for data transformation.
 */

/**
 * Groups array items by a key function
 * Useful for organizing picks by player, game, market, etc.
 * 
 * @param {Array} items - Array of items to group
 * @param {Function} keyFn - Function that returns the group key for each item
 * @returns {Object} Object with keys mapping to arrays of items
 * 
 * @example
 * const picks = [{game_pk: 1, player: 'A'}, {game_pk: 1, player: 'B'}, {game_pk: 2, player: 'C'}]
 * groupBy(picks, p => p.game_pk)
 * // {1: [{game_pk: 1, player: 'A'}, {game_pk: 1, player: 'B'}], 2: [{game_pk: 2, player: 'C'}]}
 */
export function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * Sorts array of objects by multiple fields with direction control
 * Useful for sorting picks by player name, then by date
 * 
 * @param {Array} items - Array to sort
 * @param {Array<{field, direction}>} sortBy - Sort criteria
 *   field: property name to sort by
 *   direction: 'asc' (default) or 'desc'
 * @returns {Array} Sorted array (new instance)
 * 
 * @example
 * const picks = [{player: 'B', date: '2026-07-04'}, {player: 'A', date: '2026-07-05'}]
 * multiSort(picks, [{field: 'player', direction: 'asc'}, {field: 'date', direction: 'desc'}])
 * // Sorts by player ascending, then by date descending
 */
export function multiSort(items, sortBy = []) {
  return [...items].sort((a, b) => {
    for (const { field, direction = 'asc' } of sortBy) {
      const aVal = a[field];
      const bVal = b[field];
      
      if (aVal === bVal) continue;
      
      const comparison = aVal < bVal ? -1 : 1;
      return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

/**
 * Filters array to unique items based on a key function
 * Removes duplicates by checking if key has been seen before
 * 
 * @param {Array} items - Array to filter
 * @param {Function} keyFn - Function returning the unique key for each item
 * @returns {Array} Array with duplicates removed
 * 
 * @example
 * const picks = [{player_id: 1, player: 'A'}, {player_id: 1, player: 'A'}, {player_id: 2, player: 'B'}]
 * uniqueBy(picks, p => p.player_id)
 * // [{player_id: 1, player: 'A'}, {player_id: 2, player: 'B'}]
 */
export function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Partitions array into two based on predicate
 * Useful for separating "recommended" from "non-recommended" picks
 * 
 * @param {Array} items - Array to partition
 * @param {Function} predicate - Function returning true/false for each item
 * @returns {Array<Array>} [passing, failing] - Two arrays
 * 
 * @example
 * const picks = [{recommended: true}, {recommended: false}, {recommended: true}]
 * const [recommended, notRec] = partition(picks, p => p.recommended)
 * // recommended: [{recommended: true}, {recommended: true}]
 * // notRec: [{recommended: false}]
 */
export function partition(items, predicate) {
  return items.reduce(
    ([pass, fail], item) => {
      return predicate(item) ? [[...pass, item], fail] : [pass, [...fail, item]];
    },
    [[], []]
  );
}