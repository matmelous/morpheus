import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve as resolvePath } from 'path';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { normalizeTokenUsage } from '../services/token-meter.js';
import { parseFirstJsonObject } from './json.js';

function shouldWrapWindowsBatchCommand(command) {
  const cmd = String(command || '').trim().toLowerCase();
  if (process.platform !== 'win32') return false;
  return cmd.endsWith('.cmd') || cmd.endsWith('.bat');
}

export async function planWithClaudeCli({ systemPrompt, userPrompt, timeoutMs, config }) {
  const command = config.claude.command;
  if (!command) throw new Error('CLAUDE_CLI_COMMAND is not set');

  const promptText = String(userPrompt || '').trim();
  const model = String(config.claude.plannerModel || config.claude.model || '').trim();

  // Planning runs in a throwaway dir so the CLI does not pick up CLAUDE.md or repo
  // context and answer conversationally instead of returning the plan JSON.
  const tmpBase = mkdtempSync(resolvePath(tmpdir(), 'morpheus-planner-claude-'));

  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  // Replace the agentic system prompt with the planner one: this is a single
  // JSON completion, not a coding session.
  args.push('--system-prompt', String(systemPrompt || '').trim());
  args.push('--setting-sources', '');
  args.push('--strict-mcp-config');
  args.push('--permission-mode', 'plan');
  args.push(
    '--disallowed-tools',
    'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit'
  );

  const cleanup = () => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  };

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    let timeout = null;
    try {
      const wrapBatch = shouldWrapWindowsBatchCommand(command);
      const effectiveCommand = wrapBatch ? 'cmd.exe' : command;
      const effectiveArgs = wrapBatch ? ['/d', '/s', '/c', command, ...args] : args;

      child = spawn(effectiveCommand, effectiveArgs, {
        cwd: tmpBase,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      // Read prompt from stdin to avoid command-line length limits.
      child.stdin.end(promptText);

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, 5000).unref();
        }, timeoutMs);
        timeout.unref?.();
      }
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanup();
      reject(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);

      const exitCode = code == null ? -1 : code;
      let envelope = null;
      try {
        envelope = parseFirstJsonObject(stdout);
      } catch {}

      // `claude -p` reports auth/quota problems as a successful run with is_error=true.
      if (envelope && envelope.is_error) {
        cleanup();
        reject(new Error(`claude planner error: ${String(envelope.result || '').slice(0, 500)}`));
        return;
      }

      const assistantText = String(envelope?.result || '').trim();

      if (exitCode !== 0 && !assistantText) {
        cleanup();
        reject(new Error(`claude planner exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`));
        return;
      }

      if (exitCode !== 0) {
        logger.warn(
          { exitCode, stderr: stderr.trim().slice(0, 500) },
          'Planner claude-cli exited non-zero but produced output; accepting it'
        );
      }

      cleanup();
      resolve({
        provider: 'claude-cli',
        model: envelope?.modelUsage ? Object.keys(envelope.modelUsage)[0] || model || null : model || null,
        assistantText,
        usage: normalizeTokenUsage(envelope, 'provider'),
        stderr: stderr.trim(),
        exitCode,
      });
    });
  });
}
