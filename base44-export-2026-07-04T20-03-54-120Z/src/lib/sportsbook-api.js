// Real-time MLB sportsbook odds via RapidAPI with ESPN fallback.
//
// Priority chain:
//   1. The Odds API via RapidAPI  (when VITE_RAPIDAPI_KEY is configured)
//   2. JsonOdds via RapidAPI      (when VITE_JSONODDS_RAPIDAPI_KEY or VITE_RAPIDAPI_KEY is configured)
//   3. ESPN summary / scoreboard API extraction
//   4. Market-average defaults    (fallbackUsed: true, fallbackReason set)

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ODDS_API_RAPIDAPI_HOST = "odds.p.rapidapi.com";
const JSONODDS_RAPIDAPI_HOST = "jsonjames-jsonodds-v1.p.rapidapi.com";
const ODDS_API_SPORT = "baseball_mlb";

const CACHE_TTL_MS = 5 * 60 * 1000;
// Treat lines within ~one tenth of a unit as equivalent.
const LINE_MATCH_TOLERANCE = 0.11;
const MIN_CANDIDATE_SCORE = 7;
const DEFAULT_FALLBACK_ODDS = -110;
const FALLBACK_REASON_RAPIDAPI_NOT_CONFIGURED = "rapidapi-not-configured";

// Maps internal market names → The Odds API market keys
const ODDS_API_MARKET_MAP = {
  hit_2: "batter_hits",
  total_bases: "batter_total_bases",
  hrr_2: "batter_hits_runs_rbis",
  hrr_3: "batter_hits_runs_rbis",
  home_run: "batter_home_runs",
  strikeouts: "pitcher_strikeouts",
};

// ESPN market term patterns for fuzzy candidate scoring
const MARKET_TERMS = {
  hit_2: ["hits", "2+ hits", "over 1.5 hits", "player hits"],
  total_bases: ["total bases", "tb", "over 1.5 total bases", "over 1.5 tb"],
  hrr_2: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 1.5 hits runs rbis", "2+ hrr"],
  hrr_3: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 2.5 hits runs rbis", "3+ hrr"],
  home_run: ["home run", "home runs", "to hit a home run", "1+ home run"],
  strikeouts: ["strikeouts", "pitcher strikeouts", "over strikeouts"],
};

// Market-average implied probabilities — last-resort defaults only
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

// Preferred sportsbooks in priority order
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbetus", "wynnbet"];

// Caches
const payloadCache = new Map();       // ESPN payload cache
const oddsResultCache = new Map();    // Final odds result cache
const oddsApiEventCache = new Map();  // RapidAPI events list cache (key: date)
const oddsApiPropsCache = new Map();  // RapidAPI props cache (key: eventId:market)

// ── Utility functions ────────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

function normalizeTeamName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
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

function buildFallbackOdds(market, reason = "no-match") {
  const impliedProbability = DEFAULT_IMPLIED_PROBABILITIES[market] ?? 0.5;
  return {
    marketOdds: impliedToAmerican(impliedProbability),
    impliedProbability,
    marketLine: DEFAULT_MARKET_LINES[market] ?? null,
    source: "fallback-default",
    provider: "fallback",
    fallbackUsed: true,
    fallbackReason: reason,
    eventId: null,
  };
}

function getEnvValue(key) {
  return import.meta.env?.[key] || null;
}

function getOddsApiRapidApiKey() {
  return getEnvValue("VITE_ODDS_API_RAPIDAPI_KEY") || getEnvValue("VITE_RAPIDAPI_KEY");
}

function getJsonOddsRapidApiKey() {
  return getEnvValue("VITE_JSONODDS_RAPIDAPI_KEY") || getEnvValue("VITE_RAPIDAPI_KEY");
}

function hasAnyRapidApiKey() {
  return Boolean(getOddsApiRapidApiKey() || getJsonOddsRapidApiKey());
}

