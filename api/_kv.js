// Minimal KV layer over the Upstash Redis REST API (this is what Vercel KV
// uses under the hood). No npm install needed — just fetch.
//
// Works with either set of env vars:
//   KV_REST_API_URL / KV_REST_API_TOKEN          (Vercel KV)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash direct)

function creds() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export function kvConfigured() {
  const { url, token } = creds();
  return Boolean(url && token);
}

// Run a Redis command, e.g. cmd(["HSET", "key", "field", "val"])
async function cmd(args) {
  const { url, token } = creds();
  if (!url || !token) throw new Error("KV not configured");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("KV " + r.status + " " + t);
  }
  const data = await r.json();
  return data.result;
}

// Record one person's vote on one song. We store a hash per song keyed by
// person name -> "like" | "skip", so each person counts once per song even
// if they swipe twice. Also track the set of voter names.
export async function recordVote(songKey, name, choice) {
  await cmd(["HSET", "song:" + songKey, name, choice]);
  await cmd(["SADD", "voters", name]);
}

// Read everything back for the results view.
export async function readAll() {
  const songKeys = await cmd(["KEYS", "song:*"]);
  const out = {};
  for (const k of songKeys || []) {
    const flat = await cmd(["HGETALL", k]);
    // Upstash returns HGETALL as a flat [field, val, field, val, ...] array
    const map = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
    } else if (flat && typeof flat === "object") {
      Object.assign(map, flat);
    }
    out[k.replace(/^song:/, "")] = map;
  }
  const voters = (await cmd(["SMEMBERS", "voters"])) || [];
  return { songs: out, voters };
}
