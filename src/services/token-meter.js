import { logger } from '../utils/logger.js';

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function charsToTokens(charCount) {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / 4);
}

function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur;
}

export function estimateTokensFromText(text) {
  return charsToTokens(String(text || '').length);
}

export function normalizeTokenUsage(raw, source = 'provider') {
  if (!raw || typeof raw !== 'object') return null;

  const input = toInt(
    raw.inputTokens
    ?? raw.input_tokens
    ?? raw.promptTokens
    ?? raw.prompt_tokens
    ?? pick(raw, ['usage', 'input_tokens'])
    ?? pick(raw, ['usage', 'prompt_tokens'])
    ?? pick(raw, ['usageMetadata', 'promptTokenCount'])
    ?? pick(raw, ['usageMetadata', 'inputTokenCount'])
  );

  const output = toInt(
    raw.outputTokens
    ?? raw.output_tokens
    ?? raw.completionTokens
    ?? raw.completion_tokens
    ?? raw.candidatesTokens
    ?? pick(raw, ['usage', 'output_tokens'])
    ?? pick(raw, ['usage', 'completion_tokens'])
    ?? pick(raw, ['usageMetadata', 'candidatesTokenCount'])
    ?? pick(raw, ['usageMetadata', 'outputTokenCount'])
  );

  const total = toInt(
    raw.totalTokens
    ?? raw.total_tokens
    ?? pick(raw, ['usage', 'total_tokens'])
    ?? pick(raw, ['usageMetadata', 'totalTokenCount'])
    ?? (input + output)
  );

  if (input <= 0 && output <= 0 && total <= 0) return null;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total > 0 ? total : input + output,
    source: source === 'estimated' ? 'estimated' : 'provider',
  };
}

export function mergeTokenUsage(left, right) {
  if (!left) return right || null;
  if (!right) return left;

  const chosen = (toInt(right.totalTokens) >= toInt(left.totalTokens)) ? right : left;
  return {
    inputTokens: toInt(chosen.inputTokens),
    outputTokens: toInt(chosen.outputTokens),
    totalTokens: toInt(chosen.totalTokens),
    source: chosen.source === 'provider' || left.source === 'provider' || right.source === 'provider'
      ? 'provider'
      : 'estimated',
  };
}

export function estimateUsage({ inputText, outputText }) {
  const inputTokens = estimateTokensFromText(inputText);
  const outputTokens = estimateTokensFromText(outputText);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  };
}

function compactMessageContent(content, maxChars) {
  const txt = String(content || '').trim();
  if (txt.length <= maxChars) return txt;
  return `${txt.slice(0, maxChars)}...`;
}

export function compactPlannerPayload({
  contextMessages,
  sharedMemory,
  plannerMaxContextMessages,
  tokenBudgetPlannerPerCall,
  tokenBudgetSharedMemoryMax,
}) {
  const maxMsgs = Math.max(2, Number(plannerMaxContextMessages || 12));
  const budget = Math.max(200, Number(tokenBudgetPlannerPerCall || 12000));
  const memMax = Math.max(200, Number(tokenBudgetSharedMemoryMax || 3000));
  const memCharCap = memMax * 4;
  const perMsgCharCap = Math.max(220, Math.floor((budget * 4) / Math.max(2, maxMsgs + 2)));

  const original = Array.isArray(contextMessages) ? contextMessages : [];
  const tail = original.slice(-maxMsgs);
  const dropped = Math.max(0, original.length - tail.length);

  let compactedMessages = tail.map((m) => ({
    role: m?.role || 'user',
    content: compactMessageContent(m?.content || '', perMsgCharCap),
  }));

  if (dropped > 0) {
    const snippets = original
      .slice(0, dropped)
      .map((m) => compactMessageContent(m?.content || '', 120))
      .filter(Boolean)
      .slice(-8);
    const summary = snippets.length
      ? `Resumo de ${dropped} mensagens anteriores: ${snippets.join(' | ')}`
      : `Resumo: ${dropped} mensagens anteriores foram compactadas.`;
    compactedMessages = [{ role: 'system', content: compactMessageContent(summary, perMsgCharCap) }, ...compactedMessages];
  }

  const memText = String(sharedMemory || '').trim();
  const compactedMemory = memText.length > memCharCap ? `${memText.slice(0, memCharCap)}...` : memText;

  return {
    contextMessages: compactedMessages,
    sharedMemory: compactedMemory,
    meta: {
      droppedMessages: dropped,
      originalMessageCount: original.length,
      finalMessageCount: compactedMessages.length,
      memoryTrimmed: compactedMemory !== memText,
      perMsgCharCap,
      memCharCap,
    },
  };
}

export function formatTokenSummaryLine(label, usage) {
  const u = usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return `${label}: in ${toInt(u.inputTokens)} | out ${toInt(u.outputTokens)} | total ${toInt(u.totalTokens)}`;
}

export function logTokenUsage(event) {
  logger.info({ event: 'token_usage', ...event }, 'Token usage');
}

export function logBudgetCompaction(event) {
  logger.info({ event: 'token_budget_compaction', ...event }, 'Token budget compaction applied');
}

export function logUsageFallbackEstimate(event) {
  logger.warn({ event: 'token_usage_missing_provider_fallback_estimate', ...event }, 'Missing provider usage; using estimate');
}
