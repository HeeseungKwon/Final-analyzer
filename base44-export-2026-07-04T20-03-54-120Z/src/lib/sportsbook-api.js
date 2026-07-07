const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Treat lines within roughly one tenth of a unit as equivalent so small API
// representation differences (1.5 vs 1.49/1.6) do not block a usable match.
const LINE_MATCH_TOLERANCE = 0.11;
const MIN_CANDIDATE_SCORE = 7;
const MIN_VALID_AMERICAN_ODDS = 50;
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

const MARKET_TERMS = {
  hit_2: ["hits", "2+ hits", "over 1.5 hits", "player hits"],
  total_bases: ["total bases", "tb", "over 1.5 total bases", "over 1.5 tb"],
  hrr_2: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 1.5 hits runs rbis", "2+ hrr"],
  hrr_3: ["hits+runs+rbi", "h+r+rbi", "hrr", "over 2.5 hits runs rbis", "3+ hrr"],
  home_run: ["home run", "home runs", "to hit a home run", "1+ home run"],
  strikeouts: ["strikeouts", "pitcher strikeouts", "over strikeouts"],
};

const payloadCache = new Map();
const oddsResultCache = new Map();

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

function buildEspnDateKey(gameDate) {
  const match = String(gameDate ?? "").match(ISO_DATE_PATTERN);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

function namesMatch(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);
  const shorter = aTokens.length <= bTokens.length ? aTokens : bTokens;
  const longer = aTokens.length <= bTokens.length ? bTokens : aTokens;
  return shorter.length > 1 && shorter.every((token) => longer.includes(token));
}

function parseAmericanOdds(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) return null;
    const truncated = Math.trunc(value);
    return Math.abs(truncated) >= MIN_VALID_AMERICAN_ODDS ? truncated : null;
  }
  const match = String(value ?? "").match(/([+-]\d{3,4})/);
  if (!match) return null;
  const odds = Number(match[1]);
  return Number.isFinite(odds) && Math.abs(odds) >= MIN_VALID_AMERICAN_ODDS ? odds : null;
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

