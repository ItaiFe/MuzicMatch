// Public "hottest songs" chart — the top liked songs, ranked, with NO vote
// counts (so it's safe for any logged-in user to see, unlike /api/results
// which is admin-only and exposes counts + who voted).
//
// GET /api/hot?token=...&limit=10
// -> { ok: true, songs: ["Title — Artist", ...] }   (ranked, counts hidden)

import { verifyToken } from "./_auth.js";
import { topLikedSongs, blobConfigured } from "./_store.js";

export default async function handler(req, res) {
  if (!blobConfigured()) {
    res.status(500).json({ ok: false, error: "storage not configured" });
    return;
  }
  // Any logged-in user may view the chart (no admin requirement).
  const token = (req.query.token || "").toString();
  const auth = verifyToken(token, process.env.CAMP_SECRET);
  if (!auth || !auth.name) {
    res.status(401).json({ ok: false, error: "not logged in" });
    return;
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 25) limit = 25;

  try {
    const songs = await topLikedSongs(limit);
    // don't let the result be cached long — it changes as people vote
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, songs });
  } catch (e) {
    console.error("hot error", e);
    res.status(502).json({ ok: false, error: "read failed" });
  }
}
