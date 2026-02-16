-- Phase 5: Token usage telemetry, budgets and aggregates

CREATE TABLE IF NOT EXISTS token_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  phone TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  stage TEXT NOT NULL, -- planner|runner
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, -- provider|estimated
  budget_before INTEGER,
  budget_after INTEGER,
  compacted INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES task_runs (run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_token_usage_task_created_at ON token_usage_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_run_created_at ON token_usage_events (run_id, created_at);

ALTER TABLE task_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
