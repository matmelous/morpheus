import { normalizeTokenUsage } from '../services/token-meter.js';

export function buildClaudeRun({ prompt, config }) {
  const command = config.claude.command;

  const args = ['-p'];

  const outputFormat = config.claude.outputFormat || 'stream-json';
  const needVerbose = outputFormat === 'stream-json';
  if (config.claude.verbose || needVerbose) args.push('--verbose');
  if (outputFormat) args.push('--output-format', outputFormat);

  if (config.claude.permissionMode) args.push('--permission-mode', config.claude.permissionMode);
  if (config.claude.model) args.push('--model', config.claude.model);

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

function summarizeToolUseBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;

  const summaries = [];
  for (const b of blocks) {
    if (b?.type !== 'tool_use') continue;
    const name = b.name || 'tool';
    const input = b.input || {};

    if (name === 'Bash' && input.command) {
      summaries.push(`Bash: ${String(input.command).slice(0, 120)}`);
      continue;
    }
    if ((name === 'Read' || name === 'Edit' || name === 'Write') && input.file_path) {
      const fp = String(input.file_path);
      summaries.push(`${name}: ${fp.split('/').pop()}`);
      continue;
    }
    if (name === 'Glob' && input.pattern) {
      summaries.push(`Glob: ${String(input.pattern).slice(0, 80)}`);
      continue;
    }
    if (name === 'Grep' && input.pattern) {
      summaries.push(`Grep: ${String(input.pattern).slice(0, 80)}`);
      continue;
    }

    summaries.push(String(name));
  }

  if (summaries.length === 0) return null;
  return summaries.slice(0, 3).join(' | ');
}

export function claudeParseLine({ obj }) {
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

  if (obj.type === 'assistant') {
    const blocks = obj.message?.content;
    const toolSummary = summarizeToolUseBlocks(blocks);
    if (toolSummary) return { updateText: toolSummary, usage };

    const text = extractTextFromContentBlocks(blocks).trim();
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
