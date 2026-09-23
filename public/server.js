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

  // GitHub persistence
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_PATH = 'videos.json',
  GITHUB_BRANCH = 'main',
} = process.env;


/* ============================================================
   REQUIRED ENVIRONMENT VARIABLES
============================================================ */

if (
  !BOT_TOKEN ||
  !WEBHOOK_SECRET ||
  !SOURCE_CHAT_ID ||
  !ADMIN_PASSWORD
) {
  console.error(
    'Missing BOT_TOKEN, WEBHOOK_SECRET, SOURCE_CHAT_ID, or ADMIN_PASSWORD.'
  );

  process.exit(1);
}


/* ============================================================
   TELEGRAM
============================================================ */

const TG_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

const TG_FILE_BASE =
  `https://api.telegram.org/file/bot${BOT_TOKEN}`;


/* ============================================================
   LOCAL CACHE
============================================================ */

/*
  This file is ONLY a temporary cache.

  Do NOT rely on this file for permanent storage on Render Free.

  The permanent copy is stored in GitHub.
*/

const LOCAL_STORE_PATH =
  path.join(__dirname, 'videos.json');


function loadLocalStore() {
  try {
    const raw =
      fs.readFileSync(
        LOCAL_STORE_PATH,
        'utf8'
      );

    const parsed =
      JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];

  } catch {
    return [];
  }
}


function saveLocalStore(list) {
  try {
    fs.writeFileSync(
      LOCAL_STORE_PATH,
      JSON.stringify(
        list,
        null,
        2
      )
    );

  } catch (err) {

    /*
      Render Free has an ephemeral filesystem.
      Failure here is not fatal because GitHub
      is the persistent storage.
    */

    console.warn(
      'Could not write local videos.json:',
      err.message
    );
  }
}


let videos =
  loadLocalStore();


/* ============================================================
   GITHUB CONFIGURATION
============================================================ */

const GITHUB_ENABLED =
  Boolean(
    GITHUB_TOKEN &&
    GITHUB_OWNER &&
    GITHUB_REPO
  );


if (!GITHUB_ENABLED) {

  console.warn(
    'GitHub persistence is NOT configured.'
  );

  console.warn(
    'Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in Render.'
  );
}


/* ============================================================
   GITHUB API
============================================================ */

const githubHeaders = {

  Accept:
    'application/vnd.github+json',

  Authorization:
    `Bearer ${GITHUB_TOKEN || ''}`,

  'X-GitHub-Api-Version':
    '2026-03-10',

  'User-Agent':
    'Zena-Originals-Render-App',
};


function githubContentsUrl() {

  return (
    `https://api.github.com/repos/` +
    `${encodeURIComponent(GITHUB_OWNER)}/` +
    `${encodeURIComponent(GITHUB_REPO)}/contents/` +
    GITHUB_PATH
      .split('/')
      .map(encodeURIComponent)
      .join('/')
  );
}


async function githubRequest(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          ...githubHeaders,
          ...(options.headers || {}),
        },
      }
    );


  const text =
    await response.text();


  let data;


  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text,
    };

  }


  if (!response.ok) {

    const error =
      new Error(
        `GitHub API ${response.status}: ${
          data.message ||
          text ||
          response.statusText
        }`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }


  return data;
}


/* ============================================================
   LOAD VIDEOS FROM GITHUB
============================================================ */

async function loadVideosFromGitHub() {

  if (!GITHUB_ENABLED) {
    return null;
  }


  try {

    const data =
      await githubRequest(
        githubContentsUrl() +
        `?ref=${encodeURIComponent(
          GITHUB_BRANCH
        )}`
      );


    if (!data.content) {

      throw new Error(
        'GitHub response did not contain file content'
      );
    }


    const decoded =
      Buffer.from(
        data.content.replace(/\n/g, ''),
        'base64'
      ).toString('utf8');


    const parsed =
      JSON.parse(decoded);


    if (!Array.isArray(parsed)) {

      throw new Error(
        'GitHub videos.json is not an array'
      );
    }


    return {

      videos:
        parsed,

      sha:
        data.sha,

    };

  } catch (err) {

    /*
      404 means videos.json does not exist yet.
    */

    if (err.status === 404) {

      console.log(
        `GitHub file ${GITHUB_PATH} does not exist yet.`
      );

      return {

        videos: [],

        sha: null,

      };
    }


    console.error(
      'Could not load videos.json from GitHub:',
      err.message
    );


    return null;
  }
}


/* ============================================================
   GITHUB SHA
============================================================ */

