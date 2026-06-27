// Builds the swipe deck: song LIST from YouTube charts (good regional/Israel
// data), AUDIO from Deezer previews resolved at build time. Songs Deezer
// can't match keep their YouTube video id and play the full song via embed.
//
// GET /api/top            -> { ok, songs, source, fetchedAt }
// GET /api/top?refresh=1  -> force a fresh fetch
//
// Cached in Blob (songs/top.json) so the YouTube quota + Deezer lookups
// happen at most once per CACHE_HOURS, not per visitor.

// Lazy-load @vercel/blob so a load failure is catchable (clean fallback)
// rather than crashing the whole function with a 502.
let _blob = null;
async function blob() {
  if (_blob) return _blob;
  _blob = await import("@vercel/blob");
  return _blob;
}

const CACHE_HOURS = 12;
const DECK_VERSION = 10;   // bump when song shape changes (forces cache rebuild)
const MAX = 50;           // YouTube mostPopular caps at 50 per region
const PER_DECADE = 40;    // how many to pull from each Deezer decade playlist
const COLORS = ["#E8623B", "#F2A43B", "#2BB3A3", "#7A5CB0", "#9B59B6", "#E8623B"];
const CACHE_PATH = "songs/top.json";

// Deezer playlists with preview + album art built in — no YouTube matching
// needed. "Decades" series (Topsify) plus a Eurovision classics playlist.
// Override any of them via env var if you want different curation.
const DECADES = [
  { tag: "80s",  g: "80s",   playlist: process.env.DZ_80S  || "1321696237"  },
  { tag: "90s",  g: "90s",   playlist: process.env.DZ_90S  || "11798812881" },
  { tag: "00s",  g: "2000s", playlist: process.env.DZ_00S  || "11153531204" },
  { tag: "10s",  g: "2010s", playlist: process.env.DZ_10S  || "11153461484" },
  { tag: "esc",  g: "Eurovision", playlist: process.env.DZ_ESC || "4789690368" },
];

function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function fetchJson(url, bust) {
  const u = bust ? url + (url.includes("?") ? "&" : "?") + "t=" + Date.now() : url;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// Read a private blob's JSON by pathname (using the store token).
async function readPrivateJson(pathname) {
  try {
    const { get } = await blob();
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch { return null; }
}

/* ---------- Blob cache (private store) ---------- */
async function readCache() {
  if (!blobConfigured()) return null;
  try {
    const data = await readPrivateJson(CACHE_PATH);
    if (!data || !data.fetchedAt || !Array.isArray(data.songs)) return null;
    // invalidate caches written by an older deck schema (no previews etc.)
    if (data.v !== DECK_VERSION) return { ...data, stale: true };
    const ageHrs = (Date.now() - data.fetchedAt) / 3600000;
    if (ageHrs > CACHE_HOURS) return { ...data, stale: true };
    return data;
  } catch { return null; }
}
async function writeCache(payload) {
  if (!blobConfigured()) return;
  try {
    const { put } = await blob();
    await put(CACHE_PATH, JSON.stringify(payload), {
      access: "private", contentType: "application/json",
      allowOverwrite: true, addRandomSuffix: false,
    });
  } catch (e) { console.error("top cache write failed", e); }
}

/* ---------- YouTube: the song list ---------- */
function parseTitle(rawTitle, channel) {
  let t = rawTitle
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/official\s*(music)?\s*video|lyric video|audio|visualizer|m\/v/gi, " ")
    .replace(/\s+/g, " ").trim();
  let artist = channel.replace(/VEVO/i, "").replace(/\s*-\s*Topic$/i, "").trim();
  let title = t;
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) { artist = dash[0].trim(); title = dash.slice(1).join(" - ").trim(); }
  return { artist: artist.slice(0, 60), title: title.slice(0, 80) };
}

async function ytChart(key, region, isIsraeli) {
  if (!key) return [];   // no YouTube key — skip, deck builds from Deezer
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    "?part=snippet&chart=mostPopular&videoCategoryId=10" +
    "&maxResults=" + MAX + "&regionCode=" + encodeURIComponent(region) +
    "&key=" + key;
  const r = await fetch(url);
  if (!r.ok) { const b = await r.text(); throw new Error("youtube " + r.status + " " + b.slice(0, 160)); }
  const data = await r.json();
  const out = [];
  for (const item of data.items || []) {
    const sn = item.snippet || {};
    if (!sn.title || !sn.channelTitle) continue;
    const { artist, title } = parseTitle(sn.title, sn.channelTitle);
    if (!title) continue;
    out.push({
      s: title, a: artist,
      c: isIsraeli ? "Israel" : "",
      f: isIsraeli ? "🇮🇱" : "🎵",
      g: isIsraeli ? "Israel chart" : "Top music",
      col: COLORS[out.length % COLORS.length],
      vid: item.id,          // YouTube fallback
      il: isIsraeli ? 1 : 0,
    });
  }
  return out;
}

