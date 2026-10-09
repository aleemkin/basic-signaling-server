-- Cloudflare D1 SQLite Schema for Signaling Server
-- Stores ephemeral channel data, encrypted connection metadata, and TTL expiration

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  secret_hash TEXT,
  etag TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Index for fast lookup of active channels and cron purging of expired records
CREATE INDEX IF NOT EXISTS idx_channels_expires ON channels(expires_at);
CREATE INDEX IF NOT EXISTS idx_channels_updated ON channels(updated_at);