function getRapidApiHeaders(apiKey, host) {
  return {
    "Content-Type": "application/json",
    "x-rapidapi-key": apiKey,
    "x-rapidapi-host": host,
  };
}

// ── RapidAPI / The Odds API integration ─────────────────────────────────────

async function fetchOddsApiEvents(gameDate) {
  const cached = oddsApiEventCache.get(gameDate);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const apiKey = getOddsApiRapidApiKey();
  if (!apiKey) return null;

  const from = `${gameDate}T00:00:00Z`;
  const to = `${gameDate}T23:59:59Z`;
  const url = `https://${ODDS_API_RAPIDAPI_HOST}/v4/sports/${ODDS_API_SPORT}/events?dateFormat=iso&commenceTimeFrom=${encodeURIComponent(from)}&commenceTimeTo=${encodeURIComponent(to)}`;
  const response = await fetch(url, {
    headers: getRapidApiHeaders(apiKey, ODDS_API_RAPIDAPI_HOST),
  });
  if (!response.ok) throw new Error(`Odds API events ${response.status}`);
  const data = await response.json();
  oddsApiEventCache.set(gameDate, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function findOddsApiEvent(events, homeTeamName, awayTeamName) {
  if (!Array.isArray(events) || events.length === 0) return null;
  if (!homeTeamName || !awayTeamName) return null;

  const extractTeamNickname = (s) => s.split(" ").filter(Boolean).at(-1) ?? "";
  const homeNorm = normalizeTeamName(homeTeamName);
  const awayNorm = normalizeTeamName(awayTeamName);
  const homeNick = extractTeamNickname(homeNorm);
  const awayNick = extractTeamNickname(awayNorm);

  return (
    events.find((e) => {
      const eHomeNorm = normalizeTeamName(e.home_team ?? "");
      const eAwayNorm = normalizeTeamName(e.away_team ?? "");
      const eHomeNick = extractTeamNickname(eHomeNorm);
      const eAwayNick = extractTeamNickname(eAwayNorm);
      // Prefer exact nickname match; fall back to the API name containing
      // the input name (unidirectional to avoid false positives).
      return (
        (eHomeNick === homeNick || eHomeNorm.includes(homeNorm)) &&
        (eAwayNick === awayNick || eAwayNorm.includes(awayNorm))
      );
    }) ?? null
  );
}

async function fetchOddsApiProps(eventId, market) {
  const cacheKey = `${eventId}:${market}`;
  const cached = oddsApiPropsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const apiKey = getOddsApiRapidApiKey();
  if (!apiKey) return null;

  const apiMarket = ODDS_API_MARKET_MAP[market];
  if (!apiMarket) return null;

  const books = PREFERRED_BOOKMAKERS.join(",");
  const url = `https://${ODDS_API_RAPIDAPI_HOST}/v4/sports/${ODDS_API_SPORT}/events/${encodeURIComponent(eventId)}/odds?regions=us&markets=${apiMarket}&oddsFormat=american&bookmakers=${books}`;
  const response = await fetch(url, {
    headers: getRapidApiHeaders(apiKey, ODDS_API_RAPIDAPI_HOST),
  });
  if (!response.ok) throw new Error(`Odds API props ${response.status}`);
  const data = await response.json();
  oddsApiPropsCache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function extractPlayerPropFromOddsApi(propsData, market, playerName) {
  if (!propsData?.bookmakers?.length || !playerName) return null;

  const playerNorm = normalizeText(playerName);
  const playerTerms = playerNorm.split(" ").filter(Boolean);
  const apiMarket = ODDS_API_MARKET_MAP[market];
  if (!apiMarket) return null;

  const expectedLine = DEFAULT_MARKET_LINES[market];

  for (const bookKey of PREFERRED_BOOKMAKERS) {
    const book = propsData.bookmakers.find((b) => b.key === bookKey);
    if (!book) continue;

    const marketData = book.markets?.find((m) => m.key === apiMarket);
    if (!marketData?.outcomes?.length) continue;

    const overOutcome = marketData.outcomes.find((o) => {
      if (String(o.name ?? "").toLowerCase() !== "over") return false;
      const descNorm = normalizeText(o.description ?? "");
      const nameMatch = playerTerms.length > 0 && playerTerms.every((t) => descNorm.includes(t));
      if (!nameMatch) return false;
      // When both expected line and API line are present they must match within
      // tolerance.  If only one side is missing, accept the outcome — the
      // player+market match is already a strong signal.
      if (expectedLine != null && o.point != null) {
        return Math.abs(o.point - expectedLine) <= LINE_MATCH_TOLERANCE;
      }
      return true;
    });

    if (!overOutcome) continue;

    const odds = parseAmericanOdds(overOutcome.price);
    if (odds == null) continue;

    return {
      marketOdds: odds,
      marketLine: parseLineValue(overOutcome.point) ?? expectedLine,
      provider: book.title ?? bookKey,
      source: "rapidapi-odds",
      eventId: propsData.id,
    };
  }

  return null;
}

async function tryRapidApiOdds(market, playerName, gameContext) {
  const apiKey = getOddsApiRapidApiKey();
  if (!apiKey) return null;

  const { gameDate, homeTeamName, awayTeamName } = gameContext ?? {};
  if (!gameDate || !homeTeamName || !awayTeamName) return null;

  const events = await fetchOddsApiEvents(gameDate);
  if (!Array.isArray(events) || events.length === 0) return null;

  const event = findOddsApiEvent(events, homeTeamName, awayTeamName);
  if (!event) return null;

  const propsData = await fetchOddsApiProps(event.id, market);
  if (!propsData) return null;

  return extractPlayerPropFromOddsApi(propsData, market, playerName);
}


async function verifyJsonOddsRapidApiAccess() {
  const apiKey = getJsonOddsRapidApiKey();
  if (!apiKey) return null;

  const cacheKey = "jsonodds:sports";
  const cached = oddsApiEventCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const response = await fetch(`https://${JSONODDS_RAPIDAPI_HOST}/api/sports`, {
    headers: getRapidApiHeaders(apiKey, JSONODDS_RAPIDAPI_HOST),
  });
  if (!response.ok) throw new Error(`JsonOdds sports ${response.status}`);
  const data = await response.json();
  oddsApiEventCache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

// ── ESPN extraction ──────────────────────────────────────────────────────────

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`ESPN API ${response.status}`);
  return response.json();
}

async function fetchCachedPayload(key, url) {
  const cached = payloadCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const data = await fetchJson(url);
  payloadCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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
      if (payload) {
        return {
          payload,
          source: candidate.key.startsWith("summary:") ? "espn-summary" : "espn-scoreboard",
        };
      }
    } catch {
      // Fall through to next endpoint.
    }
  }
  return null;
}

