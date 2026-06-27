// Camp login — checks the shared passphrase and issues a signed token.
// The passphrase lives in process.env.CAMP_PASSPHRASE (never in the browser).
// The token is an HMAC of the payload using CAMP_SECRET, so other endpoints
// can verify a request came from someone who logged in, with no session DB.
//
// If the person ALSO supplies the admin password (process.env.ADMIN_PASSWORD),
// the token is marked { admin: true } and unlocks the results endpoint.
//
// POST /api/login   body: { name, passphrase, admin? }
// -> { ok: true, token, name, admin }  on success
// -> { ok: false, error }              on failure

import crypto from "crypto";

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + mac;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "use POST" });
    return;
  }

  const PASS = process.env.CAMP_PASSPHRASE;
  const FLAMINGO = process.env.FLAMINGO_PASSPHRASE; // optional 2nd passphrase
  const SECRET = process.env.CAMP_SECRET;
  const ADMIN = process.env.ADMIN_PASSWORD; // optional
  if (!PASS || !SECRET) {
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const name = (body.name || "").toString().trim().slice(0, 40);
  // trim so a stray space/newline (e.g. copied into the env var, or typed by
  // the user) can't cause a false "wrong passphrase"
  const passphrase = (body.passphrase || "").toString().trim();
  const adminPass = (body.admin || "").toString().trim();

  if (!name) {
    res.status(400).json({ ok: false, error: "name required" });
    return;
  }

  // Two valid passphrases decide the group: the flamingo (internal) one tags
  // the voter as "flamingo"; the general camp one tags them "ext" (external).
  const passClean = (PASS || "").trim();
  const flamingoClean = (FLAMINGO || "").trim();
  let group = null;
  if (flamingoClean && safeEqual(passphrase, flamingoClean)) {
    group = "flamingo";
  } else if (safeEqual(passphrase, passClean)) {
    group = "ext";
  } else {
    // Safe diagnostics: never reveal the actual passphrase, only enough to
    // tell whether the env var is set and where the mismatch is. Remove later.
    const diag = {
      camp_env_set: Boolean(passClean),
      camp_env_len: passClean.length,
      flamingo_env_set: Boolean(flamingoClean),
      typed_len: passphrase.length,
      first_char_match: passClean && passphrase ? (passClean[0] === passphrase[0]) : false,
      last_char_match: passClean && passphrase ? (passClean[passClean.length - 1] === passphrase[passphrase.length - 1]) : false,
    };
    res.status(401).json({ ok: false, error: "wrong passphrase", diag });
    return;
  }

  // Admin is optional: only granted if an admin password is configured AND
  // the supplied one matches. A wrong admin password is rejected outright so
  // there's no ambiguity about whether someone is admin.
  let isAdmin = false;
  if (adminPass) {
    if (ADMIN && safeEqual(adminPass, (ADMIN || "").trim())) {
      isAdmin = true;
    } else {
      res.status(401).json({ ok: false, error: "wrong admin password" });
      return;
    }
  }

  const payload = { name, t: Date.now(), grp: group };
  if (isAdmin) payload.admin = true;
  const token = sign(payload, SECRET);
  res.status(200).json({ ok: true, token, name, admin: isAdmin, group });
}
