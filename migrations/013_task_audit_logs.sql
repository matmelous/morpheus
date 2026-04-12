CREATE TABLE IF NOT EXISTS task_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id TEXT,
  stage TEXT NOT NULL,      -- inbound|planner|executor|longrun|queue|system
  level TEXT NOT NULL,      -- debug|info|warn|error
  event TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES task_runs (run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_audit_logs_task_id_id ON task_audit_logs (task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_audit_logs_run_id_id ON task_audit_logs (run_id, id);