function extractStrings(record) {
  const keys = [
    "name", "displayName", "shortName", "description", "details",
    "label", "market", "type", "text", "betType", "alternateDisplayValue",
  ];
  return keys.map((key) => record?.[key]).filter(Boolean).join(" ");
}

function extractOddsCandidate(record) {
  if (!record || typeof record !== "object") return null;
  const text = normalizeText(extractStrings(record));
  const marketOdds = [
    record.american, record.americanOdds, record.displayOdds, record.price,
    record.odds, record.value, record.moneyLine,
    record?.awayTeamOdds?.moneyLine, record?.homeTeamOdds?.moneyLine,
  ].map(parseAmericanOdds).find((v) => v != null);
  if (!text || marketOdds == null) return null;
  return {
    text,
    marketOdds,
    marketLine: [
      record.line, record.points, record.total, record.threshold,
      record.overUnder, record.handicap, record.value,
    ].map(parseLineValue).find((v) => v != null) ?? null,
    provider: record?.provider?.name ?? record?.sportsbook?.name ?? "ESPN",
  };
}

function collectOddsCandidates(node, results = []) {
  if (!node || typeof node !== "object") return results;
  if (Array.isArray(node)) {
    node.forEach((e) => collectOddsCandidates(e, results));
    return results;
  }
  const candidate = extractOddsCandidate(node);
  if (candidate) results.push(candidate);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectOddsCandidates(value, results);
  }
  return results;
}

