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
