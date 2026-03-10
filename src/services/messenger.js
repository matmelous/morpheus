import { sendImage as sendWhatsAppImage, sendMessage as sendWhatsAppMessage } from './whatsapp.js';
import {
  sendDiscordAudio,
  sendDiscordFile,
  sendDiscordImage,
  sendDiscordMessage,
} from './discord.js';

const DISCORD_PREFIX = 'dc:';

let adapters = {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendDiscordMessage,
  sendDiscordImage,
  sendDiscordAudio,
  sendDiscordFile,
};

function shortError(err) {
  const msg = String(err?.message || '').trim();
  if (!msg) return 'erro desconhecido';
  return msg.slice(0, 220);
}

function fallbackMediaText(kind, err, { caption, fileName } = {}) {
  const parts = [
    `⚠️ Falha ao enviar ${kind} no Discord: ${shortError(err)}.`,
    'Segue somente a mensagem em texto para nao travar o fluxo.',
  ];
  if (caption) parts.push(`Legenda: ${String(caption).slice(0, 400)}`);
  if (fileName) parts.push(`Arquivo: ${String(fileName).slice(0, 120)}`);
  return parts.join('\n');
}

async function sendDiscordMediaWithFallback(actorId, kind, payload, sendFn) {
  const parsed = parseDiscordActorId(actorId);
  if (!parsed) throw new Error(`Invalid Discord actorId: ${actorId}`);

  try {
    await sendFn(parsed.channelId);
  } catch (err) {
    const fallback = fallbackMediaText(kind, err, payload);
    await adapters.sendDiscordMessage(parsed.channelId, fallback);
  }
}

export function isDiscordActorId(actorId) {
  return String(actorId || '').startsWith(DISCORD_PREFIX);
}

export function parseDiscordActorId(actorId) {
  const raw = String(actorId || '');
  if (!raw.startsWith(DISCORD_PREFIX)) return null;

  const rest = raw.slice(DISCORD_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) return null;

  const guildId = rest.slice(0, firstSep).trim();
  const channelId = rest.slice(firstSep + 1).trim();
  if (!guildId || !channelId) return null;

  return { guildId, channelId };
}

export async function sendMessage(actorId, text) {
  if (isDiscordActorId(actorId)) {
    const parsed = parseDiscordActorId(actorId);
    if (!parsed) throw new Error(`Invalid Discord actorId: ${actorId}`);
    return adapters.sendDiscordMessage(parsed.channelId, text);
  }
  return adapters.sendWhatsAppMessage(actorId, text);
}

export async function sendImage(actorId, { base64, caption, fileName, mimetype } = {}) {
  if (isDiscordActorId(actorId)) {
    return sendDiscordMediaWithFallback(actorId, 'imagem', { caption, fileName }, async (channelId) => {
      await adapters.sendDiscordImage(channelId, { base64, caption, fileName, mimetype });
    });
  }
  return adapters.sendWhatsAppImage(actorId, { base64, caption });
}

export async function sendAudio(actorId, { base64, caption, fileName, mimetype } = {}) {
  if (isDiscordActorId(actorId)) {
    return sendDiscordMediaWithFallback(actorId, 'audio', { caption, fileName }, async (channelId) => {
      await adapters.sendDiscordAudio(channelId, { base64, caption, fileName, mimetype });
    });
  }

  return adapters.sendWhatsAppMessage(
    actorId,
    '📎 Envio de audio no WhatsApp ainda nao esta habilitado nesta versao do Morpheus.'
  );
}

export async function sendFile(actorId, { base64, caption, fileName, mimetype } = {}) {
  if (isDiscordActorId(actorId)) {
    return sendDiscordMediaWithFallback(actorId, 'arquivo', { caption, fileName }, async (channelId) => {
      await adapters.sendDiscordFile(channelId, { base64, caption, fileName, mimetype });
    });
  }

  return adapters.sendWhatsAppMessage(
    actorId,
    '📎 Envio de arquivo no WhatsApp ainda nao esta habilitado nesta versao do Morpheus.'
  );
}

export function __setMessengerAdaptersForTest(next) {
  adapters = { ...adapters, ...(next || {}) };
}

export function __resetMessengerAdaptersForTest() {
  adapters = {
    sendWhatsAppMessage,
    sendWhatsAppImage,
    sendDiscordMessage,
    sendDiscordImage,
    sendDiscordAudio,
    sendDiscordFile,
  };
}

export default {
  isDiscordActorId,
  parseDiscordActorId,
  sendMessage,
  sendImage,
  sendAudio,
  sendFile,
};