/* ---------- Deezer: resolve a preview for one song ---------- */
async function deezerPreview(song) {
  // strict-ish search: track + artist
  const q = encodeURIComponent(`track:"${song.s}" artist:"${song.a}"`);
  let data = await fetchJson("https://api.deezer.com/search?q=" + q + "&limit=1");
  let hit = data && data.data && data.data[0];
  if (!hit || !hit.preview) {
    // looser fallback: plain text search
    const q2 = encodeURIComponent(`${song.s} ${song.a}`);
    data = await fetchJson("https://api.deezer.com/search?q=" + q2 + "&limit=1");
    hit = data && data.data && data.data[0];
  }
  if (hit && hit.preview) {
    return {
      preview: hit.preview,
      cover: (hit.album && (hit.album.cover_medium || hit.album.cover)) || "",
      did: hit.id,
    };
  }
  return null;
}

// Resolve Deezer previews for a list, in small concurrent batches (Deezer
// allows ~50 req / 5s, so we keep batches modest).
async function attachPreviews(songs) {
  const BATCH = 5;
  for (let i = 0; i < songs.length; i += BATCH) {
    const slice = songs.slice(i, i + BATCH);
    await Promise.all(slice.map(async (song) => {
      try {
        const dz = await deezerPreview(song);
        if (dz) { song.preview = dz.preview; if (dz.cover) song.cover = dz.cover; if (dz.did) song.did = dz.did; }
      } catch (e) { /* leave it YouTube-only */ }
    }));
  }
  return songs;
}

/* ---------- Deezer playlists: decade songs (preview built in) ---------- */
async function deezerPlaylist(playlistId, genreLabel) {
  const url =
    "https://api.deezer.com/playlist/" + playlistId + "/tracks?limit=" + PER_DECADE;
  const data = await fetchJson(url);
  const rows = (data && data.data) || [];
  const out = [];
  for (const t of rows) {
    if (!t || !t.title || !t.preview) continue;   // need a playable preview
    out.push({
      s: (t.title_short || t.title).slice(0, 80),
      a: (t.artist && t.artist.name ? t.artist.name : "").slice(0, 60),
      c: "",
      f: genreLabel === "Eurovision" ? "✨" : "🎵",
      g: genreLabel,
      col: COLORS[out.length % COLORS.length],
      preview: t.preview,
      cover: (t.album && (t.album.cover_medium || t.album.cover)) || "",
      did: t.id,
      il: 0,
    });
  }
  return out;
}

async function allDecadeSongs() {
  const lists = await Promise.all(
    DECADES.map((d) =>
      deezerPlaylist(d.playlist, d.g).catch((e) => {
        console.error("decade " + d.tag + " failed", e);
        return [];
      })
    )
  );
  return lists.flat();
}

/* ---------- interleave (every 3rd Israeli) ---------- */

// Detect Arabic script (incl. Arabic Supplement, Extended, and Presentation
// Forms used by Arabic, Persian, Urdu, etc.).
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// Transliterated Arabic (written in Latin letters) can't be caught by script
// detection, so we also match common Arabic words and well-known Arabic-world
// artists by name. Word-boundary matched to avoid false hits inside other
// words. Extend the env vars DROP_WORDS / DROP_ARTISTS (comma-separated) to
// tune without code changes.
const AR_WORDS = (
  "habibi,habiba,ya leili,ya lili,ya habibi,3enaya," +
  "inshallah,mashallah,bahibak,bahebak,bahebek,wahashtini,3omri,ya omri," +
  "dabke,dabka,sha3bi,shaabi,raqs sharqi,khaleeji,ya albi,ya alby"
).split(",").map((s) => s.trim()).filter(Boolean);

const AR_ARTISTS = (
  "amr diab,tamer hosny,saad lamjarred,nancy ajram,fairuz,fairouz," +
  "umm kulthum,om kalthoum,oum kalthoum,mohamed ramadan,wael kfoury," +
  "wael jassar,kadim al sahir,kadhem al saher,balqees," +
  "myriam fares,najwa karam,haifa wehbe,ragheb alama,george wassouf," +
  "abdel halim hafez,mohamed hamaki,tamer ashour,ramy sabry,ramy gamal," +
  "marwan khoury,carole samaha,samira said,sherine abdel wahab," +
  "hussain al jassmi,cheb khaled,cheb mami,rachid taha,zap tharwat," +
  "marwan pablo,cairokee,mohammed assaf,nassif zeytoun,elyanna,saif nabeel"
).split(",").map((s) => s.trim()).filter(Boolean);

