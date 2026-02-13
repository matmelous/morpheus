import { getDb } from '../db/index.js';
import { makeId } from '../utils/ids.js';

function nowIso() {
  return new Date().toISOString();
}

class TaskStore {
  constructor() {
    this.db = getDb();
  }

  ensureUser(phone) {
    const existing = this.db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
    if (existing) {
      this.db.prepare('UPDATE users SET updated_at = ? WHERE phone = ?').run(nowIso(), phone);
      return;
    }

    this.db.prepare(`
      INSERT INTO users (phone, default_project_id, orchestrator_provider_override, runner_override, focused_task_id, created_at, updated_at)
      VALUES (?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(phone, nowIso(), nowIso());
  }

  getUser(phone) {
    return this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) || null;
  }

  getUserSharedMemory(phone) {
    return this.db.prepare('SELECT content, updated_at FROM user_shared_memory WHERE phone = ?').get(phone) || null;
  }

  setUserSharedMemory(phone, content) {
    this.ensureUser(phone);
    const c = String(content || '').trim();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO user_shared_memory (phone, content, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(phone, c, now, now);
  }

  appendUserSharedMemory(phone, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const prev = this.getUserSharedMemory(phone)?.content || '';
    const next = prev
      ? `${prev}\n\n- ${t}`
      : `- ${t}`;
    this.setUserSharedMemory(phone, next);
  }

  clearUserSharedMemory(phone) {
    this.db.prepare('DELETE FROM user_shared_memory WHERE phone = ?').run(phone);
  }

  setUserDefaultProject(phone, projectId) {
    this.ensureUser(phone);
    this.db.prepare('UPDATE users SET default_project_id = ?, updated_at = ? WHERE phone = ?')
      .run(projectId || null, nowIso(), phone);
  }

  setUserRunnerOverride(phone, runnerKind) {
    this.ensureUser(phone);
    this.db.prepare('UPDATE users SET runner_override = ?, updated_at = ? WHERE phone = ?')
      .run(runnerKind || null, nowIso(), phone);
  }

  setUserOrchestratorOverride(phone, provider) {
    this.ensureUser(phone);
    this.db.prepare('UPDATE users SET orchestrator_provider_override = ?, updated_at = ? WHERE phone = ?')
      .run(provider || null, nowIso(), phone);
  }

  setUserFocusedTask(phone, taskId) {
    this.ensureUser(phone);
    this.db.prepare('UPDATE users SET focused_task_id = ?, updated_at = ? WHERE phone = ?')
      .run(taskId || null, nowIso(), phone);
  }

  clearPendingSelection(phone) {
    this.db.prepare('DELETE FROM pending_task_selections WHERE phone = ?').run(phone);
  }

  getPendingSelection(phone) {
    return this.db.prepare('SELECT * FROM pending_task_selections WHERE phone = ?').get(phone) || null;
  }

  clearPendingConfirmation(phone) {
    this.db.prepare('DELETE FROM pending_confirmations WHERE phone = ?').run(phone);
  }

  getPendingConfirmation(phone) {
    return this.db.prepare('SELECT * FROM pending_confirmations WHERE phone = ?').get(phone) || null;
  }

  setPendingConfirmation(phone, { kind, taskId, runnerKind, resumePrompt, contextJson, expiresAtIso }) {
    this.ensureUser(phone);
    this.db.prepare(`
      INSERT INTO pending_confirmations
        (phone, kind, task_id, runner_kind, resume_prompt, context_json, created_at, expires_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        kind = excluded.kind,
        task_id = excluded.task_id,
        runner_kind = excluded.runner_kind,
        resume_prompt = excluded.resume_prompt,
        context_json = excluded.context_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(
      phone,
      String(kind || 'unknown'),
      String(taskId),
      String(runnerKind),
      String(resumePrompt),
      contextJson ? String(contextJson) : null,
      nowIso(),
      String(expiresAtIso)
    );
  }

  markInboundMessageProcessed({ instanceId, messageId, phone }) {
    if (!instanceId || !messageId) return true;
    const dedupId = `${instanceId}:${messageId}`;
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO inbound_message_dedup (dedup_id, instance_id, message_id, phone, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(dedupId, instanceId, messageId, phone || null, nowIso());

    return info.changes === 1;
  }

  setPendingSelection(phone, originalMessage, candidateTaskIds, expiresAtIso) {
    this.ensureUser(phone);
    this.db.prepare(`
      INSERT INTO pending_task_selections (phone, original_message, candidate_task_ids, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        original_message = excluded.original_message,
        candidate_task_ids = excluded.candidate_task_ids,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(phone, originalMessage, JSON.stringify(candidateTaskIds), nowIso(), expiresAtIso);
  }

  createTask({ phone, projectId, cwd, runnerKind, title }) {
    this.ensureUser(phone);

    const taskId = makeId('task');
    const createdAt = nowIso();

    this.db.prepare(`
      INSERT INTO tasks (task_id, phone, project_id, cwd, runner_kind, status, title, created_at, started_at, ended_at, last_update, last_error)
      VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, NULL, NULL, 'Waiting', NULL)
    `).run(taskId, phone, projectId, cwd, runnerKind, title || null, createdAt);

    return this.getTask(taskId);
  }

  getTask(taskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) || null;
  }

  listTasksByPhone(phone, { limit = 20 } = {}) {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE phone = ? ORDER BY created_at DESC LIMIT ?'
    ).all(phone, limit);
  }

  listActiveTasksByPhone(phone) {
    return this.db.prepare(
      `SELECT * FROM tasks
       WHERE phone = ? AND status IN ('queued','running','waiting')
       ORDER BY created_at DESC`
    ).all(phone);
  }

  listRunningTasks() {
    return this.db.prepare(
      `SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`
    ).all();
  }

  updateTask(taskId, updates) {
    const allowed = [
      'status',
      'title',
      'started_at',
      'ended_at',
      'last_update',
      'last_error',
      'runner_kind',
      'project_id',
      'cwd',
    ];

    const keys = Object.keys(updates).filter((k) => allowed.includes(k));
    if (keys.length === 0) return;

    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => updates[k]);

    this.db.prepare(`UPDATE tasks SET ${sets} WHERE task_id = ?`).run(...values, taskId);
  }

  insertTaskMessage(taskId, role, content) {
    this.db.prepare(`
      INSERT INTO task_messages (task_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, role, content, nowIso());
  }

  listTaskMessages(taskId, limit = 20) {
    return this.db.prepare(
      `SELECT role, content, created_at
       FROM task_messages
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ).all(taskId, limit).reverse();
  }

  getActiveRunForTask(taskId) {
    return this.db.prepare(
      `SELECT * FROM task_runs
       WHERE task_id = ? AND status IN ('queued','running')
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(taskId) || null;
  }

  createRun({ taskId, runnerKind, prompt, commandJson, artifactsDir, status }) {
    const runId = makeId('run');
    return this.createRunWithId({ runId, taskId, runnerKind, prompt, commandJson, artifactsDir, status });
  }

  createRunWithId({ runId, taskId, runnerKind, prompt, commandJson, artifactsDir, status }) {
    this.db.prepare(`
      INSERT INTO task_runs
        (run_id, task_id, runner_kind, prompt, command, status, blocked_reason, created_at, started_at, ended_at, exit_code, artifacts_dir, summary_text)
      VALUES
        (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL)
    `).run(runId, taskId, runnerKind, prompt, commandJson, status, nowIso(), artifactsDir);

    return this.getRun(runId);
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get(runId) || null;
  }

  listQueuedRuns(limit = 50) {
    return this.db.prepare(
      `SELECT * FROM task_runs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT ?`
    ).all(limit);
  }

  countRunningRuns() {
    return this.db.prepare(
      `SELECT COUNT(1) AS n FROM task_runs WHERE status = 'running'`
    ).get().n;
  }

  updateRun(runId, updates) {
    const allowed = [
      'status',
      'blocked_reason',
      'started_at',
      'ended_at',
      'exit_code',
      'summary_text',
      'command',
      'model',
      'session_id',
    ];
    const keys = Object.keys(updates).filter((k) => allowed.includes(k));
    if (keys.length === 0) return;

    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => updates[k]);
    this.db.prepare(`UPDATE task_runs SET ${sets} WHERE run_id = ?`).run(...values, runId);
  }

  markOrphanedRunningRunsAsError() {
    const endedAt = nowIso();
    this.db.prepare(`
      UPDATE task_runs
      SET status = 'error', ended_at = ?, exit_code = -1, summary_text = COALESCE(summary_text, 'Orchestrator restarted while run was active.')
      WHERE status = 'running'
    `).run(endedAt);

    this.db.prepare(`
      UPDATE tasks
      SET status = 'error', ended_at = ?, last_error = COALESCE(last_error, 'Orchestrator restarted while task was running.')
      WHERE status = 'running'
    `).run(endedAt);
  }
}

export const taskStore = new TaskStore();
export default taskStore;
