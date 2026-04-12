CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  stream TEXT NOT NULL, -- stdout|stderr|update|system
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES task_runs (run_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_run_logs_run_id_id ON task_run_logs (run_id, id);
CREATE INDEX IF NOT EXISTS idx_task_run_logs_task_id_id ON task_run_logs (task_id, id);
