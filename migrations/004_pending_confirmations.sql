-- Phase 2: Pending confirmations (e.g. purchase/checkout confirmation)

CREATE TABLE IF NOT EXISTS pending_confirmations (
  phone TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- e.g. "purchase_confirmation"
  task_id TEXT NOT NULL,
  runner_kind TEXT NOT NULL,
  resume_prompt TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_confirmations_expires_at ON pending_confirmations (expires_at);

