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
    const result = await fetchSgo(`/events/${encodeURIComponent(eventId)}`, {
      includePlayerProps: "true",
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: publicError(error) });
  }
}
