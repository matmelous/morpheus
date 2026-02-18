import { sendImage as sendWhatsAppImage, sendMessage as sendWhatsAppMessage } from './whatsapp.js';
import { sendDiscordMessage } from './discord.js';

const DISCORD_PREFIX = 'dc:';

let adapters = {
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendDiscordMessage,
};

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

export async function sendImage(actorId, { base64, caption } = {}) {
  if (isDiscordActorId(actorId)) {
    const fallback = [
      '📎 Evidencia de imagem capturada,',
      'mas envio de imagem no Discord ainda nao esta habilitado nesta versao.',
      'Se precisar, use o canal WhatsApp para receber os prints.',
    ].join(' ');
    return sendMessage(actorId, caption ? `${fallback}\n\nLegenda: ${caption}` : fallback);
  }
  return adapters.sendWhatsAppImage(actorId, { base64, caption });
}

export function __setMessengerAdaptersForTest(next) {
  adapters = { ...adapters, ...(next || {}) };
}

export function __resetMessengerAdaptersForTest() {
  adapters = {
    sendWhatsAppMessage,
    sendWhatsAppImage,
    sendDiscordMessage,
  };
}

export default {
  isDiscordActorId,
  parseDiscordActorId,
  sendMessage,
  sendImage,
};