function buildFallbackOdds(market, fallbackReason = "fallback-default") {
  const impliedProbability = DEFAULT_IMPLIED_PROBABILITIES[market] ?? 0.5;
  return {
    marketOdds: impliedToAmerican(impliedProbability),
    impliedProbability,
    marketLine: DEFAULT_MARKET_LINES[market] ?? null,
    source: "fallback-default",
    provider: "fallback",
    fallbackUsed: true,
    fallbackReason,
    eventId: null,
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

function extractCompetitorNames(event) {
  const competitors = event?.competitions?.flatMap((competition) => competition?.competitors ?? [])
    ?? event?.competitors
    ?? [];
  if (competitors.length === 0) {
    return { home: [], away: [] };
  }

  const home = competitors.find((entry) => entry?.homeAway === "home") ?? competitors[0];
  const away = competitors.find((entry) => entry?.homeAway === "away") ?? competitors[1];

  const namesFor = (entry) => [
    entry?.team?.displayName,
    entry?.team?.shortDisplayName,
    entry?.team?.name,
    entry?.team?.abbreviation,
    entry?.displayName,
    entry?.shortDisplayName,
    entry?.name,
    entry?.abbreviation,
  ].filter(Boolean);

  return {
    home: namesFor(home),
    away: namesFor(away),
  };
}

function findMatchingEvent(scoreboardPayload, gameContext) {
  const events = scoreboardPayload?.events ?? [];
  for (const event of events) {
    const competitors = extractCompetitorNames(event);
    const homeMatch = competitors.home.some((name) => namesMatch(name, gameContext.homeTeamName));
    const awayMatch = competitors.away.some((name) => namesMatch(name, gameContext.awayTeamName));
    if (homeMatch && awayMatch) return event;
  }
  return null;
}

function resolveEspnEventFromGamePk(gamePk) {
  const directEventId = String(gamePk ?? "").trim();
  return directEventId ? { eventId: directEventId, source: "espn-direct-id", payload: null } : null;
}

async function resolveEspnEventFromScheduleContext(gameContext = {}) {
  const ctx = gameContext && typeof gameContext === "object" ? gameContext : {};
  if (!ctx.homeTeamName || !ctx.awayTeamName) return null;
  const dateKey = buildEspnDateKey(ctx.gameDate);
  if (!dateKey) return null;

  try {
    const scoreboardPayload = await fetchCachedPayload(
      `scoreboard-date:${dateKey}`,
      `${ESPN_BASE}/scoreboard?dates=${dateKey}`
    );
    const event = findMatchingEvent(scoreboardPayload, ctx);
    const eventId = String(event?.id ?? event?.uid ?? "").trim();
    return eventId ? { eventId, source: "espn-scoreboard-date", payload: event ?? null } : null;
  } catch {
    return null;
  }
}

async function getEspnPayload(gamePk, gameContext = {}) {
  const attemptedEventIds = new Set();
  const payloads = [];
  const resolvedEvents = [
    resolveEspnEventFromGamePk(gamePk),
    await resolveEspnEventFromScheduleContext(gameContext),
  ].filter(Boolean);

  for (const resolved of resolvedEvents) {
    if (attemptedEventIds.has(resolved.eventId)) continue;
    attemptedEventIds.add(resolved.eventId);

    const urls = [
      { key: `summary:${resolved.eventId}`, url: `${ESPN_BASE}/summary?event=${resolved.eventId}`, source: "espn-summary" },
      { key: `scoreboard:${resolved.eventId}`, url: `${ESPN_BASE}/scoreboard?events=${resolved.eventId}`, source: "espn-scoreboard" },
    ];

    for (const candidate of urls) {
      try {
        const payload = await fetchCachedPayload(candidate.key, candidate.url);
        if (payload) {
          payloads.push({ payload, source: candidate.source, eventId: resolved.eventId });
        }
      } catch {
        // Fall through to the next endpoint or default odds.
      }
    }

    if (resolved.payload) {
      payloads.push({ payload: resolved.payload, source: resolved.source, eventId: resolved.eventId });
    }
  }

  return payloads;
}

function extractStrings(record) {
  const keys = [
    "name",
    "displayName",
    "shortName",
    "fullName",
    "description",
    "details",
    "label",
    "market",
    "type",
    "text",
    "betType",
    "alternateDisplayValue",
  ];

  const directValues = keys
    .map((key) => record?.[key])
    .filter(Boolean)
    .join(" ");

  const nestedEntities = [
    record?.player,
    record?.athlete,
    record?.team,
    record?.competitor,
    record?.participant,
    record?.selection,
    record?.outcome,
  ].flatMap((entity) => {
    if (!entity) return [];
    return Array.isArray(entity) ? entity : [entity];
  });

  const nestedValues = nestedEntities
    .flatMap((entity) => [
      entity?.name,
      entity?.displayName,
      entity?.shortName,
      entity?.fullName,
      entity?.abbreviation,
    ])
    .filter(Boolean)
    .join(" ");

  return [directValues, nestedValues].filter(Boolean).join(" ");
}

function extractOddsCandidate(record) {
  if (!record || typeof record !== "object") return null;

  const text = normalizeText(extractStrings(record));
  // Prefer explicit over/threshold outcome prices before falling back to generic
  // fields so markets like "2+ Hits" or "Over 5.5 Ks" use the side this
  // application actually models.
  const marketOdds = [
    record?.overOdds,
    record?.over?.american,
    record?.over?.americanOdds,
    record?.over?.odds,
    record?.american,
    record?.americanOdds,
    record?.displayOdds,
    record?.price,
    record?.odds,
    record?.value,
    record?.moneyLine,
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

function candidateScore(candidate, market, playerTerms) {
  const text = candidate.text;
  const expectedLine = DEFAULT_MARKET_LINES[market];
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

export async function fetchRealtimeOdds(gamePk, market, playerName, gameContext = {}) {
  const cacheKey = `${gamePk}:${market}:${normalizeText(playerName)}`;
  const cached = oddsResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const baseFallback = buildFallbackOdds(market);
  const fallback = (reason) => ({ ...baseFallback, fallbackReason: reason });

  if (!gamePk || !market || !playerName) {
    return fallback("missing-lookup-input");
  }

  try {
    const playerTerms = normalizeText(playerName).split(" ").filter(Boolean);
    const responses = await getEspnPayload(gamePk, gameContext);
    if (!responses.length) return fallback("espn-payload-unavailable");

    let sawCandidates = false;
    let sawScoredCandidate = false;

    for (const response of responses) {
      const candidates = collectOddsCandidates(response.payload);
      if (candidates.length === 0) continue;
      sawCandidates = true;

      const best = candidates
        .map((candidate) => ({
          ...candidate,
          score: candidateScore(candidate, market, playerTerms),
        }))
        .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
        .sort((a, b) => b.score - a.score)[0];

      if (!best) continue;
      sawScoredCandidate = true;

      const impliedProbability = convertAmericanToImplied(best.marketOdds);
      if (!Number.isFinite(impliedProbability)) continue;

      const value = {
        marketOdds: best.marketOdds,
        impliedProbability,
        marketLine: best.marketLine ?? baseFallback.marketLine,
        source: response.source,
        provider: best.provider,
        fallbackUsed: false,
        fallbackReason: null,
        eventId: response.eventId ?? null,
      };
      oddsResultCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return value;
    }

    if (!sawCandidates) return fallback("espn-no-odds-candidates");
    if (!sawScoredCandidate) return fallback("espn-no-matching-player-prop");
    return fallback("espn-invalid-market-odds");
  } catch {
    return fallback("espn-request-failed");
  }
}