let githubSha = null;


/* ============================================================
   GITHUB WRITE QUEUE
============================================================ */

/*
  Prevent multiple Telegram webhook events from
  simultaneously trying to overwrite videos.json.
*/

let githubWriteQueue =
  Promise.resolve();


/* ============================================================
   SAVE VIDEOS TO GITHUB
============================================================ */

async function saveVideosToGitHub(
  list,
  attempt = 0
) {

  if (!GITHUB_ENABLED) {

    console.warn(
      'Skipping GitHub save because GitHub persistence is not configured.'
    );

    return false;
  }


  const content =
    Buffer.from(
      JSON.stringify(
        list,
        null,
        2
      ) + '\n',
      'utf8'
    ).toString('base64');


  const body = {

    message:
      `Update videos.json (${list.length} videos)`,

    content,

    branch:
      GITHUB_BRANCH,

    committer: {

      name:
        'Zena Originals Bot',

      email:
        'zena-bot@users.noreply.github.com',

    },

  };


  /*
    GitHub requires the existing file SHA
    when updating an existing file.
  */

  if (githubSha) {
    body.sha =
      githubSha;
  }


  try {

    const data =
      await githubRequest(
        githubContentsUrl(),
        {

          method:
            'PUT',

          body:
            JSON.stringify(body),

          headers: {

            'Content-Type':
              'application/json',

          },

        }
      );


    githubSha =
      data.content?.sha ||
      githubSha;


    console.log(
      `Persisted ${list.length} videos to GitHub.`
    );


    return true;

  } catch (err) {

    /*
      409 = another update happened first.

      Refresh SHA and retry.
    */

    if (
      err.status === 409 &&
      attempt < 2
    ) {

      console.warn(
        'GitHub videos.json changed concurrently. Retrying...'
      );


      const remote =
        await loadVideosFromGitHub();


      if (remote) {

        /*
          Important:
          use the latest GitHub SHA.
        */

        githubSha =
          remote.sha;
      }


      return saveVideosToGitHub(
        list,
        attempt + 1
      );
    }


    console.error(
      'Failed to persist videos.json to GitHub:',
      err.message
    );


    return false;
  }
}


/* ============================================================
   QUEUE GITHUB SAVE
============================================================ */

function queueGitHubSave(list) {

  /*
    Make a copy so later modifications to
    the videos array don't affect this write.
  */

  const snapshot =
    JSON.parse(
      JSON.stringify(list)
    );


  githubWriteQueue =
    githubWriteQueue
      .then(
        () =>
          saveVideosToGitHub(
            snapshot
          )
      )
      .catch(err => {

        console.error(
          'GitHub persistence queue error:',
          err
        );

      });


  return githubWriteQueue;
}


/* ============================================================
   INITIALIZE VIDEO STORE
============================================================ */

async function initializeStore() {

  /*
    If GitHub isn't configured,
    fall back to local storage.
  */

  if (!GITHUB_ENABLED) {

    console.log(
      `Loaded ${videos.length} videos from local cache.`
    );

    return;
  }


  const remote =
    await loadVideosFromGitHub();


  /*
    GitHub failed.
    Use whatever local cache is available.
  */

  if (!remote) {

    console.log(
      `GitHub unavailable. Using local cache with ${videos.length} videos.`
    );

    return;
  }


  githubSha =
    remote.sha;


  /*
    GitHub has content.
    This is the source of truth.
  */

  if (
    remote.videos.length > 0 ||
    videos.length === 0
  ) {

    videos =
      remote.videos;

    saveLocalStore(
      videos
    );


    console.log(
      `Loaded ${videos.length} videos from GitHub.`
    );

    return;
  }


  /*
    If GitHub is empty but local cache contains videos,
    preserve the local videos by uploading them.
  */

  console.log(
    `GitHub manifest is empty. Preserving ${videos.length} local videos.`
  );


  await queueGitHubSave(
    videos
  );
}


/* ============================================================
   TELEGRAM FILE CACHE
============================================================ */

const fileCache =
  new Map();


