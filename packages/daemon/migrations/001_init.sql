-- Single-row JSON config + runtime state (kept as JSON so new settings never need a migration).
CREATE TABLE IF NOT EXISTS bot_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Everything notable the bot did or saw: rotations, dry-run plans, deposits, holds, errors.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

-- Every order that filled (even partially).
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rotation_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  base REAL NOT NULL,
  price REAL NOT NULL
);

-- Deposits / withdrawals seen as wallet changes the bot did not cause.
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  value_xmr REAL NOT NULL,
  dist REAL,
  action TEXT NOT NULL
);

-- Equity snapshots (one per tick at most every 10 minutes) for the history chart.
CREATE TABLE IF NOT EXISTS snapshots (
  ts INTEGER PRIMARY KEY,
  xmr REAL NOT NULL,
  btc REAL NOT NULL,
  price REAL NOT NULL,
  equity_xmr REAL NOT NULL
);
