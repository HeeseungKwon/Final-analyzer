// Market odds are sourced from representative sportsbook lines rather than
// live API calls. These default implied probabilities and lines reflect
// typical MLB player prop markets and are used to calculate edge vs. our
// model's probability estimates.
const DEFAULT_FALLBACK_ODDS = -110;

const DEFAULT_IMPLIED_PROBABILITIES = {
  hit_2: 0.56,
  total_bases: 0.54,
  hrr_2: 0.55,
  hrr_3: 0.34,
  home_run: 0.35,
  strikeouts: 0.52,
};

const DEFAULT_MARKET_LINES = {
  hit_2: 1.5,
  total_bases: 1.5,
  hrr_2: 1.5,
  hrr_3: 2.5,
  home_run: 0.5,
  strikeouts: 5.5,
};

function impliedToAmerican(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return DEFAULT_FALLBACK_ODDS;
  if (p >= 0.5) return -Math.round((p / (1 - p)) * 100);
  return Math.round(((1 - p) / p) * 100);
}

export function convertAmericanToImplied(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

// Returns market odds for a given prop market based on representative
// sportsbook implied probabilities. No external API calls are made.
export async function fetchRealtimeOdds(gamePk, market) {
  const impliedProbability = DEFAULT_IMPLIED_PROBABILITIES[market] ?? 0.5;
  return {
    marketOdds: impliedToAmerican(impliedProbability),
    impliedProbability,
    marketLine: DEFAULT_MARKET_LINES[market] ?? null,
    source: "market-default",
    provider: "market",
    fallbackUsed: true,
    fallbackReason: "market-default",
    eventId: null,
  };
}
