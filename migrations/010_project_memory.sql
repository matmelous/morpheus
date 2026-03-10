-- Phase 4: Project-specific memory (scoped to project_id)
-- Separate from user_shared_memory (which is global across all projects/tasks)

CREATE TABLE IF NOT EXISTS project_memory (
  project_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, phone),
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_memory_phone ON project_memory (phone);
