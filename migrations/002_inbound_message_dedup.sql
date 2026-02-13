-- Prevent duplicate processing when WhatsApp API retries deliveries or when multiple webhooks exist.

CREATE TABLE IF NOT EXISTS inbound_message_dedup (
  dedup_id TEXT PRIMARY KEY, -- instanceId:messageId
  instance_id TEXT,
  message_id TEXT,
  phone TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_message_dedup_phone_created_at
  ON inbound_message_dedup (phone, created_at);