function envList(name) {
  return (process.env[name] || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const EXTRA_WORDS = envList("DROP_WORDS");
const EXTRA_ARTISTS = envList("DROP_ARTISTS");

function hasWord(hay, words) {
  for (const w of words) {
    if (!w) continue;
    // match as a whole word/phrase, case-insensitive
    const re = new RegExp("(^|[^a-z0-9])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i");
    if (re.test(hay)) return true;
  }
  return false;
}

function isArabic(song) {
  const title = song.s || "";
  const artist = song.a || "";
  if (ARABIC_RE.test(title) || ARABIC_RE.test(artist)) return true;     // script
  const t = title.toLowerCase(), a = artist.toLowerCase();
  if (hasWord(a, AR_ARTISTS) || hasWord(a, EXTRA_ARTISTS)) return true;  // artist name
  if (hasWord(t, AR_WORDS) || hasWord(t, EXTRA_WORDS)) return true;      // title words
  if (hasWord(a, AR_WORDS) || hasWord(a, EXTRA_WORDS)) return true;      // artist words
  return false;
}
function dropArabic(list) {
  return list.filter((s) => !isArabic(s));
}

function dedupe(list) {
  const seen = new Set(); const out = [];
  for (const s of list) {
    const k = (s.s + "|" + s.a).toLowerCase();
    if (seen.has(k)) continue; seen.add(k); out.push(s);
  }
  return out;
}
function interleave(global, israeli) {
  const out = []; let gi = 0, ii = 0, pos = 0;
  const total = global.length + israeli.length;
  while (out.length < total) {
    pos++;
    if (pos % 3 === 0 && ii < israeli.length) out.push(israeli[ii++]);
    else if (gi < global.length) out.push(global[gi++]);
    else if (ii < israeli.length) out.push(israeli[ii++]);
    else break;
  }
  return dedupe(out);
}

async function buildDeck(key) {
  const globalRegion = process.env.TOP_REGION || "US";

  // current 2020s-now hits (YouTube) + Israeli chart (YouTube).
  // YouTube can fail (bad/restricted key, quota) — that must NOT kill the
  // whole deck, since the decade songs below come from Deezer and need no key.
  let currentSongs = [];
  try { currentSongs = await ytChart(key, globalRegion, false); }
  catch (e) { console.error("global chart failed, continuing without it:", e.message); }
  let israeliSongs = [];
  try { israeliSongs = await ytChart(key, "IL", true); }
  catch (e) { console.error("IL chart failed, continuing without it:", e.message); }

  // older hits, 80s-2010s, straight from Deezer (previews already included)
  const decadeSongs = await allDecadeSongs();

  // YouTube songs need Deezer previews resolved; decade songs already have them
  if (currentSongs.length) await attachPreviews(currentSongs);

  // non-Israeli pool = current hits + all decades, deduped, Arabic removed
  const nonIsraeli = dropArabic(dedupe([...currentSongs, ...decadeSongs]));
  israeliSongs = dropArabic(israeliSongs);

  // drop any that duplicate an Israeli-chart track (keep the Israeli version)
  const ilKeys = new Set(israeliSongs.map((s) => (s.s + "|" + s.a).toLowerCase()));
  const globalOnly = nonIsraeli.filter(
    (s) => !ilKeys.has((s.s + "|" + s.a).toLowerCase())
  );

  // interleave Israeli every 3rd; the client re-shuffles each load anyway
  return interleave(globalOnly, israeliSongs);
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const force = req.query.refresh === "1";

  if (!force) {
    const cached = await readCache();
    if (cached && !cached.stale) {
      res.setHeader("Cache-Control", "s-maxage=600");
      res.status(200).json({ ok: true, songs: cached.songs, source: "cache", fetchedAt: cached.fetchedAt });
      return;
    }
  }

  // YouTube key is optional now: without it (or if YouTube rejects us), the
  // deck still builds from Deezer decade playlists. ytChart handles "" safely.
  const key = process.env.YT_API_KEY || "";

  try {
    const songs = await buildDeck(key);
    if (!songs.length) throw new Error("empty deck");
    const payload = { songs, fetchedAt: Date.now(), v: DECK_VERSION };
    await writeCache(payload);
    const withPreview = songs.filter((s) => s.preview).length;
    const src = key ? "youtube+deezer" : "deezer";
    res.status(200).json({ ok: true, songs, source: src, fetchedAt: payload.fetchedAt, previews: withPreview });
  } catch (e) {
    console.error("top build error", e);
    const cached = await readCache();
    if (cached) { res.status(200).json({ ok: true, songs: cached.songs, source: "stale-cache", fetchedAt: cached.fetchedAt }); return; }
    res.status(502).json({ ok: false, error: "fetch failed: " + e.message });
  }
}
