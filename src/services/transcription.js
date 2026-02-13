import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + '...';
}

export async function transcribeAudioFile({ filePath, mimetype, fileName }) {
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const model = config.openai.transcribeModel || 'whisper-1';
  const buf = readFileSync(filePath);

  // Node 18+ has global FormData/Blob.
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([buf], { type: mimetype || 'application/octet-stream' }), fileName || 'audio');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000).unref?.();
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    }
    const text = String(json?.text || '').trim();
    return { text: truncate(text, 12000), raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

export default { transcribeAudioFile };

