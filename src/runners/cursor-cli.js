import { normalizeTokenUsage } from '../services/token-meter.js';

export function buildCursorRun({ prompt, cwd, config }) {
  const command = config.cursor.command;

  const args = ['-p'];
  args.push('--output-format', config.cursor.outputFormat || 'stream-json');
  if (config.cursor.force) args.push('-f');
  if (config.cursor.model) args.push('--model', config.cursor.model);
  args.push('--workspace', cwd);
  args.push(prompt);

  const redactedArgs = args.map((a) => (a === prompt ? '<prompt>' : a));
  const commandJson = JSON.stringify({ command, args: redactedArgs });

  return { command, args, commandJson };
}

function extractTextFromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function summarizeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  if (toolCall.readToolCall?.args?.path) {
    const p = String(toolCall.readToolCall.args.path);
    return `Read: ${p.split('/').pop()}`;
  }
  if (toolCall.editToolCall?.args?.path) {
    const p = String(toolCall.editToolCall.args.path);
    return `Edit: ${p.split('/').pop()}`;
  }
  if (toolCall.bashToolCall?.args?.command) {
    const c = String(toolCall.bashToolCall.args.command);
    return `Bash: ${c.slice(0, 120)}`;
  }
  // Unknown tool call shape.
  const key = Object.keys(toolCall)[0];
  return key ? `tool:${key}` : null;
}

export function cursorParseLine({ obj, rawLine }) {
  if (rawLine && rawLine.includes("You've hit your usage limit")) {
    return { blockedReason: 'quota', updateText: 'blocked:quota' };
  }

  if (!obj || typeof obj !== 'object') return null;
  const usage = normalizeTokenUsage(obj, 'provider');

  if (obj.type === 'system' && obj.subtype === 'init') {
    return {
      model: obj.model,
      sessionId: obj.session_id,
      updateText: 'init',
      usage,
    };
  }

  if (obj.type === 'tool_call' && obj.tool_call) {
    const summary = summarizeToolCall(obj.tool_call);
    if (!summary) return null;
    return { updateText: summary, usage };
  }

  if (obj.type === 'assistant') {
    const text = extractTextFromContentBlocks(obj.message?.content).trim();
    if (!text) return null;
    return {
      updateText: `assistant: ${text.slice(0, 160)}`,
      assistantDelta: text + '\n',
      usage,
    };
  }

  if (obj.type === 'result') {
    const subtype = obj.subtype || '';
    const resultText = typeof obj.result === 'string' ? obj.result.trim() : '';
    return {
      updateText: `result:${subtype || 'done'}`,
      finalResult: resultText || null,
      usage,
    };
  }

  return usage ? { usage } : null;
}
