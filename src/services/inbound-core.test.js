import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../config/index.js';
import { applyMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { __resetMessengerAdaptersForTest, __setMessengerAdaptersForTest } from './messenger.js';
import { processInboundMessage } from './inbound-core.js';
import { projectManager } from './project-manager.js';
import { taskStore } from './task-store.js';

applyMigrations();
projectManager.loadProjects();

function cleanActor(actorId, channelId = null) {
  const db = getDb();
  db.prepare('DELETE FROM inbound_message_dedup WHERE phone = ?').run(actorId);
  db.prepare('DELETE FROM pending_confirmations WHERE phone = ?').run(actorId);
  db.prepare('DELETE FROM pending_task_selections WHERE phone = ?').run(actorId);
  db.prepare('DELETE FROM user_shared_memory WHERE phone = ?').run(actorId);
  db.prepare('DELETE FROM users WHERE phone = ?').run(actorId);
  if (channelId) db.prepare('DELETE FROM discord_channels WHERE channel_id = ?').run(channelId);
}

function makeDiscordPayload({ actorId, senderId, guildId, channelId, text, messageId }) {
  return {
    transport: 'discord',
    actorId,
    senderId,
    guildId,
    channelId,
    type: 'text',
    text,
    messageId,
    instanceId: 'test-discord',
    attachmentsCount: 0,
  };
}

test('discord fixed task flow and channel admin commands', async () => {
  const guildId = `g-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const channelId = `c-${Math.random().toString(16).slice(2, 9)}`;
  const actorId = `dc:${guildId}:${channelId}`;
  const adminId = `admin-${Math.random().toString(16).slice(2, 9)}`;
  const memberId = `member-${Math.random().toString(16).slice(2, 9)}`;

  const prevGuilds = [...config.discord.allowedGuildIds];
  const prevAdmins = [...config.discord.adminUserIds];

  config.discord.allowedGuildIds = [guildId];
  config.discord.adminUserIds = [adminId];

  __setMessengerAdaptersForTest({
    sendDiscordMessage: async () => {},
    sendWhatsAppMessage: async () => {},
    sendWhatsAppImage: async () => {},
  });

  cleanActor(actorId, channelId);

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: memberId,
    guildId,
    channelId,
    text: 'oi',
    messageId: `m-${Date.now()}-0`,
  }));
  assert.equal(taskStore.listTasksByPhone(actorId, { limit: 10 }).length, 0);

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: adminId,
    guildId,
    channelId,
    text: '/channel-enable',
    messageId: `m-${Date.now()}-1`,
  }));

  assert.equal(taskStore.isDiscordChannelEnabled(channelId), true);

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: memberId,
    guildId,
    channelId,
    text: 'oi',
    messageId: `m-${Date.now()}-2`,
  }));

  const firstUser = taskStore.getUser(actorId);
  assert.ok(firstUser?.focused_task_id);
  const firstTaskId = firstUser.focused_task_id;

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: memberId,
    guildId,
    channelId,
    text: 'oi',
    messageId: `m-${Date.now()}-3`,
  }));

  const secondUser = taskStore.getUser(actorId);
  assert.equal(secondUser?.focused_task_id, firstTaskId);

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: memberId,
    guildId,
    channelId,
    text: '/new',
    messageId: `m-${Date.now()}-4`,
  }));

  const thirdUser = taskStore.getUser(actorId);
  assert.ok(thirdUser?.focused_task_id);
  assert.notEqual(thirdUser.focused_task_id, firstTaskId);

  await processInboundMessage(makeDiscordPayload({
    actorId,
    senderId: adminId,
    guildId,
    channelId,
    text: '/channel-disable',
    messageId: `m-${Date.now()}-5`,
  }));

  assert.equal(taskStore.isDiscordChannelEnabled(channelId), false);

  cleanActor(actorId, channelId);
  config.discord.allowedGuildIds = prevGuilds;
  config.discord.adminUserIds = prevAdmins;
  __resetMessengerAdaptersForTest();
});
