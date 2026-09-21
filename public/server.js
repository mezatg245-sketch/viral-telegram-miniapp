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
  console.error(
    'Missing BOT_TOKEN, WEBHOOK_SECRET, SOURCE_CHAT_ID, or ADMIN_PASSWORD — check your .env (see .env.example)'
  );
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE_BASE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const STORE_PATH = path.join(__dirname, 'videos.json');

/* -------------------------------------------------------------------------
   Storage — flat JSON file for an MVP / single-instance deploy.
------------------------------------------------------------------------- */

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveStore(list) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}

let videos = loadStore();

/* -------------------------------------------------------------------------
   Telegram file-path cache

   Telegram file paths expire after some time, so we cache them temporarily.
------------------------------------------------------------------------- */

const fileCache = new Map();

async function resolveFilePath(fileId) {
  const cached = fileCache.get(fileId);

  if (cached && cached.expires > Date.now()) {
    return cached.path;
  }

  const r = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const data = await r.json();

  if (!data.ok) {
    throw new Error('getFile failed: ' + JSON.stringify(data));
  }

  fileCache.set(fileId, {
    path: data.result.file_path,
    expires: Date.now() + 50 * 60 * 1000,
  });

  return data.result.file_path;
}

/* -------------------------------------------------------------------------
   Cosmetic likes count

   This is not real engagement data.
------------------------------------------------------------------------- */

function pseudoLikes(id) {
  let h = 0;

  for (const ch of id) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }

  const n = 800 + (h % 62000);

  return n > 999
    ? (n / 1000).toFixed(1) + 'k'
    : String(n);
}

/* -------------------------------------------------------------------------
   Express
------------------------------------------------------------------------- */

const app = express();

app.use(express.json());
app.use(cookieParser());

/*
  The Mini App files are served from /public.
*/
app.use(express.static(path.join(__dirname, 'public')));

/* -------------------------------------------------------------------------
   Admin authentication
------------------------------------------------------------------------- */

const SESSION_COOKIE = 'zsess';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const expires = token && sessions.get(token);

  if (expires && expires > Date.now()) {
    return next();
  }

  res.redirect('/admin');
}

/* -------------------------------------------------------------------------
   Admin login
------------------------------------------------------------------------- */

app.get('/admin', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  const expires = token && sessions.get(token);

  if (expires && expires > Date.now()) {
    return res.redirect('/admin/dashboard');
  }

  res.sendFile(
    path.join(__dirname, 'private', 'login.html')
  );
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};

  if (!password || !timingSafeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      ok: false,
    });
  }

  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(
    token,
    Date.now() + SESSION_TTL_MS
  );

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_TTL_MS,
  });

  res.json({
    ok: true,
  });
});

app.get('/admin/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];

  if (token) {
    sessions.delete(token);
  }

  res.clearCookie(SESSION_COOKIE);

  res.redirect('/admin');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  res.sendFile(
    path.join(__dirname, 'private', 'dashboard.html')
  );
});

/* -------------------------------------------------------------------------
   Telegram webhook

   Receives new video posts from your source Telegram channel/group.
------------------------------------------------------------------------- */

app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  /*
    Respond to Telegram immediately.
  */
  res.sendStatus(200);

  const update = req.body;

  const msg =
    update.channel_post ||
    update.message;

  /*
    Only process video messages.
  */
  if (!msg || !msg.video) {
    return;
  }

  /*
    Only accept videos from the configured source chat.
  */
  if (String(msg.chat.id) !== String(SOURCE_CHAT_ID)) {
    return;
  }

  /*
    Create a unique ID from chat + message ID.
  */
  const id =
    `${msg.chat.id}_${msg.message_id}`;

  /*
    Prevent duplicate webhook processing.
  */
  if (videos.some(v => v.id === id)) {
    return;
  }

  /*
    Save the video information.
  */
  videos.push({
    id,

    fileId:
      msg.video.file_id,

    caption:
      msg.caption || '',

    duration:
      msg.video.duration || null,

    createdAt:
      (msg.date || Date.now() / 1000) * 1000,
  });

  saveStore(videos);

  console.log(
    `Indexed new clip ${id} (${videos.length} total)`
  );
});

/* -------------------------------------------------------------------------
   Public videos API

   The Mini App uses this endpoint to get published videos.
------------------------------------------------------------------------- */

app.get('/api/videos', (req, res) => {
  const limit = Math.min(
    parseInt(req.query.limit) || 20,
    50
  );

  const offset = Math.max(
    parseInt(req.query.offset) || 0,
    0
  );

  /*
    Newest videos first.
  */
  const sorted = [...videos].sort(
    (a, b) => b.createdAt - a.createdAt
  );

  const page = sorted.slice(
    offset,
    offset + limit
  );

  /*
    Do NOT expose:
      - source chat ID
      - Telegram file ID
      - bot token
  */
  res.json(
    page.map(v => ({
      id: v.id,

      caption:
        v.caption,

      creator:
        BRAND_NAME,

      likes:
        pseudoLikes(v.id),

      streamUrl:
        `/api/stream/${v.id}`,
    }))
  );
});

/* -------------------------------------------------------------------------
   Video streaming

   The Mini App requests:
     /api/stream/:id

   The server gets the Telegram file path and proxies the video.
------------------------------------------------------------------------- */

app.get('/api/stream/:id', async (req, res) => {
  try {
    const video = videos.find(
      v => v.id === req.params.id
    );

    if (!video) {
      return res.sendStatus(404);
    }

    /*
      Resolve Telegram file path.
    */
    const filePath =
      await resolveFilePath(video.fileId);

    /*
      Forward HTTP Range requests so video seeking/
      progressive playback works correctly.
    */
    const upstream = await fetch(
      `${TG_FILE_BASE}/${filePath}`,
      {
        headers:
          req.headers.range
            ? {
                range: req.headers.range,
              }
            : {},
      }
    );

    res.status(upstream.status);

    /*
      Forward important video headers.
    */
    [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ].forEach(header => {
      const value =
        upstream.headers.get(header);

      if (value) {
        res.setHeader(
          header,
          value
        );
      }
    });

    /*
      Stream Telegram's response directly
      to the Mini App.
    */
    upstream.body.pipe(res);

  } catch (e) {
    console.error(
      'stream error',
      e
    );

    res.sendStatus(502);
  }
});

/* -------------------------------------------------------------------------
   Health check
------------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    videos: videos.length,
  });
});

/* -------------------------------------------------------------------------
   Start server
------------------------------------------------------------------------- */

app.listen(
  PORT,
  () => {
    console.log(
      `Zena server listening on :${PORT}`
    );
  }
);
