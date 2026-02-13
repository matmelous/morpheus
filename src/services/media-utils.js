import { basename } from 'node:path';

export function extFromMime(mime) {
  const m = String(mime || '').toLowerCase().trim();
  if (!m) return 'bin';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';

  // Audio
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('wav')) return 'wav';

  // Video
  if (m.includes('video/mp4')) return 'mp4';
  if (m.includes('video/quicktime')) return 'mov';

  // Documents
  if (m.includes('pdf')) return 'pdf';

  return 'bin';
}

export function safeFileName(fileName, fallbackBase) {
  const raw = String(fileName || '').trim();
  const fb = String(fallbackBase || 'original').trim() || 'original';
  if (!raw) return fb;
  return basename(raw).replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120) || fb;
}

export function buildCanonicalMediaMessage({ kind, caption, transcriptText, visionText, filePath, mimetype, messageId }) {
  const parts = [];
  parts.push(`[MIDIA: ${String(kind || 'UNKNOWN').toUpperCase()}]`);
  if (messageId) parts.push(`messageId: ${messageId}`);
  if (caption) parts.push(`Legenda do usuario: ${caption}`);
  if (transcriptText) parts.push(`Transcricao:\n${transcriptText}`);
  if (visionText) parts.push(`Descricao/identificacao:\n${visionText}`);
  if (mimetype) parts.push(`mimetype: ${mimetype}`);
  if (filePath) parts.push(`Arquivo salvo em: ${filePath}`);
  parts.push('Instrucao: use o conteudo acima para responder ou executar o que foi pedido via midia.');
  return parts.join('\n\n');
}

