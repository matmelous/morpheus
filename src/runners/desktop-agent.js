import { resolve } from 'path';

export function buildDesktopAgentRun({ prompt, cwd, artifactsDir }) {
  const scriptPath = resolve(process.cwd(), 'src', 'runners', 'desktop-agent-run.js');
  const args = [scriptPath, '--prompt', prompt, '--cwd', cwd, '--artifacts', artifactsDir];
  const redactedArgs = args.map((a, i) => (i > 0 && args[i - 1] === '--prompt' ? '<prompt>' : a));
  const commandJson = JSON.stringify({ command: process.execPath, args: redactedArgs });
  return { command: process.execPath, args, commandJson };
}

export function desktopAgentParseLine({ obj, rawLine }) {
  // Runner writes JSONL. We keep parsing permissive so we can stream updates.
  const o = obj && typeof obj === 'object' ? obj : null;
  if (!o) return null;

  if (o.type === 'model' && o.model) return { model: String(o.model), updateText: `model: ${String(o.model).slice(0, 80)}` };
  if (o.type === 'update' && o.text) return { updateText: String(o.text).slice(0, 500) };

  if (o.type === 'blocked') {
    return {
      blockedReason: String(o.reason || o.blockedReason || 'blocked'),
      updateText: `blocked: ${String(o.reason || o.blockedReason || 'blocked').slice(0, 80)}`,
      finalResult: o.summary || o.message || null,
    };
  }

  if (o.type === 'final') {
    const text = o.text || o.final_text || o.summary || '';
    return {
      updateText: 'final',
      assistantDelta: text ? String(text) + '\n' : null,
      finalResult: text ? String(text) : null,
    };
  }

  // Fallback for debugging unknown lines
  if (rawLine && rawLine.length < 200) return { updateText: `event: ${rawLine}` };
  return null;
}

