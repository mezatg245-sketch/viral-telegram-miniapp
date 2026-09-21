# Zena — Telegram Mini App starter

A vertical video feed Mini App that gates content behind rewarded ads (minimum
2 per unlock), detects ad blockers, logs revenue for a **password-protected,
unlisted dashboard**, and pulls its clips from a **private (or unlisted)
Telegram group or channel that viewers never see or know exists.**

## How the content pipeline works

```
[ Private Telegram group/channel ]
              │  you (or collaborators) post videos here
              ▼
      Telegram sends a webhook update to your bot
              ▼
        server.js indexes the clip
   (stores file_id + caption, never the chat itself)
              ▼
   Mini App calls /api/videos and /api/stream/:id
   — same-origin, no chat id, file_id, or bot token
     ever reaches the browser
              ▼
        Viewer just sees a normal video feed
```

The source chat's name, id, and invite link are never sent to the client —
the frontend only ever talks to your own `/api/*` routes.

## Files
- `server.js` — Express backend: Telegram webhook receiver, video index,
  admin auth, and a proxy that streams video bytes without exposing your
  bot token
- `public/index.html` — the video feed + ad gate + ad-blocker wall (this is
  the ONLY page viewers ever load — there is no link to the dashboard
  anywhere in it)
- `private/dashboard.html` — revenue dashboard, only reachable after login
- `private/login.html` — the admin password screen
- `package.json`, `.env.example`, `.gitignore`

Everything is served from one Node process, so there's a single deployment
and no CORS to configure.

## 1. Create the bot and the hidden source chat
1. Message **@BotFather** → `/newbot`, save the token.
2. Create a **private** Telegram group or channel (Channel is usually
   simpler: only admins can post, which doubles as upload access control).
3. Add your bot to it **as an admin** (needed to read posts/`channel_post`
   updates). For a channel: Channel → Administrators → Add Admin.
4. Post one test video into the group/channel so you have something to
   verify against once the webhook is live.

### Finding the chat's numeric ID
Easiest path: temporarily add **@userinfobot** or **@getidsbot** to the
group/channel — it will reply with the numeric id (looks like
`-1001234567890`). Remove it afterward. Put that value in `SOURCE_CHAT_ID`.

## 2. Configure environment variables
Copy `.env.example` to `.env` and fill in:
- `BOT_TOKEN` — from BotFather
- `WEBHOOK_SECRET` — a long random string (`openssl rand -hex 24`); this
  becomes part of your webhook URL so nobody can inject fake videos by
  guessing it
- `SOURCE_CHAT_ID` — the hidden chat's numeric id
- `BRAND_NAME` — what viewers see as the "creator" label instead of your
  real channel name
- `ADMIN_PASSWORD` — unlocks the hidden revenue dashboard (see step 6)

## 3. Deploy the backend (free)
**Render's free tier** is the simplest path — deploys straight from a Git repo,
no credit card required to start. It includes 750 instance-hours/month, which
covers one always-running free service. (Free services sleep after ~15 min
idle and take 20–30s to wake on the next request — fine for a side project,
just know a webhook that arrives while asleep gets a slightly delayed first
response rather than dropped, since Telegram retries.)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), **New → Web Service**, connect the repo.
3. Settings:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
4. Add the environment variables from step 2 (`BOT_TOKEN`, `WEBHOOK_SECRET`,
   `SOURCE_CHAT_ID`, `BRAND_NAME`, `ADMIN_PASSWORD`) under **Environment**.
5. Deploy. Render gives you a URL like `https://zena.onrender.com`.

**Koyeb** is a solid alternative with its own free tier (one instance, 5GB
bandwidth) and no sleep-on-idle — same steps, connect the repo, set the same
env vars, build command `npm install`, run command `npm start`.

Either way, once deployed you're on a free plan — no cost until you outgrow
it (heavy traffic, need multiple always-on instances, etc.), at which point
both platforms let you upgrade the same service without redeploying.

## 4. Point Telegram's webhook at your backend
Once deployed, tell Telegram where to send new posts (replace the values):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://zena.onrender.com/webhook/<WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"channel_post\"]"
```

Post another test video into the group/channel, then check
`https://zena.onrender.com/api/health` — the `videos` count should go up.

