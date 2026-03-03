-- LongRun session persistence
-- Tracks multi-turn requirements gathering and recursive task execution state
CREATE TABLE IF NOT EXISTS longrun_sessions (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_cwd TEXT NOT NULL,
  -- status: gathering | confirming | running | paused | completed | failed
  status TEXT NOT NULL DEFAULT 'gathering',
  feature_uuid TEXT,
  feature_title TEXT,
  -- spec_json: JSON-stringified spec object (partial during gathering, full after confirm)
  spec_json TEXT,
  -- current_task_uuid: UUID of the task being executed, or "validation:<epic-uuid>" during epic validation
  current_task_uuid TEXT,
  auto_correct_attempt INTEGER NOT NULL DEFAULT 0,
  -- preferred_runner: forced runner (if user specified a single runner)
  preferred_runner TEXT,
  -- runner_priority: JSON array of runners in priority order
  runner_priority TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_longrun_sessions_task_id
  ON longrun_sessions (task_id);

CREATE INDEX IF NOT EXISTS idx_longrun_sessions_phone_status
  ON longrun_sessions (phone, status);
