CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_user_id INTEGER UNIQUE,
  telegram_username TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS players_telegram_username_ci
  ON players(lower(telegram_username)) WHERE telegram_username IS NOT NULL;
