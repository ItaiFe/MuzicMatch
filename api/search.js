// Serverless YouTube search — keeps the API key server-side.
// Called by the app as /api/search?q=<song artist>
// Returns { id: "<videoId>" | null }
//
// The API key is read from process.env.YT_API_KEY (set in Vercel) and is
// never sent to the browser. This endpoint also limits abuse of the key:
//   - rejects oversized / malformed queries
//   - rejects requests from other websites (basic origin allowlist)
//   - in-memory rate limit per IP to slow quota-burning
//   - daily self-imposed search budget so a runaway can't drain quota

const DAILY_BUDGET = 8000;          // stay under the 10k/day YouTube quota
const PER_IP_PER_MIN = 20;          // max searches per IP per minute
const MAX_Q_LEN = 120;              // reject absurdly long queries

// NOTE: in-memory counters reset when the function cold-starts. They are a
// speed bump, not a guarantee. For hard limits use a KV store (see README).
let dayKey = "";
let daySpent = 0;
const ipHits = new Map();           // ip -> { count, windowStart }

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart > 60000) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > PER_IP_PER_MIN;
}

export default async function handler(req, res) {
  // Only allow our own site (and direct/no-origin calls) to use the key.
  // Set ALLOWED_ORIGIN in Vercel to your deployment URL to lock this down.
  const allowed = process.env.ALLOWED_ORIGIN || "";
  const origin = req.headers.origin || "";
  if (allowed && origin && origin !== allowed) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");

  const q = (req.query.q || "").toString().trim();
  if (!q || q.length > MAX_Q_LEN) {
    res.status(400).json({ error: "bad query" });
    return;
  }

  const KEY = process.env.YT_API_KEY;
  if (!KEY) {
    res.status(500).json({ error: "server missing YT_API_KEY" });
    return;
  }

  // per-IP rate limit
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate limited" });
    return;
  }

  // daily budget guard
  const today = todayStr();
  if (today !== dayKey) {
    dayKey = today;
    daySpent = 0;
  }
  if (daySpent >= DAILY_BUDGET) {
    res.status(429).json({ error: "daily search budget reached" });
    return;
  }

  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    "?part=snippet&type=video&videoEmbeddable=true&maxResults=1" +
    "&q=" + encodeURIComponent(q + " official") +
    "&key=" + KEY;

  try {
    daySpent += 100; // each search costs ~100 units
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text();
      console.error("YouTube API error", r.status, body);
      res.status(r.status).json({ error: "youtube " + r.status });
      return;
    }
    const data = await r.json();
    const item = (data.items || [])[0];
    const id = item && item.id ? item.id.videoId : null;

    // cache at the CDN edge for a day to cut repeat lookups across all users
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    res.status(200).json({ id });
  } catch (e) {
    console.error("search handler error", e);
    res.status(502).json({ error: "fetch failed" });
  }
}
