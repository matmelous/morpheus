import { resolve } from 'path';

export function buildCodexRun({ prompt, artifactsDir, config }) {
  const lastPath = resolve(artifactsDir, 'last.txt');
  const command = config.codex.command;

  const args = ['exec'];
  if (config.codex.useDangerouslyBypassApprovals) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (config.codex.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (config.codex.sandboxMode) args.push('-s', config.codex.sandboxMode);
  args.push('--json');
  args.push('-o', lastPath);
  args.push(prompt);

  // For DB/debugging only: avoid persisting huge prompts/paths.
  const redactedArgs = args.map((a) => (a === prompt ? '<prompt>' : a));
  const commandJson = JSON.stringify({ command, args: redactedArgs });

  return { command, args, commandJson, lastPath };
}

export function codexParseLine({ obj }) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.type === 'thread.started' && obj.thread_id) {
    return { sessionId: obj.thread_id, updateText: 'thread.started' };
  }

  if ((obj.type === 'item.started' || obj.type === 'item.completed') && obj.item && typeof obj.item === 'object') {
    const it = obj.item;

    if (it.type === 'command_execution' && it.command) {
      const cmd = String(it.command);
      if (obj.type === 'item.completed' && typeof it.exit_code === 'number') {
        return { updateText: `Bash: ${cmd.slice(0, 120)} (exit ${it.exit_code})` };
      }
      return { updateText: `Bash: ${cmd.slice(0, 120)}` };
    }

    if (it.type === 'agent_message' && typeof it.text === 'string') {
      const text = it.text.trim();
      if (!text) return null;
      return {
        updateText: `assistant: ${text.slice(0, 160)}`,
        assistantDelta: text + '\n',
      };
    }

    if (it.type) {
      return { updateText: `${obj.type}: ${String(it.type)}` };
    }
  }

  if (obj.type === 'turn.completed') return { updateText: 'turn.completed' };

  return null;
}
