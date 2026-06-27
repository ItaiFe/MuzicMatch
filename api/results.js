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
    const { songs, voters, groupByName } = await readAll();
    const byPerson = {};
    const grpOf = (name) => (groupByName && groupByName[name] === "flamingo" ? "flamingo" : "ext");

    // Build per-song stats, split by group. allMap: songKey -> stats object.
    function emptyRow(songKey) {
      return {
        song: songKey,
        all:      { likes: 0, skips: 0, likedBy: [], skippedBy: [] },
        flamingo: { likes: 0, skips: 0, likedBy: [], skippedBy: [] },
        ext:      { likes: 0, skips: 0, likedBy: [], skippedBy: [] },
      };
    }
    const rows = {};

    for (const [songKey, map] of Object.entries(songs)) {
      const row = rows[songKey] || (rows[songKey] = emptyRow(songKey));
      for (const [name, choice] of Object.entries(map)) {
        const g = grpOf(name);
        const liked = choice === "like";
        for (const bucket of [row.all, row[g]]) {
          if (liked) { bucket.likes++; bucket.likedBy.push(name); }
          else { bucket.skips++; bucket.skippedBy.push(name); }
        }
        if (!byPerson[name]) byPerson[name] = { likes: [], skips: [], group: g };
        (liked ? byPerson[name].likes : byPerson[name].skips).push(songKey);
      }
    }

    // Emit three ranked lists (by likes desc, then fewer skips).
    function rankBy(key) {
      return Object.values(rows)
        .map((r) => ({ song: r.song, likes: r[key].likes, skips: r[key].skips, likedBy: r[key].likedBy, skippedBy: r[key].skippedBy }))
        .filter((r) => r.likes > 0 || r.skips > 0)
        .sort((a, b) => (b.likes - a.likes) || (a.skips - b.skips));
    }

    const uniqueVoters = [...new Set(voters)];
    const flamingoVoters = uniqueVoters.filter((n) => grpOf(n) === "flamingo");
    const extVoters = uniqueVoters.filter((n) => grpOf(n) === "ext");

    res.status(200).json({
      ok: true,
      voters: uniqueVoters,
      counts: { all: uniqueVoters.length, flamingo: flamingoVoters.length, ext: extVoters.length },
      songs: rankBy("all"),                 // back-compat: default = everyone
      songsByGroup: { all: rankBy("all"), flamingo: rankBy("flamingo"), ext: rankBy("ext") },
      byPerson,
    });
  } catch (e) {
    console.error("results error", e);
    res.status(502).json({ ok: false, error: "read failed" });
  }
}
