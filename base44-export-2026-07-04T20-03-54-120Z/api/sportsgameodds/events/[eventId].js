import { fetchSgo, publicError } from "../../_lib/sportsgameodds.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const eventId = String(req.query?.eventId ?? "").trim();
  if (!eventId || eventId.includes("/") || eventId.length > 200) {
    return res.status(400).json({ error: "Invalid eventId" });
  }

  try {
    // SportsGameOdds v2 retrieves a single event through GET /events
    // with eventID and includePlayerProps query parameters.
    const result = await fetchSgo("/events", {
      eventID: eventId,
      includePlayerProps: "true",
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: publicError(error) });
  }
}
