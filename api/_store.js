// Vote storage on Vercel Blob (PRIVATE store), sharded per person so
// concurrent writers never collide (each person only ever writes their file).
//
// Layout:  votes/<hash>.json  ->  { name, votes: { "<song — artist>": "like"|"skip" } }
//
// Private access: files are NOT publicly fetchable. We read them back with
// get(pathname, { access: "private" }) using the store token, never by URL.

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

// Stable, non-guessable file path: HMAC of the lowercased name with a secret,
// so even though it's a private store, names aren't embedded in paths.
function pathFor(name) {
  const norm = name.toLowerCase().trim();
  const salt = process.env.CAMP_SECRET || "midburn";
  const h = crypto.createHmac("sha256", salt).update(norm).digest("hex").slice(0, 24);
  return "votes/" + h + ".json";
}

// Read one private blob's JSON by pathname. Returns null if missing/unreadable.
async function readPrivate(pathname) {
  const { get } = await blob();
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    // stream -> text -> json
    const res = new Response(result.stream);
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Record/overwrite one person's vote on one song. `group` is "flamingo" or
// "ext" and is stored on the person's file (latest login wins).
// Returns { likeCount, newLike } where likeCount is this song's running like
// total and newLike is true only if THIS call added a like that wasn't there
// before (used for the gamification effect).
export async function recordVote(songKey, name, choice, group) {
  const { put } = await blob();
  const path = pathFor(name);

  // merge with the person's existing file so we don't clobber prior votes
  let current = { name, votes: {} };
  const existing = await readPrivate(path);
  if (existing && existing.votes) current = { name, votes: existing.votes, group: existing.group };

  const prevChoice = current.votes[songKey];
  current.votes[songKey] = choice;
  if (group) current.group = group;

  await put(path, JSON.stringify(current), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });

  // Maintain a tiny per-song like tally so we can tell the client the song's
  // running like count cheaply (no full scan). Only changes when this user's
  // like status for the song actually changes.
  let likeCount = null, newLike = false;
  const becameLike = choice === "like" && prevChoice !== "like";
  const removedLike = choice !== "like" && prevChoice === "like";
  if (becameLike || removedLike) {
    try {
      const tally = (await readPrivate("votes/_tally.json")) || {};
      const cur = Number(tally[songKey] || 0);
      const next = Math.max(0, cur + (becameLike ? 1 : -1));
      tally[songKey] = next;
      await put("votes/_tally.json", JSON.stringify(tally), {
        access: "private",
        contentType: "application/json",
        allowOverwrite: true,
        addRandomSuffix: false,
      });
      likeCount = next;
      newLike = becameLike;
    } catch (e) {
      // tally is best-effort; never fail a vote because of it
      console.error("tally update failed", e);
    }
  }
  return { likeCount, newLike };
}

// Read every person's file and return combined data, with each voter's group
// so results can be split (flamingo vs external).
export async function readAll() {
  const { list } = await blob();
  const { blobs } = await list({ prefix: "votes/" });
  const songs = {};   // songKey -> { name: choice }
  const voters = [];
  const groupByName = {};   // name -> "flamingo" | "ext"

  for (const b of blobs || []) {
    const data = await readPrivate(b.pathname);
    if (!data || !data.name) continue;
    voters.push(data.name);
    groupByName[data.name] = data.group === "flamingo" ? "flamingo" : "ext";
    for (const [songKey, choice] of Object.entries(data.votes || {})) {
      if (!songs[songKey]) songs[songKey] = {};
      songs[songKey][data.name] = choice;
    }
  }
  return { songs, voters, groupByName };
}
