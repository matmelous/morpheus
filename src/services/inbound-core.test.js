import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../config/index.js';
import { applyMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { __resetMessengerAdaptersForTest, __setMessengerAdaptersForTest } from './messenger.js';
import { normalizeWhatsAppPayload, processInboundMessage } from './inbound-core.js';
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

function makeDiscordPayload({ actorId, senderId, guildId, channelId, text, messageId, attachments = [] }) {
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
    attachmentsCount: attachments.length,
    attachments,
  };
}

function makeAttachment(overrides = {}) {
  return {
    id: `att-${Math.random().toString(16).slice(2, 9)}`,
    url: 'https://cdn.discordapp.com/attachments/test.pdf',
    fileName: 'sample.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    kind: 'file',
    ...overrides,
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

test('discord command with attachments ignores attachments', async () => {
  const guildId = `g-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const channelId = `c-${Math.random().toString(16).slice(2, 9)}`;
  const actorId = `dc:${guildId}:${channelId}`;
  const adminId = `admin-${Math.random().toString(16).slice(2, 9)}`;

  const prevGuilds = [...config.discord.allowedGuildIds];
  const prevAdmins = [...config.discord.adminUserIds];
  const prevFetch = global.fetch;

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 500, text: async () => 'unexpected', headers: new Headers() };
  };

  config.discord.allowedGuildIds = [guildId];
  config.discord.adminUserIds = [adminId];

  __setMessengerAdaptersForTest({
    sendDiscordMessage: async () => {},
    sendWhatsAppMessage: async () => {},
    sendWhatsAppImage: async () => {},
  });

  cleanActor(actorId, channelId);

  try {
    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: adminId,
      guildId,
      channelId,
      text: '/channel-enable',
      messageId: `m-${Date.now()}-cmd-att`,
      attachments: [makeAttachment()],
    }));

    assert.equal(taskStore.isDiscordChannelEnabled(channelId), true);
    assert.equal(fetchCalls, 0);
  } finally {
    cleanActor(actorId, channelId);
    config.discord.allowedGuildIds = prevGuilds;
    config.discord.adminUserIds = prevAdmins;
    global.fetch = prevFetch;
    __resetMessengerAdaptersForTest();
  }
});

test('discord text with attachment processes text + attachment and deduplicates by messageId', async () => {
  const guildId = `g-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const channelId = `c-${Math.random().toString(16).slice(2, 9)}`;
  const actorId = `dc:${guildId}:${channelId}`;
  const adminId = `admin-${Math.random().toString(16).slice(2, 9)}`;
  const memberId = `member-${Math.random().toString(16).slice(2, 9)}`;
  const fixedMessageId = `m-${Date.now()}-with-att`;

  const prevGuilds = [...config.discord.allowedGuildIds];
  const prevAdmins = [...config.discord.adminUserIds];
  const prevFetch = global.fetch;

  const outgoing = [];
  let fetchCalls = 0;

  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 413,
      text: async () => 'too large',
      headers: new Headers(),
    };
  };

  config.discord.allowedGuildIds = [guildId];
  config.discord.adminUserIds = [adminId];

  __setMessengerAdaptersForTest({
    sendDiscordMessage: async (_channelId, text) => {
      outgoing.push(String(text || ''));
    },
    sendWhatsAppMessage: async () => {},
    sendWhatsAppImage: async () => {},
  });

  cleanActor(actorId, channelId);

  try {
    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: adminId,
      guildId,
      channelId,
      text: '/channel-enable',
      messageId: `m-${Date.now()}-enable`,
    }));

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: 'oi',
      messageId: fixedMessageId,
      attachments: [makeAttachment()],
    }));

    const firstOutgoingCount = outgoing.length;
    assert.ok(firstOutgoingCount > 0);
    assert.equal(fetchCalls, 1);
    assert.ok(outgoing.some((text) => /Me diga o que voce quer fazer/i.test(text)));
    assert.ok(outgoing.some((text) => /Falha ao processar anexo/i.test(text)));

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: 'oi',
      messageId: fixedMessageId,
      attachments: [makeAttachment()],
    }));

    assert.equal(fetchCalls, 1);
    assert.equal(outgoing.length, firstOutgoingCount);
  } finally {
    cleanActor(actorId, channelId);
    config.discord.allowedGuildIds = prevGuilds;
    config.discord.adminUserIds = prevAdmins;
    global.fetch = prevFetch;
    __resetMessengerAdaptersForTest();
  }
});

