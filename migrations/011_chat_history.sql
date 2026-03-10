-- Phase 5: Global chat history
-- Stores conversation history (user messages, planner replies, and action summaries)
-- This is separate from user_shared_memory (which stores consolidated preferences/patterns)

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  action_summary TEXT, -- optional summary of actions executed (JSON string or plain text)
  created_at TEXT NOT NULL,
  FOREIGN KEY (phone) REFERENCES users (phone) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_history_phone_created_at ON chat_history (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_history_task_id ON chat_history (task_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_phone_project_id ON chat_history (phone, project_id);
