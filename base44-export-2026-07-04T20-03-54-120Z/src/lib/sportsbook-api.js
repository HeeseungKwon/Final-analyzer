// Real-time MLB sportsbook odds.
//
// Priority chain:
//   1. SportsGameOdds         (when VITE_SPORTSGAMEODDS_API_KEY is configured)
//   2. The Odds API via RapidAPI  (when VITE_RAPIDAPI_KEY is configured)
//   3. JsonOdds via RapidAPI      (when VITE_JSONODDS_RAPIDAPI_KEY or VITE_RAPIDAPI_KEY is configured)
//   4. ESPN summary / scoreboard API extraction
//   5. Market-average defaults    (fallbackUsed: true, fallbackReason set)
//
// SportsGameOdds snapshot layer:
//   - Odds are fetched per-game (event-level), never player-by-player.
//   - Each game's full response is stored in localStorage under key:
//       sgo_snapshot:<YYYY-MM-DD>
//   - The snapshot is reused for the entire day.  A new calendar day
//     automatically produces a fresh snapshot on the first fetch.
//   - Pass refreshOdds: true to forcibly bypass the snapshot for today.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ODDS_API_RAPIDAPI_HOST = "odds.p.rapidapi.com";
const JSONODDS_RAPIDAPI_HOST = "jsonjames-jsonodds-v1.p.rapidapi.com";
const ODDS_API_SPORT = "baseball_mlb";

// SportsGameOdds base URL (see https://sportsgameodds.com/docs/basics/setup)
const SGO_PROXY_BASE = "/api/sportsgameodds";
const SGO_SPORT = "baseball";
const SGO_LEAGUE = "MLB";

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

