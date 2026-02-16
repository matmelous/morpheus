import { logger } from '../utils/logger.js';
import { normalizeTokenUsage } from '../services/token-meter.js';

export async function planWithOpenRouter({ systemPrompt, userPrompt, timeoutMs, config }) {
  const apiKey = config.openrouter.apiKey;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 120000);
  timeout.unref();

  try {
    const url = `${config.openrouter.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: config.openrouter.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
      throw new Error(`OpenRouter error: ${msg}`);
    }

    const assistantText = json?.choices?.[0]?.message?.content;
    if (typeof assistantText !== 'string' || !assistantText.trim()) {
      throw new Error('OpenRouter returned empty content');
    }

    return {
      provider: 'openrouter',
      model: json?.model || config.openrouter.model,
      assistantText: assistantText.trim(),
      usage: normalizeTokenUsage(json, 'provider'),
      raw: json,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      logger.warn({ timeoutMs }, 'OpenRouter planner timeout');
      throw new Error('OpenRouter request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
