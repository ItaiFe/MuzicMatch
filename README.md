# Midburn Sounds — Swipe the Playlist

A Tinder-style song-swiping app. Swipe right to add a song to the camp
playlist, left to skip. Tap the record to play the full song (embedded
from YouTube). Liked songs collect into a playlist you can copy.

## What's in here

```
index.html        the whole app (UI + swipe logic + playback)
api/search.js      serverless function that searches YouTube server-side
vercel.json        Vercel config
```

The YouTube API key lives **only** on the server (as an environment
variable), never in the browser. The app calls `/api/search`, which does
the lookup and returns just the video ID.

---

## Deploy to Vercel (about 5 minutes)

You need a free Vercel account: https://vercel.com/signup

### Environment variables to set in Vercel

| Name             | Value                                  | Required |
|------------------|----------------------------------------|----------|
| `YT_API_KEY`     | your YouTube Data API v3 key           | yes      |
| `CAMP_PASSPHRASE`| the shared passphrase people type to get in | yes |
| `CAMP_SECRET`    | any long random string (signs login tokens) | yes |
| `ADMIN_PASSWORD` | password that unlocks the results panel | recommended |
| `ALLOWED_ORIGIN` | your live URL, e.g. `https://midburn-sounds.vercel.app` | recommended |

Plus the storage variable, which Vercel adds automatically when you
connect a Blob store (see "Central vote storage" below):
`BLOB_READ_WRITE_TOKEN`.

Set them all for the **Production** environment. `CAMP_SECRET` can be any
random string — generate one with `openssl rand -hex 32` or just mash the
keyboard; it only needs to stay constant and secret. `ALLOWED_ORIGIN`
makes the API reject calls from other websites.

### Option A — drag & drop (no tools)

1. Go to https://vercel.com/new
2. Choose to import / upload this folder (zip it first if needed).
3. Add the environment variables above (at minimum `YT_API_KEY`).
4. Deploy. You'll get a URL like `https://midburn-sounds.vercel.app`.
5. Add `ALLOWED_ORIGIN` = that URL, then **Redeploy** so the function
   picks up the new variables.

### Option B — command line

```bash
npm i -g vercel          # one-time
cd midburn-vercel
vercel                   # follow prompts, links the project
vercel env add YT_API_KEY   # paste your key when asked, choose Production
vercel --prod            # deploy to the live URL
```

---

## Set up the YouTube API key

1. Google Cloud Console → create/select a project.
2. **APIs & Services → Library →** enable **YouTube Data API v3**.
3. **APIs & Services → Credentials →** create an **API key**.
4. Restrict it (recommended):
   - **API restrictions:** restrict to *YouTube Data API v3* only.
   - **Application restrictions:** leave as **None**, OR set an
     *IP address* restriction — do NOT use an HTTP-referrer restriction,
     because the key is used server-side (from Vercel), not the browser.
5. Put that key in the `YT_API_KEY` environment variable above.

> Because the key now runs server-side, you do not need referrer
> restrictions and the key is never visible to users.

---

## Central vote storage (Vercel Blob)

The login + voting feature stores everyone's choices centrally so you can
see the whole camp's votes in one place. It uses **Vercel Blob** — each
person's votes live in their own small JSON file under `votes/`. The
filename is a salted hash of the person's name (so the public file URL
can't be guessed from someone's name), while their real name is stored
inside the file.

### Why per-person files

Blob has no atomic "update one field" operation. If everyone wrote to a
single shared file, two people swiping at the same moment would both read
the same version and the second write would erase the first one's vote.
Giving each person their own file removes that race completely — nobody
ever writes to anyone else's file.

### Set it up (about 1 minute)

1. In your Vercel project: **Storage -> Create Database -> Blob**.
2. Create the store and **connect it to this project**.
3. Vercel injects `BLOB_READ_WRITE_TOKEN` automatically.
4. Redeploy so the functions pick it up.

