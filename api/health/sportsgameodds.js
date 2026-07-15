import { fetchSgo, publicError } from "../_lib/sportsgameodds.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const date = String(req.query?.date ?? new Date().toISOString().slice(0, 10));
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must use YYYY-MM-DD" });
  }

  try {
    const result = await fetchSgo("/events", {
      sportID: "baseball",
      leagueID: "MLB",
      date,
      oddsAvailable: "true",
      limit: "1",
    });

    const payload = result.body;
    const events = Array.isArray(payload) ? payload : payload?.data ?? [];
    return res.status(result.status).json({
      ok: result.ok,
      date,
      eventCount: Array.isArray(events) ? events.length : 0,
      apiStatus: result.status,
      responseShape: Array.isArray(payload) ? "array" : typeof payload,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: publicError(error) });
  }
}
