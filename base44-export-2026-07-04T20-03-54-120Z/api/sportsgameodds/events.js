import { fetchSgo, publicError } from "../_lib/sportsgameodds.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { date, oddsAvailable, limit } = req.query ?? {};
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "date must use YYYY-MM-DD" });
    }

    const result = await fetchSgo("/events", {
      sportID: "BASEBALL",
      leagueID: "MLB",
      startsAfter: date ? `${date}T00:00:00.000Z` : undefined,
      startsBefore: date ? `${date}T23:59:59.999Z` : undefined,
      oddsAvailable,
      limit,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: publicError(error) });
  }
}