// Maps internal market names → SportsGameOdds stat/prop identifiers.
// SGO uses "statID" notation; "over" side is extracted from the odds object.
// See https://sportsgameodds.com/docs/endpoints/events#player-props
const SGO_MARKET_MAP = {
  hit_2: { statID: "hits", line: 1.5 },
  total_bases: { statID: "total_bases", line: 1.5 },
  hrr_2: { statID: "hits_runs_rbis", line: 1.5 },
  hrr_3: { statID: "hits_runs_rbis", line: 2.5 },
  home_run: { statID: "home_runs", line: 0.5 },
  strikeouts: { statID: "strikeouts", line: 5.5 },
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

// In-memory caches (session lifetime)
const payloadCache = new Map();       // ESPN payload cache
const oddsResultCache = new Map();    // Final odds result cache (per-player-market-game)
const oddsApiEventCache = new Map();  // RapidAPI events list cache (key: date)
const oddsApiPropsCache = new Map();  // RapidAPI props cache (key: eventId:market)
// SGO in-memory event cache (prevents duplicate fetches within one run)
const sgoEventCache = new Map();      // key: sgoEventId → full event object

// ── localStorage snapshot helpers ────────────────────────────────────────────

const SNAPSHOT_KEY_PREFIX = "sgo_snapshot:";
const SNAPSHOT_META_PREFIX = "sgo_snapshot_meta:";

function snapshotKey(dateStr) {
  return `${SNAPSHOT_KEY_PREFIX}${dateStr}`;
}

function snapshotMetaKey(dateStr) {
  return `${SNAPSHOT_META_PREFIX}${dateStr}`;
}

/**
 * Load the full daily snapshot from localStorage.
 * Returns { events: Map<sgoEventId, eventData>, meta: { date, fetchedAt, sportsbooks } }
 * or null if no snapshot exists.
 */
function loadSnapshot(dateStr) {
  try {
    const raw = localStorage.getItem(snapshotKey(dateStr));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const metaRaw = localStorage.getItem(snapshotMetaKey(dateStr));
    const meta = metaRaw ? JSON.parse(metaRaw) : { date: dateStr, fetchedAt: null, sportsbooks: [] };
    // Hydrate the in-memory event cache from the snapshot
    for (const [id, data] of Object.entries(parsed.events ?? {})) {
      sgoEventCache.set(id, data);
    }
    return { events: parsed.events ?? {}, meta };
  } catch {
    return null;
  }
}

/**
 * Persist one event into today's snapshot.
 * If the snapshot already exists the event is merged in.
 */
function saveEventToSnapshot(dateStr, sgoEventId, eventData, sportsbooks) {
  try {
    const key = snapshotKey(dateStr);
    const existing = (() => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : { events: {} };
      } catch {
        return { events: {} };
      }
    })();
    existing.events[sgoEventId] = eventData;
    localStorage.setItem(key, JSON.stringify(existing));

    // Update metadata
    const metaKey = snapshotMetaKey(dateStr);
    const existingMeta = (() => {
      try {
        const raw = localStorage.getItem(metaKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    })();
    const now = new Date().toISOString();
    const allBooks = Array.from(
      new Set([...(existingMeta?.sportsbooks ?? []), ...(sportsbooks ?? [])])
    );
    localStorage.setItem(
      metaKey,
      JSON.stringify({
        date: dateStr,
        fetchedAt: existingMeta?.fetchedAt ?? now,
        lastUpdatedAt: now,
        sportsbooks: allBooks,
      })
    );
  } catch {
    // localStorage may be unavailable in some environments — silently skip.
  }
}

/**
 * Replace today's entire snapshot (used by manual refresh).
 */
function clearSnapshot(dateStr) {
  try {
    localStorage.removeItem(snapshotKey(dateStr));
    localStorage.removeItem(snapshotMetaKey(dateStr));
    // Also clear in-memory caches so fresh data is used immediately
    sgoEventCache.clear();
    oddsResultCache.clear();
  } catch {}
}

/**
 * Read snapshot metadata for a given date (for the UI).
 * Returns { date, fetchedAt, lastUpdatedAt, sportsbooks } or null.
 */
export function getSnapshotMeta(dateStr) {
  try {
    const raw = localStorage.getItem(snapshotMetaKey(dateStr));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Force a full refresh: clear the snapshot then re-run the analysis.
 * Callers should pass refreshOdds: true to fetchRealtimeOdds.
 */
export function refreshSnapshot(dateStr) {
  clearSnapshot(dateStr);
}

// ── Utility functions ─────────────────────────────────────────────────────────

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

function hasSgoProxy() {
  return typeof window !== "undefined";
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

// ── SportsGameOdds integration ────────────────────────────────────────────────

/**
 * Fetch today's MLB events list from SportsGameOdds.
 * Returns the raw array of event objects (each has eventID, teams, etc.).
 * This is a lightweight listing call — props are fetched per event separately.
 */
async function fetchSGOEvents(gameDate) {
  if (!hasSgoProxy()) return null;

  const params = new URLSearchParams({ date: gameDate, sportID: "baseball", leagueID: "MLB" });
  const response = await fetch(`${SGO_PROXY_BASE}/events?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SportsGameOdds proxy events ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : (data?.data ?? []);
}

/**
 * Fetch the full player-props for a specific SGO event.
 * The complete response is stored in the snapshot so it is reused for all
 * player lookups within that game — we never fetch the same event twice per day.
 */
async function fetchSGOEventProps(sgoEventId, gameDate, forceRefresh = false) {
  if (!forceRefresh && sgoEventCache.has(sgoEventId)) {
    return sgoEventCache.get(sgoEventId);
  }
  if (!hasSgoProxy()) return null;

  const response = await fetch(`${SGO_PROXY_BASE}/events/${encodeURIComponent(sgoEventId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SportsGameOdds proxy event props ${response.status}`);
  const data = await response.json();
  const eventData = data?.data ?? data;
  sgoEventCache.set(sgoEventId, eventData);
  const books = extractBookmakerNamesFromSGOEvent(eventData);
  saveEventToSnapshot(gameDate, sgoEventId, eventData, books);
  return eventData;
}

/** Extract unique bookmaker names from an SGO event object (for snapshot metadata). */
function extractBookmakerNamesFromSGOEvent(eventData) {
  if (!eventData) return [];
  const books = new Set();
  // SGO embeds odds under eventData.playerProps[].odds[] or eventData.odds[]
  // Structure may vary; we walk known paths
  const propsArr = eventData?.playerProps ?? eventData?.props ?? [];
  for (const prop of propsArr) {
    for (const odd of prop?.odds ?? []) {
      if (odd?.sportsbook) books.add(odd.sportsbook);
    }
  }
  return Array.from(books);
}

/**
 * Match the SGO events list to a specific game by team name.
 */
function findSGOEvent(events, homeTeamName, awayTeamName) {
  if (!Array.isArray(events) || events.length === 0) return null;
  if (!homeTeamName || !awayTeamName) return null;

  const extractNickname = (s) => s.split(" ").filter(Boolean).at(-1) ?? "";
  const homeNorm = normalizeTeamName(homeTeamName);
  const awayNorm = normalizeTeamName(awayTeamName);
  const homeNick = extractNickname(homeNorm);
  const awayNick = extractNickname(awayNorm);

  return (
    events.find((e) => {
      // SGO uses homeTeam / awayTeam or teams.home / teams.away
      const eHome = normalizeTeamName(e.homeTeam ?? e.teams?.home?.name ?? "");
      const eAway = normalizeTeamName(e.awayTeam ?? e.teams?.away?.name ?? "");
      const eHomeNick = extractNickname(eHome);
      const eAwayNick = extractNickname(eAway);
      return (
        (eHomeNick === homeNick || eHome.includes(homeNorm)) &&
        (eAwayNick === awayNick || eAway.includes(awayNorm))
      );
    }) ?? null
  );
}

/**
 * Extract the over-line odds for a specific player + market from an SGO event.
 *
 * SGO player props structure (from docs):
 *   eventData.playerProps = [
 *     {
 *       playerID, playerName, statID, line,
 *       odds: [{ sportsbook, overOdds, underOdds, ... }, ...]
 *     }, ...
 *   ]
 *
 * We prefer the first sportsbook that matches PREFERRED_BOOKMAKERS order.
 */
function extractPlayerPropFromSGO(eventData, market, playerName) {
  if (!eventData || !playerName) return null;

  const marketConfig = SGO_MARKET_MAP[market];
  if (!marketConfig) return null;

  const playerNorm = normalizeText(playerName);
  const playerTerms = playerNorm.split(" ").filter(Boolean);
  const expectedLine = marketConfig.line;

  // The props array may live at different paths depending on the SGO response shape
  const propsArr = eventData?.playerProps ?? eventData?.props ?? [];
  if (!Array.isArray(propsArr) || propsArr.length === 0) return null;

  // Filter props by statID first
  const statMatches = propsArr.filter((prop) => {
    const sid = String(prop?.statID ?? "").toLowerCase();
    return sid === marketConfig.statID || sid.replace(/_/g, "") === marketConfig.statID.replace(/_/g, "");
  });
  if (statMatches.length === 0) return null;

  // Among statID matches, find the best player name match
  const candidatesWithScore = statMatches.map((prop) => {
    const pNorm = normalizeText(prop?.playerName ?? "");
    const fullMatch = playerTerms.length > 0 && playerTerms.every((t) => pNorm.includes(t));
    const partialMatch = playerTerms.some((t) => pNorm.includes(t));
    const lineMatch =
      prop.line != null
        ? Math.abs(Number(prop.line) - expectedLine) <= LINE_MATCH_TOLERANCE
        : true;
    const score = (fullMatch ? 6 : partialMatch ? 2 : 0) + (lineMatch ? 2 : 0);
    return { prop, score };
  });

  const best = candidatesWithScore
    .filter((c) => c.score >= 6) // require full name match
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;

  const prop = best.prop;

  // Pick the preferred sportsbook's over odds
  const oddsArr = prop?.odds ?? [];
  for (const bookKey of PREFERRED_BOOKMAKERS) {
    const bookOdds = oddsArr.find(
      (o) => String(o?.sportsbook ?? "").toLowerCase().replace(/\s+/g, "") === bookKey
    );
    if (!bookOdds) continue;
    // SGO may use overOdds / over / price / americanOver
    const rawOdds =
      bookOdds.overOdds ?? bookOdds.over ?? bookOdds.price ?? bookOdds.americanOver ?? null;
    const odds = parseAmericanOdds(rawOdds);
    if (odds == null) continue;
    const impliedProbability = convertAmericanToImplied(odds);
    if (!Number.isFinite(impliedProbability)) continue;

    return {
      marketOdds: odds,
      impliedProbability,
      marketLine: parseLineValue(prop.line) ?? expectedLine,
      source: "sgo",
      provider: bookOdds.sportsbook ?? bookKey,
      fallbackUsed: false,
      fallbackReason: null,
      eventId: eventData?.eventID ?? eventData?.id ?? null,
    };
  }

  // No preferred book found — use any available book
  for (const bookOdds of oddsArr) {
    const rawOdds =
      bookOdds.overOdds ?? bookOdds.over ?? bookOdds.price ?? bookOdds.americanOver ?? null;
    const odds = parseAmericanOdds(rawOdds);
    if (odds == null) continue;
    const impliedProbability = convertAmericanToImplied(odds);
    if (!Number.isFinite(impliedProbability)) continue;

    return {
      marketOdds: odds,
      impliedProbability,
      marketLine: parseLineValue(prop.line) ?? expectedLine,
      source: "sgo",
      provider: bookOdds.sportsbook ?? "unknown",
      fallbackUsed: false,
      fallbackReason: null,
      eventId: eventData?.eventID ?? eventData?.id ?? null,
    };
  }

  return null;
}

/**
 * Main SportsGameOdds lookup.
 *
 * Flow:
 *   1. Check localStorage snapshot for today's date.
 *   2. If the event is already in the snapshot (and not forceRefresh), use it.
 *   3. Otherwise: fetch events list → find matching event → fetch full props → save snapshot.
 *   4. Extract the player prop from the (now-cached) event data.
 */
async function trySGOOdds(market, playerName, gameContext, forceRefresh = false) {
  const apiKey = getSGOApiKey();
  if (!hasSgoProxy()) return null;

  const { gameDate, homeTeamName, awayTeamName } = gameContext ?? {};
  if (!gameDate || !homeTeamName || !awayTeamName) return null;

  // Try to serve from snapshot first
  if (!forceRefresh) {
    const snapshot = loadSnapshot(gameDate);
    if (snapshot) {
      // Look for this game's event in the snapshot
      const snapshotEventData = Object.values(snapshot.events).find((eventData) => {
        const eHome = normalizeTeamName(eventData?.homeTeam ?? eventData?.teams?.home?.name ?? "");
        const eAway = normalizeTeamName(eventData?.awayTeam ?? eventData?.teams?.away?.name ?? "");
        const homeNorm = normalizeTeamName(homeTeamName);
        const awayNorm = normalizeTeamName(awayTeamName);
        return (
          (eHome.includes(homeNorm) || normalizeTeamName(homeTeamName).includes(eHome)) &&
          (eAway.includes(awayNorm) || normalizeTeamName(awayTeamName).includes(eAway))
        );
      });
      if (snapshotEventData) {
        // Also update in-memory cache
        const eid = snapshotEventData?.eventID ?? snapshotEventData?.id;
        if (eid) sgoEventCache.set(eid, snapshotEventData);
        return extractPlayerPropFromSGO(snapshotEventData, market, playerName);
      }
    }
  }

  // Snapshot miss (or forceRefresh) → fetch from API
  const events = await fetchSGOEvents(gameDate);
  if (!Array.isArray(events) || events.length === 0) return null;

  const matchedEvent = findSGOEvent(events, homeTeamName, awayTeamName);
  if (!matchedEvent) return null;

  const sgoEventId = matchedEvent.eventID ?? matchedEvent.id;
  if (!sgoEventId) return null;

  const eventData = await fetchSGOEventProps(sgoEventId, gameDate, forceRefresh);
  if (!eventData) return null;

  return extractPlayerPropFromSGO(eventData, market, playerName);
}

// ── RapidAPI / The Odds API integration ──────────────────────────────────────

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

// ── ESPN extraction ───────────────────────────────────────────────────────────

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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch real-time odds for a player/market/game.
 *
 * @param {number|string} gamePk  MLB Stats API game PK
 * @param {string} market         Internal market key (hit_2, home_run, etc.)
 * @param {string} playerName     Full player name
 * @param {object} gameContext    { gameDate, homeTeamName, awayTeamName }
 * @param {object} [opts]         { refreshOdds: boolean } — when true, bypass snapshot
 */
export async function fetchRealtimeOdds(gamePk, market, playerName, gameContext, opts = {}) {
  const refreshOdds = Boolean(opts?.refreshOdds);
  const cacheKey = `${gamePk}:${market}:${normalizeText(playerName)}`;

  // In-memory per-run result cache (reset when refreshOdds clears sgoEventCache)
  if (!refreshOdds) {
    const cached = oddsResultCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  if (!gamePk || !market) {
    return buildFallbackOdds(market, "missing-params");
  }

  // 1. SportsGameOdds (snapshot-backed, event-level fetch)
  if (hasSgoProxy()) {
    try {
      const sgoResult = await trySGOOdds(market, playerName, gameContext, refreshOdds);
      if (sgoResult) {
        oddsResultCache.set(cacheKey, { value: sgoResult, expiresAt: Date.now() + CACHE_TTL_MS });
        return sgoResult;
      }
    } catch {
      // Fall through to next provider.
    }
  }

  // 2. Try RapidAPI / The Odds API (requires VITE_RAPIDAPI_KEY + gameContext)
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

  // 3. If the user configured the JsonOdds RapidAPI app, verify the key/host pair
  try {
    await verifyJsonOddsRapidApiAccess();
  } catch {
    // Fall through to ESPN.
  }

  // 4. Try ESPN extraction
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

  // 5. Market-average defaults — mark as fallback so parlays can exclude them
  const fallbackReason = !hasAnyRapidApiKey() && !hasSgoProxy()
    ? FALLBACK_REASON_RAPIDAPI_NOT_CONFIGURED
    : "no-match";
  return buildFallbackOdds(market, fallbackReason);
}
