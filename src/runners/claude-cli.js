import { normalizeTokenUsage } from '../services/token-meter.js';

function buildClaudeSettings(config) {
  const settings = {};

  if (config.claude.disableCommitAttribution) {
    settings.attribution = { commit: '' };
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

function resolveClaudeModel({ config, task }) {
  const taskModel = String(task?.runner_model || '').trim();
  if (taskModel) return taskModel;
  return String(config?.claude?.model || '').trim();
}

export function buildClaudeRun({ prompt, config, task }) {
  const command = config.claude.command;

  const args = ['-p'];

  const outputFormat = config.claude.outputFormat || 'stream-json';
  const needVerbose = outputFormat === 'stream-json';
  if (config.claude.verbose || needVerbose) args.push('--verbose');
  if (outputFormat) args.push('--output-format', outputFormat);

  if (config.claude.permissionMode) args.push('--permission-mode', config.claude.permissionMode);
  const model = resolveClaudeModel({ config, task });
  if (model) args.push('--model', model);

  const settings = buildClaudeSettings(config);
  if (settings) args.push('--settings', JSON.stringify(settings));

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
      summaries.push(`Bash: ${String(input.command)}`);
      continue;
    }
    if ((name === 'Read' || name === 'Edit' || name === 'Write') && input.file_path) {
      summaries.push(`${name}: ${String(input.file_path)}`);
      continue;
    }
    if (name === 'Glob' && input.pattern) {
      summaries.push(`Glob: ${String(input.pattern)}`);
      continue;
    }
    if (name === 'Grep' && input.pattern) {
      summaries.push(`Grep: ${String(input.pattern)}`);
      continue;
    }

    summaries.push(String(name));
  }

  if (summaries.length === 0) return null;
  return summaries.join(' | ');
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
      updateText: `assistant: ${text}`,
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
