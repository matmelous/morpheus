-- Phase 1: Initial schema for personal-mac-interface (PMI)
-- Note: We intentionally keep "status" fields as TEXT without strict CHECK constraints
-- to allow evolving state machines without migration churn.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  default_project_id TEXT,
  orchestrator_provider_override TEXT,
  runner_override TEXT,
  focused_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_task_selections (
  phone TEXT PRIMARY KEY,
  original_message TEXT NOT NULL,
  candidate_task_ids TEXT NOT NULL, -- JSON array string
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  project_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  runner_kind TEXT NOT NULL,
  status TEXT NOT NULL, -- queued|running|waiting|done|error|cancelled
  title TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  last_update TEXT,
  last_error TEXT,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_phone_created_at ON tasks (phone, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_phone_status ON tasks (phone, status);

CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL, -- user|assistant|system
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task_created_at ON task_messages (task_id, created_at);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  runner_kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  command TEXT NOT NULL, -- JSON string with {command,args} (prompt may be redacted)
  status TEXT NOT NULL, -- queued|running|done|error|cancelled|blocked
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  artifacts_dir TEXT NOT NULL,
  summary_text TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_created_at ON task_runs (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status_created_at ON task_runs (status, created_at);

CREATE TABLE IF NOT EXISTS agent_slots (
  slot_id TEXT PRIMARY KEY,
  runner_kind TEXT NOT NULL,
  status TEXT NOT NULL, -- idle|busy|offline|error
  current_task_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_task_id) REFERENCES tasks (task_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

