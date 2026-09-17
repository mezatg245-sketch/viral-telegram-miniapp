CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  language TEXT DEFAULT 'en',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  caption TEXT,
  duration INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  views INTEGER DEFAULT 0,
  UNIQUE(telegram_chat_id, telegram_message_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  video_id INTEGER,
  event_type TEXT NOT NULL,
  provider TEXT,
  value REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type_time
ON events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_videos_created
ON videos(created_at DESC);
