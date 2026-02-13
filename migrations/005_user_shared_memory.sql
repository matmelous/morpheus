-- Phase 3: Shared per-user memory (across tasks/projects/runners)

CREATE TABLE IF NOT EXISTS user_shared_memory (
  phone TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE
);

