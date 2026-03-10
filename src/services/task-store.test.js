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