async function resolveFilePath(
  fileId
) {

  const cached =
    fileCache.get(
      fileId
    );


  if (
    cached &&
    cached.expires > Date.now()
  ) {

    return cached.path;
  }


  const response =
    await fetch(
      `${TG_API}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    );


  const data =
    await response.json();


  if (!data.ok) {

    throw new Error(
      'getFile failed: ' +
      JSON.stringify(data)
    );
  }


  fileCache.set(
    fileId,
    {

      path:
        data.result.file_path,

      expires:
        Date.now() +
        50 * 60 * 1000,

    }
  );


  return data.result.file_path;
}


/* ============================================================
   PSEUDO LIKES
============================================================ */

function pseudoLikes(id) {

  let h = 0;


  for (
    const ch of id
  ) {

    h =
      (
        h * 31 +
        ch.charCodeAt(0)
      ) >>> 0;
  }


  const n =
    800 +
    (h % 62000);


  return n > 999

    ? (
        n / 1000
      ).toFixed(1) + 'k'

    : String(n);
}


/* ============================================================
   EXPRESS
============================================================ */

const app =
  express();


app.use(
  express.json({
    limit: '1mb',
  })
);


app.use(
  cookieParser()
);


app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


/* ============================================================
   ADMIN AUTHENTICATION
============================================================ */

const SESSION_COOKIE =
  'zsess';


const SESSION_TTL_MS =
  7 *
  24 *
  60 *
  60 *
  1000;


const sessions =
  new Map();


function timingSafeEqual(
  a,
  b
) {

  const bufA =
    Buffer.from(
      String(a)
    );


  const bufB =
    Buffer.from(
      String(b)
    );


  if (
    bufA.length !==
    bufB.length
  ) {

    return false;
  }


  return crypto.timingSafeEqual(
    bufA,
    bufB
  );
}


function requireAdmin(
  req,
  res,
  next
) {

  const token =
    req.cookies[
      SESSION_COOKIE
    ];


  const expires =
    token &&
    sessions.get(
      token
    );


  if (
    expires &&
    expires > Date.now()
  ) {

    return next();
  }


  res.redirect(
    '/admin'
  );
}


/* ============================================================
   ADMIN LOGIN
============================================================ */

app.get(
  '/admin',
  (req, res) => {

    const token =
      req.cookies[
        SESSION_COOKIE
      ];


    const expires =
      token &&
      sessions.get(
        token
      );


    if (
      expires &&
      expires > Date.now()
    ) {

      return res.redirect(
        '/admin/dashboard'
      );
    }


    res.sendFile(
      path.join(
        __dirname,
        'private',
        'login.html'
      )
    );
  }
);


app.post(
  '/admin/login',
  (req, res) => {

    const {
      password
    } = req.body || {};


    if (
      !password ||
      !timingSafeEqual(
        password,
        ADMIN_PASSWORD
      )
    ) {

      return res.status(
        401
      ).json({
        ok: false,
      });
    }


    const token =
      crypto
        .randomBytes(32)
        .toString('hex');


    sessions.set(
      token,
      Date.now() +
      SESSION_TTL_MS
    );


    res.cookie(
      SESSION_COOKIE,
      token,
      {

        httpOnly:
          true,

        sameSite:
          'lax',

        secure:
          req.secure ||
          req.headers[
            'x-forwarded-proto'
          ] === 'https',

        maxAge:
          SESSION_TTL_MS,

      }
    );


    res.json({
      ok: true,
    });
  }
);


/* ============================================================
   ADMIN LOGOUT
============================================================ */

app.get(
  '/admin/logout',
  (req, res) => {

    const token =
      req.cookies[
        SESSION_COOKIE
      ];


    if (token) {

      sessions.delete(
        token
      );
    }


    res.clearCookie(
      SESSION_COOKIE
    );


    res.redirect(
      '/admin'
    );
  }
);


/* ============================================================
   ADMIN DASHBOARD
============================================================ */

app.get(
  '/admin/dashboard',
  requireAdmin,
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'private',
        'dashboard.html'
      )
    );
  }
);


/* ============================================================
   TELEGRAM WEBHOOK
============================================================ */

app.post(
  `/webhook/${WEBHOOK_SECRET}`,
  (req, res) => {

    /*
      Respond immediately to Telegram.
    */

    res.sendStatus(
      200
    );


    const update =
      req.body;


    /*
      Telegram channel posts use channel_post.
      Regular chats use message.
    */

    const msg =
      update.channel_post ||
      update.message;


    /*
      Only videos.
    */

    if (
      !msg ||
      !msg.video
    ) {

      return;
    }


    /*
      Only accept videos
      from the configured source.
    */

    if (
      String(
        msg.chat.id
      ) !==
      String(
        SOURCE_CHAT_ID
      )
    ) {

      console.log(
        'Ignored video from unauthorized chat:',
        msg.chat.id
      );

      return;
    }


    /*
      Unique ID:
      Telegram chat + message ID
    */

    const id =
      `${msg.chat.id}_${msg.message_id}`;


    /*
      Prevent duplicates.
    */

    if (
      videos.some(
        v => v.id === id
      )
    ) {

      console.log(
        `Ignoring duplicate video ${id}`
      );

      return;
    }


    /*
      Create video record.
    */

    const video = {

      id,

      fileId:
        msg.video.file_id,

      caption:
        msg.caption || '',

      duration:
        msg.video.duration ||
        null,

      createdAt:
        (
          msg.date ||
          Date.now() / 1000
        ) * 1000,

    };


    /*
      Add to memory.
    */

    videos.push(
      video
    );


    /*
      Newest first.
    */

    videos.sort(
      (a, b) =>
        b.createdAt -
        a.createdAt
    );


    /*
      Local cache.
    */

    saveLocalStore(
      videos
    );


    /*
      Permanent GitHub storage.
    */

    queueGitHubSave(
      videos
    );


    console.log(
      `Indexed new clip ${id} (${videos.length} total)`
    );
  }
);


/* ============================================================
   PUBLIC VIDEOS API
============================================================ */

app.get(
  '/api/videos',
  (req, res) => {

    const limit =
      Math.min(
        parseInt(
          req.query.limit
        ) || 20,
        50
      );


    const offset =
      Math.max(
        parseInt(
          req.query.offset
        ) || 0,
        0
      );


    /*
      Sort newest first.
    */

    const sorted =
      [...videos].sort(
        (a, b) =>
          b.createdAt -
          a.createdAt
      );


    const page =
      sorted.slice(
        offset,
        offset + limit
      );


    /*
      Never expose:
      - Telegram bot token
      - Telegram file ID
      - source chat ID
    */

    res.json(
      page.map(
        v => ({

          id:
            v.id,

          caption:
            v.caption,

          creator:
            BRAND_NAME,

          likes:
            pseudoLikes(
              v.id
            ),

          streamUrl:
            `/api/stream/${encodeURIComponent(
              v.id
            )}`,

        })
      )
    );
  }
);


/* ============================================================
   VIDEO STREAMING
============================================================ */

app.get(
  '/api/stream/:id',
  async (req, res) => {

    try {

      const video =
        videos.find(
          v =>
            v.id ===
            req.params.id
        );


      if (!video) {

        return res.sendStatus(
          404
        );
      }


      /*
        Get Telegram's temporary file path.
      */

      const filePath =
        await resolveFilePath(
          video.fileId
        );


      /*
        Forward Range requests.
        This allows browser/mobile video seeking
        and progressive playback.
      */

      const upstream =
        await fetch(
          `${TG_FILE_BASE}/${filePath}`,
          {

            headers:
              req.headers.range
                ? {
                    range:
                      req.headers.range,
                  }
                : {},

          }
        );


      res.status(
        upstream.status
      );


      /*
        Forward important video headers.
      */

      [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
      ].forEach(
        header => {

          const value =
            upstream.headers.get(
              header
            );


          if (value) {

            res.setHeader(
              header,
              value
            );
          }
        }
      );


      if (
        !upstream.body
      ) {

        return res.sendStatus(
          502
        );
      }


      /*
        Pipe Telegram video
        to the Mini App.
      */

      upstream.body.pipe(
        res
      );

    } catch (err) {

      console.error(
        'stream error:',
        err
      );


      if (
        !res.headersSent
      ) {

        res.sendStatus(
          502
        );

      } else {

        res.end();
      }
    }
  }
);


/* ============================================================
   HEALTH CHECK
============================================================ */

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      ok:
        true,

      videos:
        videos.length,

      persistence:
        GITHUB_ENABLED
          ? 'github'
          : 'local-only',

      githubConfigured:
        GITHUB_ENABLED,

    });
  }
);


/* ============================================================
   START SERVER
============================================================ */

async function start() {

  /*
    Load persistent videos from GitHub
    before starting the HTTP server.
  */

  await initializeStore();


  app.listen(
    PORT,
    () => {

      console.log(
        `Zena server listening on :${PORT}`
      );


      console.log(
        `Video count: ${videos.length}`
      );


      console.log(
        `Persistence: ${
          GITHUB_ENABLED
            ? `GitHub (${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_PATH})`
            : 'LOCAL ONLY — configure GitHub persistence'
        }`
      );
    }
  );
}


/* ============================================================
   START
============================================================ */

start().catch(
  err => {

    console.error(
      'Fatal startup error:',
      err
    );


    process.exit(
      1
    );
  }
);
