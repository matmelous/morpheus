import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

import { config } from '../config/index.js';
import { taskStore } from './task-store.js';
import { logger } from '../utils/logger.js';

/** Discord API limit for message content (characters). */
const DISCORD_API_MAX_CONTENT = 2000;

const DEFAULT_MAX_MESSAGE_LENGTH = 1900;
const UNSUPPORTED_ATTACHMENTS_MESSAGE = '📎 Anexos ainda nao sao suportados nesta versao do Discord. Envie texto por enquanto.';

let client = null;
let startupPromise = null;
let inboundMessageHandler = null;
let stopRequested = false;

/**
 * Splits text into chunks of at most maxLength, preferring newline then space boundaries.
 * No chunk will exceed maxLength (Discord will truncate above 2000).
 */
export function splitMessage(text, maxLength = DEFAULT_MAX_MESSAGE_LENGTH) {
  const limit = Math.min(Math.max(1, Number(maxLength) || DEFAULT_MAX_MESSAGE_LENGTH), DISCORD_API_MAX_CONTENT);
  const s = String(text || '');
  if (!s) return [''];
  if (s.length <= limit) return [s];

  const parts = [];
  let remaining = s;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt === -1 || splitAt < limit * 0.3) splitAt = limit;

    const part = remaining.slice(0, splitAt).slice(0, limit);
    parts.push(part);
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

function isAllowedGuild(guildId) {
  const allowed = Array.isArray(config.discord.allowedGuildIds) ? config.discord.allowedGuildIds : [];
  if (allowed.length === 0) return false;
  return allowed.includes(String(guildId || '').trim());
}

function normalizeInboundMessage(message) {
  const guildId = String(message.guildId || '').trim();
  const channelId = String(message.channelId || '').trim();
  const senderId = String(message.author?.id || '').trim();

  if (!guildId || !channelId || !senderId) return null;

  return {
    transport: 'discord',
    actorId: `dc:${guildId}:${channelId}`,
    senderId,
    guildId,
    channelId,
    type: 'text',
    text: String(message.content || ''),
    messageId: String(message.id || ''),
    instanceId: config.discord.instanceId,
    attachmentsCount: Number(message.attachments?.size || 0),
  };
}

async function handleMessageCreate(message) {
  if (!inboundMessageHandler) return;
  if (!message?.id) return;
  if (message.webhookId) return;
  if (message.author?.bot) return;
  if (!message.inGuild?.() || !message.guildId) return;
  if (!isAllowedGuild(message.guildId)) return;
  if (!message.channel || message.channel.type !== ChannelType.GuildText) return;

  const payload = normalizeInboundMessage(message);
  if (!payload) return;

  const text = String(payload.text || '').trim();
  if (!text && payload.attachmentsCount > 0) {
    const channelEnabled = taskStore.isDiscordChannelEnabled(payload.channelId);
    if (!channelEnabled) {
      logger.debug(
        { channelId: payload.channelId },
        'Discord channel disabled, unsupported attachments warning suppressed'
      );
      return;
    }

    try {
      await sendDiscordMessage(payload.channelId, UNSUPPORTED_ATTACHMENTS_MESSAGE);
    } catch (err) {
      logger.warn({ error: err?.message, channelId: payload.channelId }, 'Failed to send unsupported attachments message');
    }
    return;
  }

  if (!text) return;

  try {
    await inboundMessageHandler(payload);
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Failed to process inbound Discord message');
  }
}

function createClient() {
  const nextClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  nextClient.on('ready', () => {
    logger.info({ user: nextClient.user?.tag || null }, 'Discord client connected');
  });

  nextClient.on('messageCreate', (message) => {
    void handleMessageCreate(message);
  });

  nextClient.on('error', (error) => {
    logger.error({ error: error?.message }, 'Discord client error');
  });

  return nextClient;
}

async function getClientForSend() {
  if (client) return client;
  await startDiscordClient();
  if (!client) throw new Error('Discord client is not connected');
  return client;
}

export function setInboundMessageHandler(handler) {
  inboundMessageHandler = typeof handler === 'function' ? handler : null;
}

export async function startDiscordClient() {
  if (!config.discord.enabled) return null;
  if (client) return client;
  if (startupPromise) return startupPromise;

  const token = String(config.discord.botToken || '').trim();
  if (!token) throw new Error('DISCORD_BOT_TOKEN is required when DISCORD_ENABLED=true');

  stopRequested = false;

  startupPromise = (async () => {
    const nextClient = createClient();
    await nextClient.login(token);
    if (stopRequested) {
      try { nextClient.destroy(); } catch {}
      return null;
    }
    client = nextClient;
    return client;
  })().finally(() => {
    startupPromise = null;
  });

  return startupPromise;
}

export async function stopDiscordClient() {
  stopRequested = true;
  if (!client) return;
  const current = client;
  client = null;
  try {
    current.destroy();
  } catch {}
}

export async function sendDiscordMessage(channelId, text) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');

  const activeClient = await getClientForSend();
  const channel = await activeClient.channels.fetch(id);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Discord channel is not text-based or not found: ${id}`);
  }

  const maxLength = Number(config.discord.messageMaxLength) > 0
    ? Number(config.discord.messageMaxLength)
    : DEFAULT_MAX_MESSAGE_LENGTH;

  const parts = splitMessage(String(text || ''), maxLength);
  for (const part of parts) {
    await channel.send({ content: part || ' ' });
  }

  logger.debug({ channelId: id, parts: parts.length, totalLength: String(text || '').length }, 'Message sent via Discord');
}

export default {
  sendDiscordMessage,
  setInboundMessageHandler,
  startDiscordClient,
  stopDiscordClient,
};
