import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { taskStore } from './task-store.js';

applyMigrations();

function cleanupDiscordChannel(channelId) {
  const db = getDb();
  db.prepare('DELETE FROM discord_channels WHERE channel_id = ?').run(channelId);
}

function cleanupPhone(phone) {
  const db = getDb();
  db.prepare('DELETE FROM chat_history WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM project_memory WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM user_shared_memory WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM task_execution_queue WHERE task_id IN (SELECT task_id FROM tasks WHERE phone = ?)').run(phone);
  db.prepare('DELETE FROM task_audit_logs WHERE task_id IN (SELECT task_id FROM tasks WHERE phone = ?)').run(phone);
  db.prepare('DELETE FROM task_run_logs WHERE task_id IN (SELECT task_id FROM tasks WHERE phone = ?)').run(phone);
  db.prepare('DELETE FROM task_runs WHERE task_id IN (SELECT task_id FROM tasks WHERE phone = ?)').run(phone);
  db.prepare('DELETE FROM task_messages WHERE task_id IN (SELECT task_id FROM tasks WHERE phone = ?)').run(phone);
  db.prepare('DELETE FROM tasks WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM users WHERE phone = ?').run(phone);
}

test('taskStore discord_channels CRUD', () => {
  const channelId = `test-channel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const guildId = `test-guild-${Math.random().toString(16).slice(2)}`;

  cleanupDiscordChannel(channelId);

  assert.equal(taskStore.getDiscordChannel(channelId), null);

  const created = taskStore.upsertDiscordChannel({
    channelId,
    guildId,
    createdBy: 'user-1',
    enabled: true,
  });

  assert.equal(created.channel_id, channelId);
  assert.equal(created.guild_id, guildId);
  assert.equal(Number(created.enabled), 1);
  assert.equal(created.created_by, 'user-1');
  assert.equal(taskStore.isDiscordChannelEnabled(channelId), true);

  const changed = taskStore.setDiscordChannelEnabled(channelId, false);
  assert.equal(changed, true);
  assert.equal(taskStore.isDiscordChannelEnabled(channelId), false);

  const updated = taskStore.upsertDiscordChannel({
    channelId,
    guildId,
    createdBy: null,
    enabled: true,
  });

  assert.equal(Number(updated.enabled), 1);
  assert.equal(taskStore.isDiscordChannelEnabled(channelId), true);

  cleanupDiscordChannel(channelId);
});

test('taskStore project memory CRUD', () => {
  const phone = `test-project-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = 'argo-api';

  cleanupPhone(phone);

  assert.equal(taskStore.getProjectMemory(projectId, phone), null);

  taskStore.setProjectMemory(projectId, phone, 'Stack principal: node 20');
  const first = taskStore.getProjectMemory(projectId, phone);
  assert.ok(first);
  assert.match(first.content, /node 20/);

  taskStore.appendProjectMemory(projectId, phone, 'Usar pnpm para scripts');
  const second = taskStore.getProjectMemory(projectId, phone);
  assert.ok(second);
  assert.match(second.content, /node 20/);
  assert.match(second.content, /Usar pnpm/);

  taskStore.clearProjectMemory(projectId, phone);
  assert.equal(taskStore.getProjectMemory(projectId, phone), null);

  cleanupPhone(phone);
});

