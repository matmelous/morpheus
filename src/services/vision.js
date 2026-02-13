import { config } from '../config/index.js';

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + '...';
}

export async function describeImage({ dataUrl, promptText }) {
  const apiKey = config.openrouter.apiKey;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  if (!dataUrl) throw new Error('describeImage: dataUrl is required');

  const url = `${config.openrouter.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const model = config.openrouter.model;

  const system = [
    'Voce recebe uma imagem enviada por WhatsApp.',
    'Descreva o conteudo de forma objetiva, extraindo dados relevantes e texto visivel quando possivel.',
    'Se for um print de erro, identifique o erro e sugira proximos passos.',
    'Responda em PT-BR em no maximo 12 linhas.',
  ].join(' ');

  const user = promptText || 'Descreva a imagem e extraia informacoes importantes.';

  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000).unref?.();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    }
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    return { text: truncate(text, 12000), model: String(json?.model || model), raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

export default { describeImage };
