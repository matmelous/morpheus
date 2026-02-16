-- Per-task execution queue for user messages received while a run is active.

CREATE TABLE IF NOT EXISTS task_execution_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_execution_queue_task_id_id
  ON task_execution_queue (task_id, id);
