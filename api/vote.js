// Record a vote. Requires a valid token from /api/login.
//
// POST /api/vote  body: { token, song, artist, choice }
//   choice = "like" | "skip"
// -> { ok: true }

import { verifyToken } from "./_auth.js";
import { recordVote, kvConfigured } from "./_kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "use POST" });
    return;
  }
  if (!kvConfigured()) {
    res.status(500).json({ ok: false, error: "storage not configured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const auth = verifyToken(body.token, process.env.CAMP_SECRET);
  if (!auth || !auth.name) {
    res.status(401).json({ ok: false, error: "not logged in" });
    return;
  }

  const song = (body.song || "").toString().trim().slice(0, 120);
  const artist = (body.artist || "").toString().trim().slice(0, 120);
  const choice = body.choice === "like" ? "like" : "skip";
  if (!song) {
    res.status(400).json({ ok: false, error: "missing song" });
    return;
  }

  const songKey = (song + " — " + artist).slice(0, 200);

  try {
    await recordVote(songKey, auth.name, choice);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("vote error", e);
    res.status(502).json({ ok: false, error: "store failed" });
  }
}
