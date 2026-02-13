export function buildGeminiRun({ prompt, config }) {
  const command = config.gemini.command;

  const args = [
    '--prompt', prompt,
    '--output-format', config.gemini.outputFormat || 'stream-json',
  ];

  if (config.gemini.approvalMode) args.push('--approval-mode', config.gemini.approvalMode);
  if (config.gemini.model) args.push('--model', config.gemini.model);

  const redactedArgs = args.map((a) => (a === prompt ? '<prompt>' : a));
  const commandJson = JSON.stringify({ command, args: redactedArgs });

  return { command, args, commandJson };
}

export function geminiParseLine({ obj }) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.type === 'init') {
    return {
      model: obj.model,
      sessionId: obj.session_id,
      updateText: 'init',
    };
  }

  if (obj.type === 'tool_use') {
    const name = obj.tool_name || 'tool';
    const fp = obj.parameters?.file_path ? String(obj.parameters.file_path).split('/').pop() : '';
    return { updateText: `tool:${name}${fp ? ` ${fp}` : ''}` };
  }

  if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
    const text = obj.content.trim();
    if (!text) return null;
    return {
      updateText: `assistant: ${text.slice(0, 160)}`,
      assistantDelta: obj.delta ? obj.content : text + '\n',
    };
  }

  if (obj.type === 'result') {
    const status = obj.status || 'done';
    return { updateText: `result:${status}` };
  }

  return null;
}