function candidateScore(candidate, market, playerTerms) {
  const text = candidate.text;
  const expectedLine = DEFAULT_MARKET_LINES[market];
  const marketTerms = MARKET_TERMS[market] ?? [];
  let score = 0;
  if (playerTerms.length > 0 && playerTerms.every((t) => text.includes(t))) score += 6;
  else if (playerTerms.some((t) => text.includes(t))) score += 3;
  if (marketTerms.some((t) => text.includes(normalizeText(t)))) score += 4;
  if (expectedLine == null || candidate.marketLine == null) score += 1;
  else if (Math.abs(candidate.marketLine - expectedLine) <= LINE_MATCH_TOLERANCE) score += 2;
  return score;
}

async function tryEspnOdds(gamePk, market, playerName) {
  const response = await getEspnPayload(gamePk);
  if (!response?.payload) return null;

  const candidates = collectOddsCandidates(response.payload);
  if (candidates.length === 0) return null;

  const playerTerms = normalizeText(playerName).split(" ").filter(Boolean);
  const best = candidates
    .map((c) => ({ ...c, score: candidateScore(c, market, playerTerms) }))
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score)[0];

  if (!best) return null;

  const impliedProbability = convertAmericanToImplied(best.marketOdds);
  if (!Number.isFinite(impliedProbability)) return null;

  return {
    marketOdds: best.marketOdds,
    impliedProbability,
    marketLine: best.marketLine ?? DEFAULT_MARKET_LINES[market] ?? null,
    source: response.source,
    provider: best.provider,
    eventId: null,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function fetchRealtimeOdds(gamePk, market, playerName, gameContext) {
  const cacheKey = `${gamePk}:${market}:${normalizeText(playerName)}`;
  const cached = oddsResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  if (!gamePk || !market) {
    return buildFallbackOdds(market, "missing-params");
  }

  // 1. Try RapidAPI / The Odds API (requires VITE_RAPIDAPI_KEY + gameContext)
  try {
    const rapidResult = await tryRapidApiOdds(market, playerName, gameContext);
    if (rapidResult) {
      const impliedProbability = convertAmericanToImplied(rapidResult.marketOdds);
      if (Number.isFinite(impliedProbability)) {
        const value = {
          ...rapidResult,
          impliedProbability,
          fallbackUsed: false,
          fallbackReason: null,
        };
        oddsResultCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }
    }
  } catch {
    // Fall through to ESPN.
  }

  // 2. If the user configured the JsonOdds RapidAPI app, verify the key/host pair
  // before falling through. JsonOdds does not expose MLB player props, so it cannot
  // directly price these player markets; this turns an auth problem into a normal
  // no-match fallback instead of incorrectly reporting a missing-key fallback.
  try {
    await verifyJsonOddsRapidApiAccess();
  } catch {
    // Fall through to ESPN.
  }

  // 3. Try ESPN extraction
  if (playerName) {
    try {
      const espnResult = await tryEspnOdds(gamePk, market, playerName);
      if (espnResult) {
        const value = { ...espnResult, fallbackUsed: false, fallbackReason: null };
        oddsResultCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }
    } catch {
      // Fall through to market defaults.
    }
  }

  // 4. Market-average defaults — mark as fallback so parlays can exclude them
  const fallbackReason = !hasAnyRapidApiKey() ? FALLBACK_REASON_RAPIDAPI_NOT_CONFIGURED : "no-match";
  return buildFallbackOdds(market, fallbackReason);
}
