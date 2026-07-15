const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ODDS_API_HOST = "odds.p.rapidapi.com";
const JSONODDS_HOST = "jsonjames-jsonodds-v1.p.rapidapi.com";

function json(res, status, body) {
  res.status(status).json(body);
}

function rapidHeaders(key, host) {
  return {
    accept: "application/json",
    "x-rapidapi-key": key,
    "x-rapidapi-host": host,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const { provider, operation, gameDate, eventId, market, url } = req.body ?? {};

  try {
    if (provider === "oddsApi") {
      const key = requiredEnv("ODDS_API_RAPIDAPI_KEY");
      if (operation === "events") {
        const from = `${gameDate}T00:00:00Z`;
        const to = `${gameDate}T23:59:59Z`;
        const target = new URL(`https://${ODDS_API_HOST}/v4/sports/baseball_mlb/events`);
        target.searchParams.set("dateFormat", "iso");
        target.searchParams.set("commenceTimeFrom", from);
        target.searchParams.set("commenceTimeTo", to);
        const upstream = await fetch(target, { headers: rapidHeaders(key, ODDS_API_HOST) });
        return json(res, upstream.status, await upstream.json());
      }
      if (operation === "props" && eventId && market) {
        const target = new URL(`https://${ODDS_API_HOST}/v4/sports/baseball_mlb/events/${encodeURIComponent(eventId)}/odds`);
        target.searchParams.set("regions", "us");
        target.searchParams.set("markets", market);
        target.searchParams.set("oddsFormat", "american");
        const upstream = await fetch(target, { headers: rapidHeaders(key, ODDS_API_HOST) });
        return json(res, upstream.status, await upstream.json());
      }
    }

    if (provider === "jsonOdds" && operation === "sports") {
      const key = requiredEnv("JSONODDS_RAPIDAPI_KEY");
      const upstream = await fetch(`https://${JSONODDS_HOST}/api/sports`, {
        headers: rapidHeaders(key, JSONODDS_HOST),
      });
      return json(res, upstream.status, await upstream.json());
    }

    if (provider === "espn" && typeof url === "string" && url.startsWith(`${ESPN_BASE}/`)) {
      const upstream = await fetch(url, { headers: { accept: "application/json" } });
      return json(res, upstream.status, await upstream.json());
    }

    return json(res, 400, { error: "Unsupported provider or operation" });
  } catch (error) {
    const message = String(error?.message ?? error);
    const missing = message.match(/^([A-Z0-9_]+) is not configured$/);
    return json(res, missing ? 503 : 502, {
      error: missing ? "Server provider is not configured" : "Upstream provider request failed",
    });
  }
}
