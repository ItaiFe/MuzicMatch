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
| `ALLOWED_ORIGIN` | your live URL, e.g. `https://midburn-sounds.vercel.app` | recommended |

Plus the KV storage variables, which Vercel adds automatically when you
connect a KV/Upstash store (see "Central vote storage" below):
`KV_REST_API_URL` and `KV_REST_API_TOKEN`.

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

## Central vote storage (Vercel KV)

The login + voting feature stores everyone's choices centrally so you can
see the whole camp's votes in one place. It uses a Redis-compatible KV
store via REST — either Vercel KV or Upstash.

### Set it up (about 2 minutes)

1. In your Vercel project: **Storage -> Create Database -> KV** (or
   **Marketplace -> Upstash**). Give it a name, create it.
2. **Connect it to this project.** Vercel injects the credentials as
   environment variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`).
3. Redeploy so the functions pick them up.

No schema, no tables. The code creates keys on the fly:
- `song:<title — artist>` : a hash of `name -> like|skip` (one entry per
  person per song, so re-swiping just overwrites)
- `voters` : a set of everyone who has logged in and voted

If the KV variables aren't set, the login screen still works but
voting/results return "storage not configured."

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
Vercel KV or Upstash Redis (a small change to `api/search.js`).



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
