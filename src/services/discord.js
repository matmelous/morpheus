import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
} from 'discord.js';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { projectManager } from './project-manager.js';
import { extFromMime, safeFileName } from './media-utils.js';
import { listSupportedRunnerKinds } from '../runners/index.js';
import { taskStore } from './task-store.js';
import { listSuggestedRunnerModels } from './runner-models.js';
import {
  buildDiscordCommandRegistrationRequests,
  getDiscordAutocompleteChoices,
  slashInteractionToLegacyText,
} from './discord-commands.js';

/** Discord API limit for message content (characters). */
const DISCORD_API_MAX_CONTENT = 2000;

const DEFAULT_MAX_MESSAGE_LENGTH = 1900;
const DEFAULT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

let client = null;
let startupPromise = null;
let inboundMessageHandler = null;
let stopRequested = false;

function normalizeMimeType(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.toLowerCase();
}

function inferAttachmentKindFromMime(mimetype) {
  const m = normalizeMimeType(mimetype);
  if (!m) return 'file';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

function getDiscordMediaMaxBytes() {
  const value = Number(config.discord.mediaMaxBytes);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MEDIA_MAX_BYTES;
  return Math.floor(value);
}

function buildDefaultAttachmentName(kind, mimetype) {
  const ext = extFromMime(mimetype);
  const suffix = ext && ext !== 'bin' ? ext : (kind === 'image' ? 'png' : kind === 'audio' ? 'ogg' : 'bin');
  const ts = Date.now();
  if (kind === 'image') return `image-${ts}.${suffix}`;
  if (kind === 'audio') return `audio-${ts}.${suffix}`;
  return `file-${ts}.${suffix}`;
}

function normalizeInboundAttachments(message) {
  const out = [];
  const items = message?.attachments;
  if (!items || typeof items.values !== 'function') return out;

  for (const item of items.values()) {
    const url = String(item?.url || item?.proxyURL || '').trim();
    if (!url) continue;

    const mimetype = normalizeMimeType(item?.contentType || null);
    const kind = inferAttachmentKindFromMime(mimetype);
    const fallback = buildDefaultAttachmentName(kind, mimetype);
    const fileName = safeFileName(item?.name || item?.filename || '', fallback);
    const size = Number(item?.size);

    out.push({
      id: String(item?.id || ''),
      url,
      fileName,
      mimetype,
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null,
      kind,
    });
  }

  return out;
}

async function getTextChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');

  const activeClient = await getClientForSend();
  const channel = await activeClient.channels.fetch(id);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Discord channel is not text-based or not found: ${id}`);
  }

  return { id, channel };
}

function decodeBase64Payload(base64) {
  const raw = String(base64 || '').trim();
  if (!raw) throw new Error('base64 is required');
  return raw.includes(',') ? raw.split(',').pop() : raw;
}

async function sendDiscordAttachment(channelId, { base64, caption, fileName, mimetype } = {}) {
  const { id, channel } = await getTextChannel(channelId);

  const resolvedName = String(fileName || '').trim();
  if (!resolvedName) throw new Error('fileName is required');

  const payload = decodeBase64Payload(base64);
  const buffer = Buffer.from(payload, 'base64');
  const maxBytes = getDiscordMediaMaxBytes();
  if (buffer.length > maxBytes) {
    throw new Error(`Discord media exceeds max size (${buffer.length} > ${maxBytes})`);
  }

  const maxLength = Number(config.discord.messageMaxLength) > 0
    ? Number(config.discord.messageMaxLength)
    : DEFAULT_MAX_MESSAGE_LENGTH;
  const captionText = String(caption || '');
  const captionParts = captionText ? splitMessage(captionText, maxLength) : [];

  await channel.send({
    content: captionParts[0] ? captionParts[0] : undefined,
    files: [{
      attachment: buffer,
      name: resolvedName,
      description: mimetype ? String(mimetype).slice(0, 120) : undefined,
    }],
  });

  for (const part of captionParts.slice(1)) {
    await channel.send({ content: part || ' ' });
  }

  logger.debug(
    { channelId: id, fileName: resolvedName, bytes: buffer.length, captionParts: captionParts.length },
    'Attachment sent via Discord'
  );
}

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

  const attachments = normalizeInboundAttachments(message);

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
    attachmentsCount: attachments.length,
    attachments,
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
  const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
  if (!text && !hasAttachments) return;

  try {
    await inboundMessageHandler(payload);
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Failed to process inbound Discord message');
  }
}

async function syncDiscordSlashCommands(activeClient) {
  const token = String(config.discord.botToken || '').trim();
  const guildIds = Array.isArray(config.discord.allowedGuildIds)
    ? config.discord.allowedGuildIds.map((guildId) => String(guildId || '').trim()).filter(Boolean)
    : [];

  if (!token || guildIds.length === 0) return;

  const app = await activeClient.application?.fetch();
  const applicationId = String(app?.id || activeClient.application?.id || '').trim();
  if (!applicationId) {
    throw new Error('Discord application id is unavailable for command registration');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const requests = buildDiscordCommandRegistrationRequests({ applicationId, guildIds });

  for (const request of requests) {
    try {
      await rest.put(request.route, { body: request.body });
      logger.info({ guildId: request.guildId, commandCount: request.body.length }, 'Discord slash commands synced');
    } catch (err) {
      logger.warn(
        { guildId: request.guildId, error: err?.message, code: err?.code || null },
        'Failed to sync Discord slash commands for guild'
      );
    }
  }
}

function normalizeInteractionPayload(interaction, text) {
  const guildId = String(interaction?.guildId || '').trim();
  const channelId = String(interaction?.channelId || '').trim();
  const senderId = String(interaction?.user?.id || '').trim();
  if (!guildId || !channelId || !senderId) return null;

  return {
    transport: 'discord',
    actorId: `dc:${guildId}:${channelId}`,
    senderId,
    guildId,
    channelId,
    type: 'text',
    text,
    messageId: String(interaction.id || ''),
    instanceId: `${config.discord.instanceId}:slash`,
    attachmentsCount: 0,
    attachments: [],
  };
}

async function handleAutocompleteInteraction(interaction) {
  const actorId = interaction?.guildId && interaction?.channelId
    ? `dc:${interaction.guildId}:${interaction.channelId}`
    : null;
  const user = actorId ? taskStore.getUser(actorId) : null;
  const focusedTask = user?.focused_task_id ? taskStore.getTask(user.focused_task_id) : null;
  const effectiveRunnerKind = focusedTask?.runner_kind || user?.runner_override || 'claude-local';
  const effectiveTaskModel = focusedTask?.runner_model || '';
  const modelValues = [
    ...listSuggestedRunnerModels(effectiveRunnerKind, { taskModel: effectiveTaskModel }),
    'clear',
  ];

  const choices = getDiscordAutocompleteChoices(interaction, {
    projects: projectManager.listProjects(),
    runnerKinds: listSupportedRunnerKinds({ includeAuto: true }),
    modelValues,
  });

  await interaction.respond(choices);
}

async function handleChatInputInteraction(interaction) {
  if (!inboundMessageHandler) {
    await interaction.reply({ content: 'Morpheus ainda nao esta pronto para processar comandos.', ephemeral: true });
    return;
  }
  if (!interaction.inGuild() || !interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando so funciona em canais de servidor.', ephemeral: true });
    return;
  }
  if (!isAllowedGuild(interaction.guildId)) {
    await interaction.reply({ content: 'Este servidor nao esta liberado no Morpheus.', ephemeral: true });
    return;
  }

  const text = slashInteractionToLegacyText(interaction);
  if (!text) {
    await interaction.reply({ content: 'Comando Discord ainda nao suportado pelo Morpheus.', ephemeral: true });
    return;
  }

  const payload = normalizeInteractionPayload(interaction, text);
  if (!payload) {
    await interaction.reply({ content: 'Nao foi possivel identificar o contexto do canal.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await inboundMessageHandler(payload);
    await interaction.editReply('Comando recebido. A resposta foi enviada no canal.');
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack, commandName: interaction.commandName }, 'Failed to process Discord slash command');
    await interaction.editReply(`Falha ao processar comando: ${String(err?.message || 'erro desconhecido').slice(0, 180)}`);
  }
}

async function handleInteractionCreate(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocompleteInteraction(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatInputInteraction(interaction);
    }
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Discord interaction handler failed');

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Falha ao processar interacao: ${String(err?.message || 'erro desconhecido').slice(0, 180)}`);
      } else {
        await interaction.reply({ content: `Falha ao processar interacao: ${String(err?.message || 'erro desconhecido').slice(0, 180)}`, ephemeral: true });
      }
    }
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

  nextClient.on('clientReady', () => {
    logger.info({ user: nextClient.user?.tag || null }, 'Discord client connected');
  });

  nextClient.on('messageCreate', (message) => {
    void handleMessageCreate(message);
  });

  nextClient.on('interactionCreate', (interaction) => {
    void handleInteractionCreate(interaction);
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
    try {
      await syncDiscordSlashCommands(nextClient);
    } catch (err) {
      logger.error({ error: err?.message, stack: err?.stack }, 'Failed to sync Discord slash commands');
    }
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
  const { id, channel } = await getTextChannel(channelId);

  const maxLength = Number(config.discord.messageMaxLength) > 0
    ? Number(config.discord.messageMaxLength)
    : DEFAULT_MAX_MESSAGE_LENGTH;

  const parts = splitMessage(String(text || ''), maxLength);
  const messageIds = [];
  for (const part of parts) {
    const message = await channel.send({ content: part || ' ' });
    messageIds.push(String(message?.id || ''));
  }

  logger.debug({ channelId: id, parts: parts.length, totalLength: String(text || '').length }, 'Message sent via Discord');
  return {
    primaryMessageId: messageIds.find(Boolean) || null,
    messageIds: messageIds.filter(Boolean),
    edited: false,
  };
}

export async function upsertDiscordMessage(channelId, text, { messageId = null } = {}) {
  const { id, channel } = await getTextChannel(channelId);

  const maxLength = Number(config.discord.messageMaxLength) > 0
    ? Number(config.discord.messageMaxLength)
    : DEFAULT_MAX_MESSAGE_LENGTH;

  const parts = splitMessage(String(text || ''), maxLength);

  if (messageId && parts.length === 1) {
    try {
      const existing = await channel.messages.fetch(String(messageId));
      if (existing) {
        await existing.edit({ content: parts[0] || ' ' });
        logger.debug({ channelId: id, messageId, totalLength: String(text || '').length }, 'Message updated via Discord');
        return {
          primaryMessageId: String(existing.id || messageId),
          messageIds: [String(existing.id || messageId)],
          edited: true,
        };
      }
    } catch {}
  }

  return sendDiscordMessage(channelId, text);
}

export async function sendDiscordImage(channelId, { base64, caption, fileName, mimetype } = {}) {
  const normalizedMime = normalizeMimeType(mimetype) || 'image/png';
  const resolvedName = safeFileName(fileName, buildDefaultAttachmentName('image', normalizedMime));
  await sendDiscordAttachment(channelId, { base64, caption, fileName: resolvedName, mimetype: normalizedMime });
}

export async function sendDiscordAudio(channelId, { base64, caption, fileName, mimetype } = {}) {
  const normalizedMime = normalizeMimeType(mimetype) || 'audio/ogg';
  const resolvedName = safeFileName(fileName, buildDefaultAttachmentName('audio', normalizedMime));
  await sendDiscordAttachment(channelId, { base64, caption, fileName: resolvedName, mimetype: normalizedMime });
}

export async function sendDiscordFile(channelId, { base64, caption, fileName, mimetype } = {}) {
  const normalizedMime = normalizeMimeType(mimetype);
  const rawName = String(fileName || '').trim();
  if (!rawName) throw new Error('fileName is required for Discord file upload');
  const resolvedName = safeFileName(rawName, buildDefaultAttachmentName('file', normalizedMime));
  await sendDiscordAttachment(channelId, { base64, caption, fileName: resolvedName, mimetype: normalizedMime });
}

export async function downloadDiscordAttachment({ url, fileName, mimetype, size } = {}) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) throw new Error('url is required');

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid Discord attachment URL');
  }
  if (!parsed.protocol.startsWith('http')) throw new Error('Unsupported attachment URL protocol');

  const token = String(config.discord.botToken || '').trim();
  const headers = token ? { Authorization: `Bot ${token}` } : undefined;
  const res = await fetch(parsed.toString(), { headers });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Discord attachment download failed (${res.status}): ${String(errText || '').slice(0, 240)}`);
  }

  const contentType = normalizeMimeType(res.headers.get('content-type') || null);
  const buf = Buffer.from(await res.arrayBuffer());
  const maxBytes = getDiscordMediaMaxBytes();
  if (buf.length > maxBytes) {
    throw new Error(`Discord attachment exceeds max size (${buf.length} > ${maxBytes})`);
  }

  const resolvedMime = normalizeMimeType(mimetype) || contentType;
  const inferredKind = inferAttachmentKindFromMime(resolvedMime);
  const resolvedName = safeFileName(fileName, buildDefaultAttachmentName(inferredKind, resolvedMime));
  const reportedSize = Number(size);
  const finalSize = Number.isFinite(reportedSize) && reportedSize >= 0 ? Math.floor(reportedSize) : buf.length;
  const base64 = buf.toString('base64');

  return {
    base64,
    dataUrl: resolvedMime ? `data:${resolvedMime};base64,${base64}` : null,
    mimetype: resolvedMime,
    fileName: resolvedName,
    size: finalSize,
  };
}

export default {
  sendDiscordMessage,
  upsertDiscordMessage,
  sendDiscordImage,
  sendDiscordAudio,
  sendDiscordFile,
  downloadDiscordAttachment,
  setInboundMessageHandler,
  startDiscordClient,
  stopDiscordClient,
};