test('taskStore chat history CRUD', () => {
  const phone = `test-chat-history-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  cleanupPhone(phone);

  const taskA = taskStore.createTask({
    phone,
    projectId: 'morpheus',
    cwd: '/tmp/morpheus',
    runnerKind: 'codex-cli',
    title: 'Chat A',
  });
  const taskB = taskStore.createTask({
    phone,
    projectId: 'argo',
    cwd: '/tmp/argo',
    runnerKind: 'codex-cli',
    title: 'Chat B',
  });

  taskStore.insertChatHistory({
    phone,
    taskId: taskA.task_id,
    projectId: taskA.project_id,
    role: 'user',
    content: 'Oi, preciso ajustar login',
  });
  taskStore.insertChatHistory({
    phone,
    taskId: taskA.task_id,
    projectId: taskA.project_id,
    role: 'assistant',
    content: 'Beleza, vou abrir uma task.',
    actionSummary: JSON.stringify({ action: 'run', runner_kind: 'codex-cli' }),
  });
  taskStore.insertChatHistory({
    phone,
    taskId: taskB.task_id,
    projectId: taskB.project_id,
    role: 'assistant',
    content: 'Projeto argo atualizado.',
  });

  const all = taskStore.listChatHistory(phone, { limit: 10 });
  assert.equal(all.length, 3);

  const byProject = taskStore.listChatHistory(phone, { limit: 10, projectId: taskA.project_id });
  assert.equal(byProject.length, 2);
  assert.ok(byProject.every((row) => row.project_id === taskA.project_id));

  const pruned = taskStore.pruneOldChatHistory(phone, 2);
  assert.equal(pruned, 1);
  assert.equal(taskStore.listChatHistory(phone, { limit: 10 }).length, 2);

  const cleared = taskStore.clearChatHistory(phone);
  assert.equal(cleared, 2);
  assert.equal(taskStore.listChatHistory(phone, { limit: 10 }).length, 0);

  cleanupPhone(phone);
});

test('taskStore run logs preserves full content and supports tail reads', () => {
  const phone = `test-run-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  cleanupPhone(phone);

  const task = taskStore.createTask({
    phone,
    projectId: 'morpheus',
    cwd: '/tmp/morpheus',
    runnerKind: 'codex-cli',
    title: 'Run logs',
  });
  const run = taskStore.createRun({
    taskId: task.task_id,
    runnerKind: 'codex-cli',
    prompt: 'execute',
    commandJson: JSON.stringify({ command: 'codex', args: ['exec', '<prompt>'] }),
    artifactsDir: '/tmp/morpheus/runs',
    status: 'running',
  });

  const longLine = 'A'.repeat(1200);
  taskStore.insertRunLog({ runId: run.run_id, taskId: task.task_id, stream: 'stdout', content: `line-1 ${longLine}` });
  taskStore.insertRunLog({ runId: run.run_id, taskId: task.task_id, stream: 'stderr', content: 'line-2 stderr full text' });
  taskStore.insertRunLog({ runId: run.run_id, taskId: task.task_id, stream: 'update', content: 'line-3 update full text' });

  const full = taskStore.listRunLogsByRun(run.run_id, { afterId: 0, limit: 10 });
  assert.equal(full.length, 3);
  assert.match(full[0].content, /A{1200}/);
  assert.equal(full[1].stream, 'stderr');
  assert.equal(full[2].stream, 'update');

  const afterFirst = taskStore.listRunLogsByRun(run.run_id, { afterId: full[0].id, limit: 10 });
  assert.equal(afterFirst.length, 2);
  assert.equal(afterFirst[0].content, 'line-2 stderr full text');

  const tail = taskStore.listRunLogsTailByRun(run.run_id, 2);
  assert.equal(tail.length, 2);
  assert.equal(tail[0].content, 'line-2 stderr full text');
  assert.equal(tail[1].content, 'line-3 update full text');

  const latestRun = taskStore.getLatestRunForTask(task.task_id);
  assert.equal(latestRun?.run_id, run.run_id);

  cleanupPhone(phone);
});

test('taskStore persists task runner model override', () => {
  const phone = `test-runner-model-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  cleanupPhone(phone);

  const task = taskStore.createTask({
    phone,
    projectId: 'morpheus',
    cwd: '/tmp/morpheus',
    runnerKind: 'claude-local',
    title: 'Runner model',
  });

  assert.equal(task.runner_model, null);

  taskStore.updateTask(task.task_id, { runner_model: 'gemma4:e4b' });
  assert.equal(taskStore.getTask(task.task_id)?.runner_model, 'gemma4:e4b');

  taskStore.updateTask(task.task_id, { runner_model: null });
  assert.equal(taskStore.getTask(task.task_id)?.runner_model, null);

  cleanupPhone(phone);
});

test('taskStore audit logs preserves full morpheus trace and tail listing', () => {
  const phone = `test-audit-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  cleanupPhone(phone);

  const task = taskStore.createTask({
    phone,
    projectId: 'morpheus',
    cwd: '/tmp/morpheus',
    runnerKind: 'codex-cli',
    title: 'Audit logs',
  });
  const run = taskStore.createRun({
    taskId: task.task_id,
    runnerKind: 'codex-cli',
    prompt: 'execute',
    commandJson: JSON.stringify({ command: 'codex', args: ['exec', '<prompt>'] }),
    artifactsDir: '/tmp/morpheus/runs',
    status: 'running',
  });

  const lineA = 'planner picked run action with strict scope and memory constraints';
  const lineB = 'executor started run and spawned command';
  const lineC = `run closed with done status and tokens ${'X'.repeat(400)}`;

  taskStore.insertTaskAuditLog({
    taskId: task.task_id,
    stage: 'planner',
    level: 'info',
    event: 'plan_selected',
    content: lineA,
    metaJson: JSON.stringify({ provider: 'openrouter', action: 'run' }),
  });
  taskStore.insertTaskAuditLog({
    taskId: task.task_id,
    runId: run.run_id,
    stage: 'executor',
    level: 'info',
    event: 'run_started',
    content: lineB,
  });
  taskStore.insertTaskAuditLog({
    taskId: task.task_id,
    runId: run.run_id,
    stage: 'executor',
    level: 'info',
    event: 'run_closed',
    content: lineC,
  });

  const all = taskStore.listTaskAuditLogsByTask(task.task_id, { afterId: 0, limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].event, 'plan_selected');
  assert.equal(all[1].run_id, run.run_id);
  assert.match(all[2].content, /X{400}/);

  const afterFirst = taskStore.listTaskAuditLogsByTask(task.task_id, { afterId: all[0].id, limit: 10 });
  assert.equal(afterFirst.length, 2);
  assert.equal(afterFirst[0].event, 'run_started');

  const tail = taskStore.listTaskAuditLogTailByTask(task.task_id, 2);
  assert.equal(tail.length, 2);
  assert.equal(tail[0].event, 'run_started');
  assert.equal(tail[1].event, 'run_closed');

  cleanupPhone(phone);
});
