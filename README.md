# ViralLoop — Telegram Mini App

A modern Telegram Mini App starter for short viral videos with:
- Telegram Mini App authentication
- Two rewarded-ad gates before unlocking content
- AdsGram Rewarded integration
- Optional second ad-provider slot
- Best-effort ad-blocker detection with a clear message
- English / Amharic switch
- Light / dark UI
- Animated cards, progress, reactions and swipe-like feed
- Videos sourced from a Telegram channel/group through the bot webhook
- Hidden admin dashboard at `/admin.html`
- Cloudflare Workers + D1 backend
- Cloudflare Pages frontend

## Important limitations

1. The app does **not** use a deceptive or unbreakable lock. If an ad provider fails to load, the app shows an honest error/fallback state.
2. Browser ad-blocker detection is inherently best-effort. No web app can reliably detect every blocker.
3. Telegram's Bot API sends `channel_post` updates for new channel posts. This starter indexes **new** posts received after the webhook is configured. It does not magically read an old private channel archive. For a pre-existing archive, repost/import the videos or build a separate MTProto ingestion service.
4. The sample uses Telegram `file_id` and generates a temporary Telegram file URL. Bot API file downloads are subject to Telegram limits. For larger video libraries, use object storage/CDN (for example Cloudflare R2) rather than relying on Bot API file downloads.
5. Keep your bot token, admin key and other secrets in Cloudflare Worker secrets. Never put them in `config.js`.

## Files

- `public/index.html` — Mini App UI
- `public/app.js` — frontend logic
- `public/styles.css` — modern responsive design
- `public/config.js` — safe public configuration
- `public/admin.html` — hidden dashboard UI
- `public/admin.js` — dashboard logic
- `worker.js` — Cloudflare Worker API + Telegram webhook
- `schema.sql` — D1 schema
- `wrangler.toml` — Cloudflare config
- `package.json` — local tooling

## Configuration

Edit `public/config.js`:

- `ADS_GRAM_BLOCK_ID`: your AdsGram rewarded block ID
- `SECOND_AD_URL`: optional URL to your own ad/partner landing page
- `AD_GATES`: keep at 2 if you want two rewarded ads per unlock
- `APP_NAME`

Cloudflare Worker secrets:

- `BOT_TOKEN`
- `ADMIN_KEY`
- `ADMIN_TELEGRAM_IDS` — comma-separated Telegram user IDs allowed into the dashboard
- `PUBLIC_API_BASE` — your Worker URL, e.g. `https://viral-api.example.workers.dev`

Worker vars in `wrangler.toml`:

- `CHANNEL_ID` — numeric Telegram channel/group ID, e.g. `-1001234567890`

## Telegram source setup

For a channel:
1. Create a bot with @BotFather.
2. Add the bot to your source channel as an administrator.
3. Give it permission to receive channel posts / manage the channel as appropriate.
4. Configure the webhook:
   `https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev/telegram/webhook`
5. Post a new video in the channel. The worker will index it.

For a public or private source, the app does not show the source channel name to normal users. The source is an internal backend setting.

## Local development

Install Node.js 20+.

```bash
npm install
npx wrangler login
npx wrangler d1 create viral-loop-db
```

Put the returned database ID into `wrangler.toml`.

Then:

```bash
npx wrangler d1 execute viral-loop-db --remote --file=schema.sql
npx wrangler dev
```

## Deploy

```bash
npx wrangler pages project create viral-loop
npx wrangler pages deploy public --project-name viral-loop
npx wrangler deploy
```

The exact Pages/Workers deployment command can vary with the current Wrangler version. Cloudflare's current documentation should be followed if Wrangler prompts for a different setup.

## Connect the Telegram Mini App

In @BotFather:
- Set the bot's Main Mini App to your Pages HTTPS URL.
- Or use the bot menu button.
- Telegram provides `Telegram.WebApp.initData`; the Worker validates it before accepting protected requests.

## Dashboard

Open:

`https://YOUR-PAGES-DOMAIN/admin.html`

Enter the `ADMIN_KEY`.

The dashboard shows:
- users
- video views
- completed ad gates
- estimated revenue
- configured CPM
- top videos

Revenue is an estimate based on your entered CPM. AdsGram provides actual impression/click/earnings statistics in its publisher account, so do not treat the Mini App estimate as your final payout.

## Copyright / moderation

Only publish videos you have permission to distribute. Add a moderation step before allowing user-submitted material into the source channel.
