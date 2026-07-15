const SGO_BASE_URL = "https://api.sportsgameodds.com/v2";

function getApiKey() {
  const key = process.env.SPORTSGAMEODDS_API_KEY;
  if (!key || !key.trim()) {
    throw new Error("SPORTSGAMEODDS_API_KEY is not configured");
  }
  return key.trim();
}

function buildHeaders() {
  return {
    accept: "application/json",
    "x-api-key": getApiKey(),
  };
}

export async function fetchSgo(path, searchParams = {}) {
  const url = new URL(`${SGO_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  console.info("[SportsGameOdds] upstream URL:", url.toString());
  const response = await fetch(url, { headers: buildHeaders() });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return {
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    body,
  };
}

export function publicError(error) {
  const message = String(error?.message ?? error);
  return message.includes("not configured")
    ? "SportsGameOdds server key is not configured"
    : "SportsGameOdds request failed";
}
