// Returns a FRESH Deezer preview URL for a given track id.
//
// Why this exists: Deezer preview MP3 URLs are time-signed (they carry an
// `exp=` timestamp + hmac) and expire within hours. We cache the song deck
// in Blob for up to 12h, so any preview URL baked into the cache goes stale
// and the audio 403s. Instead we cache the stable track id (`did`) and call
// this at play time to get a non-expired URL.
//
// GET /api/preview?id=<deezerTrackId>  ->  { ok, preview }

export default async function handler(req, res) {
  const id = (req.query.id || "").toString().replace(/[^0-9]/g, "").slice(0, 20);
  if (!id) {
    res.status(400).json({ ok: false, error: "missing id" });
    return;
  }
  try {
    const r = await fetch("https://api.deezer.com/track/" + id, { cache: "no-store" });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: "deezer " + r.status });
      return;
    }
    const t = await r.json();
    if (!t || !t.preview) {
      res.status(404).json({ ok: false, error: "no preview" });
      return;
    }
    // don't let the CDN cache this — the signed URL must stay fresh
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, preview: t.preview });
  } catch (e) {
    console.error("preview error", e);
    res.status(502).json({ ok: false, error: "fetch failed" });
  }
}
