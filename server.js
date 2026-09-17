require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  SOURCE_CHAT_ID,
  ADMIN_PASSWORD,
  BRAND_NAME = 'Zena Originals',
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !SOURCE_CHAT_ID || !ADMIN_PASSWORD) {
  console.error('Missing BOT_TOKEN, WEBHOOK_SECRET, SOURCE_CHAT_ID, or ADMIN_PASSWORD — check your .env (see .env.example)');
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE_BASE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const STORE_PATH = path.join(__dirname, 'videos.json');

/* -------------------------------------------------------------------------
   Storage — flat JSON file for an MVP / single-instance deploy. Swap this
   for a real database (Postgres, SQLite, etc.) once you outgrow it; only
   loadStore/saveStore need to change, everything else reads the in-memory
   `videos` array.
------------------------------------------------------------------------- */
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return []; }
}
function saveStore(list) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}
let videos = loadStore();

// getFile results (file_path) expire ~1hr on Telegram's side — cache with a
// margin so /api/stream doesn't hit getFile on every single request.
const fileCache = new Map(); // file_id -> { path, expires }
async function resolveFilePath(fileId) {
  const cached = fileCache.get(fileId);
  if (cached && cached.expires > Date.now()) return cached.path;
  const r = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const data = await r.json();
  if (!data.ok) throw new Error('getFile failed: ' + JSON.stringify(data));
  fileCache.set(fileId, { path: data.result.file_path, expires: Date.now() + 50 * 60 * 1000 });
  return data.result.file_path;
}

// Stable, cosmetic "likes" count derived from the video id — replace with
// real analytics later if you want genuine engagement numbers.
function pseudoLikes(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = 800 + (h % 62000);
  return n > 999 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/* -------------------------------------------------------------------------
   Admin auth — gates the revenue dashboard, which is intentionally NOT in
   /public and has no link anywhere in the viewer-facing app. A session
   cookie is the only way in; sessions live in memory (fine for a single
   instance — swap for a shared store if you ever run more than one).
------------------------------------------------------------------------- */
const SESSION_COOKIE = 'zsess';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token -> expiresAt

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const expires = token && sessions.get(token);
  if (expires && expires > Date.now()) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  const expires = token && sessions.get(token);
  if (expires && expires > Date.now()) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'private', 'login.html'));
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !timingSafeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.get('/admin/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/admin');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

/* -------------------------------------------------------------------------
   Telegram webhook — receives every new post from your private group/
   channel. Only messages from SOURCE_CHAT_ID are accepted, so even if the
   bot ends up in other chats, nothing else leaks into the app.
------------------------------------------------------------------------- */
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.sendStatus(200); // ack Telegram immediately, process after
  const update = req.body;
  const msg = update.channel_post || update.message;
  if (!msg || !msg.video) return;
  if (String(msg.chat.id) !== String(SOURCE_CHAT_ID)) return;

  const id = `${msg.chat.id}_${msg.message_id}`;
  if (videos.some(v => v.id === id)) return; // dedupe (e.g. webhook retries)

  videos.push({
    id,
    fileId: msg.video.file_id,
    caption: msg.caption || '',
    duration: msg.video.duration || null,
    createdAt: (msg.date || Date.now() / 1000) * 1000,
  });
  saveStore(videos);
  console.log(`Indexed new clip ${id} (${videos.length} total)`);
});

/* -------------------------------------------------------------------------
   Public API — this is ALL the Mini App's frontend ever talks to. It never
   returns the source chat id, the file_id, or the bot token, so the origin
   group/channel stays completely hidden from end users.
------------------------------------------------------------------------- */
app.get('/api/videos', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const sorted = [...videos].sort((a, b) => b.createdAt - a.createdAt);
  const page = sorted.slice(offset, offset + limit);
  res.json(page.map(v => ({
    id: v.id,
    caption: v.caption,
    creator: BRAND_NAME,
    likes: pseudoLikes(v.id),
    streamUrl: `/api/stream/${v.id}`,
  })));
});

app.get('/api/stream/:id', async (req, res) => {
  try {
    const video = videos.find(v => v.id === req.params.id);
    if (!video) return res.sendStatus(404);
    const filePath = await resolveFilePath(video.fileId);
    const upstream = await fetch(`${TG_FILE_BASE}/${filePath}`, {
      headers: req.headers.range ? { range: req.headers.range } : {},
    });
    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    upstream.body.pipe(res);
  } catch (e) {
    console.error('stream error', e);
    res.sendStatus(502);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, videos: videos.length }));

app.listen(PORT, () => console.log(`Zena server listening on :${PORT}`));
