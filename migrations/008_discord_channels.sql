-- Phase 6: Discord channel enablement map

CREATE TABLE IF NOT EXISTS discord_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_channels_guild_enabled
  ON discord_channels (guild_id, enabled);
