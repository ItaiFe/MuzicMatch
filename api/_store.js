// Vote storage on Vercel Blob, sharded per person so concurrent writers
// never collide (each person only ever writes their own file).
//
// Layout:  votes/<safeName>.json  ->  { name, votes: { "<song — artist>": "like"|"skip" } }
//
// Why per-person files: Blob has no atomic field update. If everyone wrote
// one shared file, two simultaneous swipes would race and lose a vote.
// Giving each person their own file removes the race entirely.

import crypto from "crypto";

// Lazy-load @vercel/blob so a missing/incompatible package surfaces as a
// catchable runtime error (clean JSON) instead of crashing the function (502).
let _blob = null;
async function blob() {
  if (_blob) return _blob;
  _blob = await import("@vercel/blob");
  return _blob;
}

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Turn a display name into a safe, stable, NON-guessable file path.
// We hash the lowercased name with a per-deployment secret so the public
// blob URL can't be guessed from someone's name alone. Stable per person
// (same name -> same file), so re-voting overwrites rather than duplicates.
function pathFor(name) {
  const norm = name.toLowerCase().trim();
  const salt = process.env.CAMP_SECRET || "midburn";
  const h = crypto.createHmac("sha256", salt).update(norm).digest("hex").slice(0, 24);
  return "votes/" + h + ".json";
}

async function fetchJson(url) {
  // bust the CDN cache so we read the latest after an overwrite
  const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// Record/overwrite one person's vote on one song.
export async function recordVote(songKey, name, choice) {
  const { put, list } = await blob();
  const path = pathFor(name);

  // read existing file for this person (if any) so we merge, not clobber
  let current = { name, votes: {} };
  const { blobs } = await list({ prefix: path, limit: 1 });
  if (blobs && blobs.length && blobs[0].pathname === path) {
    const existing = await fetchJson(blobs[0].url);
    if (existing && existing.votes) current = { name, votes: existing.votes };
  }

  current.votes[songKey] = choice;

  await put(path, JSON.stringify(current), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
}

// Read every person's file and return combined data.
export async function readAll() {
  const { list } = await blob();
  const { blobs } = await list({ prefix: "votes/" });
  const songs = {};   // songKey -> { name: choice }
  const voters = [];

  for (const b of blobs || []) {
    const data = await fetchJson(b.url);
    if (!data || !data.name) continue;
    voters.push(data.name);
    for (const [songKey, choice] of Object.entries(data.votes || {})) {
      if (!songs[songKey]) songs[songKey] = {};
      songs[songKey][data.name] = choice;
    }
  }
  return { songs, voters };
}