No schema, no tables, no marketplace step. If `BLOB_READ_WRITE_TOKEN`
isn't set, the login screen still works but voting/results return
"storage not configured."

You can browse the raw `votes/*.json` files in the Vercel dashboard under
the Blob store's Browse view.

> Note: Blob reads can lag overwrites by up to ~60s due to CDN caching;
> the code reads with cache-busting to get the latest, but the camp-wide
> results may occasionally show a vote a few seconds late. Fine for a
> playlist.

### How login works

- Everyone enters the **camp passphrase** (checked server-side against
  `CAMP_PASSPHRASE`) plus their **name**.
- On success the server returns a signed token (HMAC with `CAMP_SECRET`).
  The browser stores it and sends it with each vote, so the server knows
  the vote came from someone who passed the passphrase — no accounts and
  no session database.
- Names are self-declared: this is attribution for a camp, not secure
  identity. Anyone could type any name. That's expected and fine here.
- "See everyone's votes" shows top songs by likes plus a per-person
  breakdown, pulled live from the store.

### Admin panel (organizer-only results)

The full camp breakdown is gated so regular voters can't see it:

- On the login screen, an organizer clicks **"I'm an organizer"**, which
  reveals an admin-password field, and enters `ADMIN_PASSWORD` along with
  the normal passphrase and their name.
- Only then does the server mark their token `admin: true`. The
  **"See everyone's votes"** button appears only for admins, and the
  `/api/results` endpoint returns 403 for any non-admin token.
- This is enforced **server-side**: the admin flag is inside the signed
  token, so it can't be forged by editing browser storage or calling the
  endpoint directly — without `CAMP_SECRET` the signature won't validate.
- Regular voters still see their own liked-songs list; they just don't
  get the camp-wide breakdown.

If you don't set `ADMIN_PASSWORD`, nobody can open the admin panel (the
button stays hidden and the endpoint stays locked). Set it to something
different from the camp passphrase.

---

## Keeping the API key safe

How the key is protected:

- **Never in the browser.** The key is only read server-side in
  `api/search.js` via `process.env.YT_API_KEY`. The HTML the browser
  loads contains no key — view-source shows nothing useful.
- **Vercel encrypts env vars** at rest and only exposes them to the
  serverless function, not the client bundle.
- **The endpoint limits abuse:** origin allowlist (`ALLOWED_ORIGIN`),
  per-IP rate limit, max query length, and a daily search budget so a
  runaway can't drain your quota in one go.
- **Google Cloud restriction:** restrict the key to *YouTube Data API
  v3* only. Use Application restriction *None* or *IP* — NOT
  HTTP-referrer (the call is server-side, so referrer would just break).

Important: if a key has ever been pasted into a chat, an email, or
committed to a public repo, treat it as compromised — generate a fresh
key in Google Cloud, delete the old one, and put only the new key into
Vercel. Never commit the key; `.env` is already in `.gitignore`.

The in-memory rate limit/budget reset on cold starts, so they're a speed
bump rather than a hard cap. If you want hard guarantees, back them with
a Blob counter or Upstash Redis (a small change to `api/search.js`).



## Quota

YouTube Data API gives 10,000 units/day; each search costs 100 units
(~100 searches/day). The app reduces this two ways:

- **Per-device cache:** once a song's video ID is found, it's saved in
  the browser and never searched again on that device.
- **Edge cache:** `/api/search` caches each unique song at Vercel's CDN
  for 24 hours, shared across *all* users.

Seven popular tracks are pre-baked and cost zero searches ever.

If you expect very heavy use, request a quota increase in the Cloud
Console.

---

## Run locally first (optional)

```bash
npm i -g vercel
cd midburn-vercel
vercel dev               # serves at http://localhost:3000
```

You'll need `YT_API_KEY` available locally — `vercel env pull` after
linking, or create a `.env` file with `YT_API_KEY=...` (don't commit it).
