// Camp login — checks the shared passphrase and issues a signed token.
// The passphrase lives in process.env.CAMP_PASSPHRASE (never in the browser).
// The token is an HMAC of the name+issued-time using CAMP_SECRET, so the
// vote endpoint can verify a request came from someone who logged in,
// without a database of sessions.
//
// POST /api/login   body: { name, passphrase }
// -> { ok: true, token, name }  on success
// -> { ok: false, error }       on failure

import crypto from "crypto";

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + mac;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "use POST" });
    return;
  }

  const PASS = process.env.CAMP_PASSPHRASE;
  const SECRET = process.env.CAMP_SECRET;
  if (!PASS || !SECRET) {
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const name = (body.name || "").toString().trim().slice(0, 40);
  const passphrase = (body.passphrase || "").toString();

  if (!name) {
    res.status(400).json({ ok: false, error: "name required" });
    return;
  }

  // constant-time compare to avoid leaking the passphrase via timing
  const a = Buffer.from(passphrase);
  const b = Buffer.from(PASS);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    res.status(401).json({ ok: false, error: "wrong passphrase" });
    return;
  }

  const token = sign({ name, t: Date.now() }, SECRET);
  res.status(200).json({ ok: true, token, name });
}
