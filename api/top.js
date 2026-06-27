// Live "top music" deck. Fetches YouTube's most-popular music videos for a
// region, maps them into the app's song shape, and CACHES the result in Blob
// so repeat visitors don't each cost YouTube quota.
//
// GET /api/top            -> { ok, songs, source, fetchedAt }
// GET /api/top?refresh=1  -> force a fresh fetch (ignores cache age)
//
// Cache: songs/top.json in Blob, refreshed at most once per CACHE_HOURS.

import { put, list } from "@vercel/blob";

const CACHE_HOURS = 12;
const MAX = 40;

const COLORS = ["#E8623B", "#F2A43B", "#2BB3A3", "#7A5CB0", "#9B59B6", "#E8623B"];
const CACHE_PATH = "songs/top.json";

function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function fetchJson(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
    cache: "no-store",
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// Pull the cached deck if it's fresh enough.
async function readCache() {
  if (!blobConfigured()) return null;
  try {
    const { blobs } = await list({ prefix: CACHE_PATH, limit: 1 });
    if (!blobs || !blobs.length || blobs[0].pathname !== CACHE_PATH) return null;
    const data = await fetchJson(blobs[0].url);
    if (!data || !data.fetchedAt || !Array.isArray(data.songs)) return null;
    const ageHrs = (Date.now() - data.fetchedAt) / 3600000;
    if (ageHrs > CACHE_HOURS) return { ...data, stale: true };
    return data;
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  if (!blobConfigured()) return;
  try {
    await put(CACHE_PATH, JSON.stringify(payload), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
  } catch (e) {
    console.error("top cache write failed", e);
  }
}

// "Artist - Title (Official Video)" -> { artist, title }
function parseTitle(rawTitle, channel) {
  let t = rawTitle
    .replace(/\(.*?\)|\[.*?\]/g, " ")               // drop (Official Video) etc.
    .replace(/official\s*(music)?\s*video|lyric video|audio|visualizer|m\/v/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  let artist = channel.replace(/VEVO/i, "").replace(/\s*-\s*Topic$/i, "").trim();
  let title = t;
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    artist = dash[0].trim();
    title = dash.slice(1).join(" - ").trim();
  }
  return { artist: artist.slice(0, 60), title: title.slice(0, 80) };
}

async function fetchChart(key, region, isIsraeli) {
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    "?part=snippet&chart=mostPopular&videoCategoryId=10" +
    "&maxResults=" + MAX +
    "&regionCode=" + encodeURIComponent(region) +
    "&key=" + key;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text();
    throw new Error("youtube " + r.status + " " + body.slice(0, 200));
  }
  const data = await r.json();
  const songs = [];
  for (const item of data.items || []) {
    const sn = item.snippet || {};
    if (!sn.title || !sn.channelTitle) continue;
    const { artist, title } = parseTitle(sn.title, sn.channelTitle);
    if (!title) continue;
    songs.push({
      s: title,
      a: artist,
      c: isIsraeli ? "Israel" : "",
      f: isIsraeli ? "🇮🇱" : "🎵",
      g: isIsraeli ? "Israel chart" : "Top music",
      col: COLORS[songs.length % COLORS.length],
      vid: item.id,
      il: isIsraeli ? 1 : 0,
    });
  }
  return songs;
}

// De-dup by video id (a song can chart in both IL and global).
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (s.vid && seen.has(s.vid)) continue;
    if (s.vid) seen.add(s.vid);
    out.push(s);
  }
  return out;
}

// Interleave so every 3rd card (positions 3,6,9...) is Israeli, the rest
// global. Falls back gracefully if one list runs short.
function interleave(global, israeli) {
  const out = [];
  let gi = 0, ii = 0;
  let pos = 0;
  const total = global.length + israeli.length;
  while (out.length < total) {
    pos++;
    const wantIsraeli = pos % 3 === 0;
    if (wantIsraeli && ii < israeli.length) {
      out.push(israeli[ii++]);
    } else if (gi < global.length) {
      out.push(global[gi++]);
    } else if (ii < israeli.length) {
      out.push(israeli[ii++]);
    } else {
      break;
    }
  }
  return dedupe(out);
}

async function fetchTop(key) {
  const globalRegion = process.env.TOP_REGION || "US";
  // fetch both charts; if the IL one fails, we still return global
  const globalSongs = await fetchChart(key, globalRegion, false);
  let israeliSongs = [];
  try {
    israeliSongs = await fetchChart(key, "IL", true);
  } catch (e) {
    console.error("IL chart fetch failed, using global only", e);
  }
  // remove any IL song whose video also appears in global (keep IL-tagged)
  const ilVids = new Set(israeliSongs.map((s) => s.vid));
  const globalOnly = globalSongs.filter((s) => !ilVids.has(s.vid));
  return interleave(globalOnly, israeliSongs);
}

export default async function handler(req, res) {
  const force = req.query.refresh === "1";

  // 1) serve fresh cache when possible
  if (!force) {
    const cached = await readCache();
    if (cached && !cached.stale) {
      res.setHeader("Cache-Control", "s-maxage=600");
      res.status(200).json({
        ok: true,
        songs: cached.songs,
        source: "cache",
        fetchedAt: cached.fetchedAt,
      });
      return;
    }
  }

  // 2) need a fresh fetch
  const key = process.env.YT_API_KEY;
  if (!key) {
    // no key — fall back to whatever cache we have, even stale
    const cached = await readCache();
    if (cached) {
      res.status(200).json({ ok: true, songs: cached.songs, source: "stale-cache", fetchedAt: cached.fetchedAt });
      return;
    }
    res.status(500).json({ ok: false, error: "no YT_API_KEY and no cache" });
    return;
  }

  try {
    const songs = await fetchTop(key);
    if (!songs.length) throw new Error("empty chart");
    const payload = { songs, fetchedAt: Date.now(), region: process.env.TOP_REGION || "US" };
    await writeCache(payload);
    res.status(200).json({ ok: true, songs, source: "youtube", fetchedAt: payload.fetchedAt });
  } catch (e) {
    console.error("top fetch error", e);
    // fall back to stale cache if the live fetch fails
    const cached = await readCache();
    if (cached) {
      res.status(200).json({ ok: true, songs: cached.songs, source: "stale-cache", fetchedAt: cached.fetchedAt });
      return;
    }
    res.status(502).json({ ok: false, error: "fetch failed: " + e.message });
  }
}
