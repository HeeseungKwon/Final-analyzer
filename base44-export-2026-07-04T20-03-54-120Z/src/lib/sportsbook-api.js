const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const CACHE_TTL_MS = 5 * 60 * 1000;
// Treat lines within roughly one tenth of a unit as equivalent so small API
// representation differences (1.5 vs 1.49/1.6) do not block a usable match.
const LINE_MATCH_TOLERANCE = 0.11;
const MIN_CANDIDATE_SCORE = 7;
const DEFAULT_FALLBACK_ODDS = -110;

const DEFAULT_IMPLIED_PROBABILITIES = {
  hit_2: 0.33,
  total_bases: 0.53,
  hrr_2: 0.56,
  hrr_3: 0.34,
  home_run: 0.14,
  strikeouts: 0.46,
};

const DEFAULT_MARKET_LINES = {
  hit_2: 1.5,
  total_bases: 1.5,
  hrr_2: 1.5,
  hrr_3: 2.5,
  home_run: 0.5,
  strikeouts: 5.5,
};

const MARKET_TERMS = {
  hit_2: ["hits", "2+ hits", "over 1.5 hits", "player hits"],
  total_bases: ["total bases", "tb", "over 1.5 total bases", "over 1.5 tb"],
  hrr_2: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 1.5 hits runs rbis", "2+ hrr"],
  hrr_3: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 2.5 hits runs rbis", "3+ hrr"],
  home_run: ["home run", "home runs", "to hit a home run", "1+ home run"],
  strikeouts: ["strikeouts", "pitcher strikeouts", "over strikeouts"],
};

const payloadCache = new Map();

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

function parseAmericanOdds(value) {
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) return Math.trunc(value);
  const match = String(value ?? "").match(/([+-]\d{3,4})/);
  if (!match) return null;
  const odds = Number(match[1]);
  return Number.isFinite(odds) && odds !== 0 ? odds : null;
}

function parseLineValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

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

function buildFallbackOdds(market) {
  const impliedProbability = DEFAULT_IMPLIED_PROBABILITIES[market] ?? 0.5;
  return {
    marketOdds: impliedToAmerican(impliedProbability),
    impliedProbability,
    marketLine: DEFAULT_MARKET_LINES[market] ?? null,
    source: "fallback-default",
    provider: "fallback",
    fallbackUsed: true,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Sportsbook API ${response.status}`);
  }
  return response.json();
}

async function fetchCachedPayload(key, url) {
  const cached = payloadCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await fetchJson(url);
  payloadCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return data;
}

async function getEspnPayload(gamePk) {
  const urls = [
    { key: `summary:${gamePk}`, url: `${ESPN_BASE}/summary?event=${gamePk}` },
    { key: `scoreboard:${gamePk}`, url: `${ESPN_BASE}/scoreboard?events=${gamePk}` },
  ];

  for (const candidate of urls) {
    try {
      const payload = await fetchCachedPayload(candidate.key, candidate.url);
      if (payload) return { payload, source: candidate.key.startsWith("summary:") ? "espn-summary" : "espn-scoreboard" };
    } catch {
      // Fall through to the next endpoint or default odds.
    }
  }

  return null;
}

function extractStrings(record) {
  const keys = [
    "name",
    "displayName",
    "shortName",
    "description",
    "details",
    "label",
    "market",
    "type",
    "text",
    "betType",
    "alternateDisplayValue",
  ];

  return keys
    .map((key) => record?.[key])
    .filter(Boolean)
    .join(" ");
}

function extractOddsCandidate(record) {
  if (!record || typeof record !== "object") return null;

  const text = normalizeText(extractStrings(record));
  const marketOdds = [
    record.american,
    record.americanOdds,
    record.displayOdds,
    record.price,
    record.odds,
    record.value,
    record.moneyLine,
    record?.awayTeamOdds?.moneyLine,
    record?.homeTeamOdds?.moneyLine,
  ]
    .map(parseAmericanOdds)
    .find((value) => value != null);

  if (!text || marketOdds == null) return null;

  return {
    text,
    marketOdds,
    marketLine: [
      record.line,
      record.points,
      record.total,
      record.threshold,
      record.overUnder,
      record.handicap,
      record.value,
    ]
      .map(parseLineValue)
      .find((value) => value != null) ?? null,
    provider: record?.provider?.name ?? record?.sportsbook?.name ?? "ESPN",
  };
}

function collectOddsCandidates(node, results = []) {
  if (!node || typeof node !== "object") return results;

  if (Array.isArray(node)) {
    node.forEach((entry) => collectOddsCandidates(entry, results));
    return results;
  }

  const candidate = extractOddsCandidate(node);
  if (candidate) results.push(candidate);

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectOddsCandidates(value, results);
    }
  }

  return results;
}

function candidateScore(candidate, market, playerName) {
  const text = candidate.text;
  const expectedLine = DEFAULT_MARKET_LINES[market];
  const playerTerms = normalizeText(playerName).split(" ").filter(Boolean);
  const marketTerms = MARKET_TERMS[market] ?? [];

  let score = 0;
  if (playerTerms.length > 0 && playerTerms.every((term) => text.includes(term))) score += 6;
  else if (playerTerms.some((term) => text.includes(term))) score += 3;

  if (marketTerms.some((term) => text.includes(normalizeText(term)))) score += 4;

  if (expectedLine == null || candidate.marketLine == null) {
    score += 1;
  } else if (Math.abs(candidate.marketLine - expectedLine) <= LINE_MATCH_TOLERANCE) {
    score += 2;
  }

  return score;
}

export async function fetchRealtimeOdds(gamePk, market, playerName) {
  const fallback = buildFallbackOdds(market);

  if (!gamePk || !market || !playerName) {
    return fallback;
  }

  try {
    const response = await getEspnPayload(gamePk);
    if (!response?.payload) return fallback;

    const candidates = collectOddsCandidates(response.payload);
    if (candidates.length === 0) return fallback;

    const best = candidates
      .map((candidate) => ({
        ...candidate,
        score: candidateScore(candidate, market, playerName),
      }))
      .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
      .sort((a, b) => b.score - a.score)[0];

    if (!best) return fallback;

    const impliedProbability = convertAmericanToImplied(best.marketOdds);
    if (!Number.isFinite(impliedProbability)) return fallback;

    return {
      marketOdds: best.marketOdds,
      impliedProbability,
      marketLine: best.marketLine ?? fallback.marketLine,
      source: response.source,
      provider: best.provider,
      fallbackUsed: false,
    };
  } catch {
    return fallback;
  }
}
