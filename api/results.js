// Aggregated results for the camp. Requires a valid login token.
//
// GET /api/results?token=...
// -> {
//      ok: true,
//      voters: [name, ...],
//      songs: [{ song, likes, skips, likedBy:[name], skippedBy:[name] }],
//      byPerson: { name: { likes:[song], skips:[song] } }
//    }

import { verifyToken } from "./_auth.js";
import { readAll, blobConfigured } from "./_store.js";

export default async function handler(req, res) {
  if (!blobConfigured()) {
    res.status(500).json({ ok: false, error: "storage not configured" });
    return;
  }
  const token = (req.query.token || "").toString();
  const auth = verifyToken(token, process.env.CAMP_SECRET);
  if (!auth) {
    res.status(401).json({ ok: false, error: "not logged in" });
    return;
  }
  if (!auth.admin) {
    res.status(403).json({ ok: false, error: "admin only" });
    return;
  }

  try {
    const { songs, voters } = await readAll();
    const songRows = [];
    const byPerson = {};

    for (const [songKey, map] of Object.entries(songs)) {
      const likedBy = [];
      const skippedBy = [];
      for (const [name, choice] of Object.entries(map)) {
        if (choice === "like") likedBy.push(name);
        else skippedBy.push(name);
        if (!byPerson[name]) byPerson[name] = { likes: [], skips: [] };
        (choice === "like" ? byPerson[name].likes : byPerson[name].skips).push(
          songKey
        );
      }
      songRows.push({
        song: songKey,
        likes: likedBy.length,
        skips: skippedBy.length,
        likedBy,
        skippedBy,
      });
    }

    songRows.sort((a, b) => b.likes - a.likes);

    const uniqueVoters = [...new Set(voters)];
    res.status(200).json({ ok: true, voters: uniqueVoters, songs: songRows, byPerson });
  } catch (e) {
    console.error("results error", e);
    res.status(502).json({ ok: false, error: "read failed" });
  }
}
