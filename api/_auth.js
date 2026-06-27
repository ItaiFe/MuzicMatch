// Shared HMAC token helper used by the vote/results endpoints.
import crypto from "crypto";

// Verify a token produced by /api/login. Returns the payload
// ({ name, t }) if valid, or null if not.
export function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  // constant-time compare
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}