test('project memory commands and chat history wiring', async () => {
  const guildId = `g-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const channelId = `c-${Math.random().toString(16).slice(2, 9)}`;
  const actorId = `dc:${guildId}:${channelId}`;
  const adminId = `admin-${Math.random().toString(16).slice(2, 9)}`;
  const memberId = `member-${Math.random().toString(16).slice(2, 9)}`;

  const prevGuilds = [...config.discord.allowedGuildIds];
  const prevAdmins = [...config.discord.adminUserIds];
  const outgoing = [];

  config.discord.allowedGuildIds = [guildId];
  config.discord.adminUserIds = [adminId];

  __setMessengerAdaptersForTest({
    sendDiscordMessage: async (_channelId, text) => {
      outgoing.push(String(text || ''));
    },
    sendWhatsAppMessage: async () => {},
    sendWhatsAppImage: async () => {},
  });

  cleanActor(actorId, channelId);

  try {
    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: adminId,
      guildId,
      channelId,
      text: '/channel-enable',
      messageId: `m-${Date.now()}-pm-enable`,
    }));

    const focused = taskStore.getUser(actorId)?.focused_task_id;
    const focusedTask = focused ? taskStore.getTask(focused) : null;
    assert.ok(focusedTask);

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: '/remember-project usa pnpm para scripts',
      messageId: `m-${Date.now()}-pm-remember`,
    }));

    const projectMemory = taskStore.getProjectMemory(focusedTask.project_id, actorId);
    assert.ok(projectMemory);
    assert.match(String(projectMemory.content || ''), /pnpm/);

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: '/project-memory',
      messageId: `m-${Date.now()}-pm-show`,
    }));
    assert.ok(outgoing.some((text) => /Memoria do projeto/i.test(text)));

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: '/forget-project-memory',
      messageId: `m-${Date.now()}-pm-clear`,
    }));
    assert.equal(taskStore.getProjectMemory(focusedTask.project_id, actorId), null);

    await processInboundMessage(makeDiscordPayload({
      actorId,
      senderId: memberId,
      guildId,
      channelId,
      text: 'oi',
      messageId: `m-${Date.now()}-pm-chat`,
    }));

    const history = taskStore.listChatHistory(actorId, { limit: 20 });
    assert.ok(history.some((row) => row.role === 'user' && /oi/i.test(String(row.content || ''))));
    assert.ok(history.some((row) => row.role === 'assistant'));
  } finally {
    cleanActor(actorId, channelId);
    config.discord.allowedGuildIds = prevGuilds;
    config.discord.adminUserIds = prevAdmins;
    __resetMessengerAdaptersForTest();
  }
});

test('normalizeWhatsAppPayload accepts file/document messages', () => {
  const payload = normalizeWhatsAppPayload({
    event: 'message.received',
    instanceId: 'wa-instance-test',
    data: {
      type: 'file',
      isGroup: false,
      fromMe: false,
      from: '5511999999999@s.whatsapp.net',
      messageId: 'wa-doc-1',
      content: { caption: 'pdf do cliente' },
      media: { type: 'file', message: { message: { documentMessage: {} } } },
    },
  });

  assert.ok(payload);
  assert.equal(payload.transport, 'whatsapp');
  assert.equal(payload.actorId, '5511999999999');
  assert.equal(payload.type, 'file');
  assert.equal(payload.text, '');
  assert.equal(payload.messageId, 'wa-doc-1');
});