## 5. Register the Mini App with BotFather
1. Message **@BotFather** → `/newapp` (pick the same bot from step 1).
2. Web App URL: `https://zena.onrender.com/index.html`.
3. BotFather gives you a `t.me/yourbot/yourapp` link to share — that's the
   only thing viewers ever see; the group/channel behind it stays hidden.

## 6. The hidden revenue dashboard
`private/dashboard.html` is **not** in the `public/` folder, so Express never
serves it as a static file and there is no URL anywhere in `index.html` that
points to it — a viewer browsing the Mini App has no way to discover it.

To open it yourself:
1. Visit `https://zena.onrender.com/admin`.
2. Enter the `ADMIN_PASSWORD` you set in step 2.
3. On success you're redirected to `/admin/dashboard`, and a signed,
   `httpOnly` session cookie keeps you logged in for 7 days.
4. `/admin/logout` (linked from the dashboard header) clears the session.

Notes on this protection:
- Sessions are stored in memory, which is fine for a single server instance;
  if you ever scale to multiple instances, move `sessions` to Redis or
  similar so logins survive a restart or load-balancing.
- The login check uses `crypto.timingSafeEqual` to avoid leaking the
  password through response-time differences.
- This is password auth, not Telegram-identity auth — anyone with the
  password and the URL gets in, from any browser. That's normally fine for
  a solo/small-team dashboard; if you want it locked to your specific
  Telegram account instead, the Mini App's `Telegram.WebApp.initData` can be
  verified server-side against your Telegram user ID — ask if you want that
  wired in.

## 7. Wire up real ad networks
Ships in **demo mode** (a timed stand-in per ad) so the unlock flow is fully
testable before you connect real SDKs.

### Adsgram
1. Get a **Block ID** from your Adsgram publisher account.
2. In `public/index.html`, add to `<head>`:
   ```html
   <script src="https://sad.adsgram.ai/js/sad.min.js"></script>
   ```
3. Set `window.__ADSGRAM_BLOCK_ID__ = "your-block-id";` before the app
   script runs — the existing `adsgram` adapter picks it up automatically.
4. Update its `ecpm` value to match what Adsgram reports, so the local
   revenue estimate stays realistic.

### Adding another network (Monetag, etc.)
Copy the `monetag` entry in the `AD_NETWORKS` array and swap the body of
`show()` for that network's SDK call — any adapter that returns a Promise
resolving when the ad finishes will work with the existing gate logic.

## 8. Ad-blocker wall
`detectAdBlock()` in `index.html` uses a hidden "bait" element most blockers
strip or hide — it's a best-effort client-side signal (no detector is
100% reliable) but covers common blockers without a server round trip.

## 9. Revenue data — local MVP vs. real backend
Ad views are currently logged to the viewer's own `localStorage`, and
`dashboard.html` reads that same log — good for testing the funnel, but
per-device rather than a true aggregate across everyone. To get real
aggregate numbers:
1. Add a `POST /api/log-ad-view` route to `server.js` that appends to a
   small DB table (same pattern as the `videos` store).
2. In `index.html`'s `logAdRevenue()`, `fetch()` that endpoint instead of
   (or alongside) the `localStorage` write.
3. Point `dashboard.html` at `/api/revenue-summary` instead of
   `localStorage`, and pull real payout numbers from each ad network's
   publisher API on a schedule.

## 10. Important limits to know about
- **File size**: the standard Bot API can only serve files up to **20 MB**
  through `getFile`. Most short vertical clips fit fine; if you're posting
  longer or higher-bitrate videos, you'll need to run a self-hosted
  [Local Bot API server](https://github.com/tdlib/telegram-bot-api) (raises
  the limit to 2 GB) and point `TG_API`/`TG_FILE_BASE` in `server.js` at it.
- **`videos.json`** is a flat-file store meant for getting started — move to
  a real database before this becomes your production system of record.
- **Content moderation**: since only chat admins can post to the source
  channel, access control is effectively "who you make an admin" — keep
  that admin list tight.

## 11. Language & theme
- Amharic strings live in the `STRINGS.am` object in both HTML files.
- Theme and language choices are saved to `localStorage` and sync with
  Telegram's own theme on first load via `Telegram.WebApp.colorScheme`.
