import { mkdirSync } from 'node:fs';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const MAX_MESSAGE_LENGTH = 4000;
const RECONNECT_DELAY_MS = 5000;

let socket = null;
let startupPromise = null;
let reconnectTimer = null;
let stopRequested = false;
let inboundMessageHandler = null;

function splitMessage(text, maxLength = MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength * 0.3) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength * 0.3) {
      splitAt = maxLength;
    }

    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return parts;
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(reason) {
  if (stopRequested) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startWhatsAppClient();
    } catch (err) {
      logger.error({ error: err?.message }, 'WhatsApp reconnect failed');
      scheduleReconnect('retry_after_failure');
    }
  }, RECONNECT_DELAY_MS);

  logger.warn({ reason, delayMs: RECONNECT_DELAY_MS }, 'WhatsApp disconnected, scheduled reconnect');
}

function getDisconnectStatusCode(lastDisconnect) {
  const statusCode = Number(lastDisconnect?.error?.output?.statusCode || 0);
  return Number.isFinite(statusCode) ? statusCode : 0;
}

function toJid(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Phone/JID is required');
  if (raw.includes('@')) return raw;

  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new Error('Invalid phone number');
  return `${digits}@s.whatsapp.net`;
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function normalizeInboundMessage(message) {
  if (!message?.key) return null;

  const content = extractMessageContent(message.message);
  if (!content) return null;

  const contentType = getContentType(content);
  if (!contentType) return null;

  const remoteJid = message.key.remoteJid || '';
  const from = message.key.participant || remoteJid;
  const fromMe = Boolean(message.key.fromMe);
  const messageId = message.key.id || null;

  if (contentType === 'conversation') {
    return {
      event: 'message.received',
      instanceId: config.whatsappInstanceId,
      data: {
        type: 'text',
        isGroup: isGroupJid(remoteJid),
        fromMe,
        from,
        messageId,
        content: content.conversation || '',
      },
    };
  }

  if (contentType === 'extendedTextMessage') {
    return {
      event: 'message.received',
      instanceId: config.whatsappInstanceId,
      data: {
        type: 'text',
        isGroup: isGroupJid(remoteJid),
        fromMe,
        from,
        messageId,
        content: content.extendedTextMessage?.text || '',
      },
    };
  }

  if (contentType === 'imageMessage') {
    return {
      event: 'message.received',
      instanceId: config.whatsappInstanceId,
      data: {
        type: 'image',
        isGroup: isGroupJid(remoteJid),
        fromMe,
        from,
        messageId,
        content: { caption: content.imageMessage?.caption || '' },
        media: {
          type: 'image',
          message,
        },
      },
    };
  }

  if (contentType === 'audioMessage') {
    const mediaType = content.audioMessage?.ptt ? 'voice' : 'audio';
    return {
      event: 'message.received',
      instanceId: config.whatsappInstanceId,
      data: {
        type: mediaType,
        isGroup: isGroupJid(remoteJid),
        fromMe,
        from,
        messageId,
        content: '',
        media: {
          type: mediaType,
          message,
        },
      },
    };
  }

  return null;
}

function getMediaMeta(messageContent, type) {
  if (!messageContent) return { mimetype: null, fileName: null };

  if (type === 'image') {
    return {
      mimetype: messageContent.imageMessage?.mimetype || null,
      fileName: messageContent.imageMessage?.fileName || null,
    };
  }

  if (type === 'audio' || type === 'voice') {
    return {
      mimetype: messageContent.audioMessage?.mimetype || 'audio/ogg',
      fileName: null,
    };
  }

  return { mimetype: null, fileName: null };
}

async function handleInboundUpsert(upsert) {
  if (!inboundMessageHandler) return;

  const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
  for (const message of messages) {
    const payload = normalizeInboundMessage(message);
    if (!payload) continue;

    try {
      await inboundMessageHandler(payload);
    } catch (err) {
      logger.error({ error: err?.message }, 'Failed to process inbound WhatsApp payload');
    }
  }
}

async function createSocket() {
  mkdirSync(config.whatsappAuthDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(config.whatsappAuthDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    logger.warn({ error: err?.message }, 'Failed to fetch latest Baileys version, using library default');
  }

  const nextSocket = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS('Morpheus'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60_000,
  });

  nextSocket.ev.on('creds.update', saveCreds);
  nextSocket.ev.on('messages.upsert', handleInboundUpsert);
  nextSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(qr)}`;
      logger.warn(
        { qr, qrUrl },
        'WhatsApp QR received. Scan with your phone (Linked Devices) to authenticate this standalone instance.'
      );
    }

    if (connection === 'open') {
      clearReconnectTimer();
      logger.info({ me: nextSocket.user?.id || null }, 'WhatsApp socket connected');
      return;
    }

    if (connection !== 'close') return;

    if (socket === nextSocket) socket = null;

    const statusCode = getDisconnectStatusCode(lastDisconnect);
    const shouldReconnect =
      !stopRequested &&
      statusCode !== DisconnectReason.loggedOut &&
      statusCode !== DisconnectReason.badSession;

    if (!shouldReconnect) {
      logger.error(
        { statusCode },
        'WhatsApp disconnected permanently (logged out/bad session). Remove auth files and re-link device.'
      );
      return;
    }

    scheduleReconnect('connection_closed');
  });

  return nextSocket;
}

async function getSocketForSend() {
  if (socket) return socket;
  await startWhatsAppClient();
  if (!socket) throw new Error('WhatsApp socket is not connected');
  return socket;
}

export function setInboundMessageHandler(handler) {
  inboundMessageHandler = typeof handler === 'function' ? handler : null;
}

export async function startWhatsAppClient() {
  stopRequested = false;
  clearReconnectTimer();

  if (socket) return socket;
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    socket = await createSocket();
    return socket;
  })().finally(() => {
    startupPromise = null;
  });

  return startupPromise;
}

export async function stopWhatsAppClient() {
  stopRequested = true;
  clearReconnectTimer();

  if (!socket) return;

  const current = socket;
  socket = null;

  try {
    current.end?.(new Error('shutdown'));
  } catch {}

  try {
    current.ws?.close?.();
  } catch {}
}

export async function ensureWebhookRegistered(callbackUrl) {
  logger.info({ callbackUrl }, 'Standalone mode enabled: webhook registration is skipped');
  return { success: true, mode: 'standalone' };
}

export async function downloadMedia(instanceId, { type, message, asDataUrl = true } = {}) {
  if (!instanceId) throw new Error('downloadMedia: instanceId is required');
  if (!type) throw new Error('downloadMedia: type is required');
  if (!message) throw new Error('downloadMedia: message is required');

  const activeSocket = await getSocketForSend();

  const waMessage = message?.message ? message : { key: { id: 'external' }, message };
  const messageContent = extractMessageContent(waMessage.message);
  const { mimetype, fileName } = getMediaMeta(messageContent, type);

  const mediaBuffer = await downloadMediaMessage(
    waMessage,
    'buffer',
    {},
    {
      reuploadRequest: async (msg) => activeSocket.updateMediaMessage(msg),
      logger: activeSocket.logger,
    }
  );

  const base64 = Buffer.from(mediaBuffer).toString('base64');

  return {
    base64,
    dataUrl: asDataUrl && mimetype ? `data:${mimetype};base64,${base64}` : null,
    mimetype,
    fileName,
    size: mediaBuffer.length,
  };
}

export async function sendMessage(to, text) {
  const activeSocket = await getSocketForSend();
  const jid = toJid(to);
  const parts = splitMessage(String(text || ''));

  for (const part of parts) {
    await activeSocket.sendMessage(jid, { text: part });
  }

  logger.debug({ to: jid, parts: parts.length, totalLength: String(text || '').length }, 'Message sent via WhatsApp');
}

export async function sendImage(to, { base64, caption } = {}) {
  if (!base64) throw new Error('sendImage: base64 is required');

  const activeSocket = await getSocketForSend();
  const jid = toJid(to);
  const payload = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);

  await activeSocket.sendMessage(jid, {
    image: Buffer.from(payload, 'base64'),
    caption: caption || '',
  });

  logger.debug({ to: jid, hasCaption: Boolean(caption) }, 'Image sent via WhatsApp');
}

export default {
  downloadMedia,
  ensureWebhookRegistered,
  sendImage,
  sendMessage,
  setInboundMessageHandler,
  startWhatsAppClient,
  stopWhatsAppClient,
};
