-- Tier 2 schema. CREATE TABLE IF NOT EXISTS statements are re-run safe.
-- The ALTER TABLE statements at the bottom are NOT re-run safe (SQLite has no
-- IF NOT EXISTS for columns) — they are last so a re-run creates nothing and
-- fails harmlessly on the first duplicate-column error.

-- Item 8: single-row-per-user preference blob (pinned favorites, reminder
-- toggles, ui flags)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Item 9: web push subscriptions
CREATE TABLE IF NOT EXISTS push_subscription (
  user_id       TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  device_label  TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  PRIMARY KEY (user_id, endpoint)
);

-- Item 9: dedupe ledger so a reminder fires at most once per day
CREATE TABLE IF NOT EXISTS push_sent (
  user_id  TEXT NOT NULL,
  date     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, kind)
);

-- Item 10: TP auth lifecycle columns  |  Item 9: user timezone
ALTER TABLE tp_auth ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tp_auth ADD COLUMN last_refreshed_at INTEGER;
ALTER TABLE tp_auth ADD COLUMN expired_at INTEGER;
ALTER TABLE tp_auth ADD COLUMN warned_at INTEGER;
ALTER TABLE users ADD COLUMN tz TEXT;
