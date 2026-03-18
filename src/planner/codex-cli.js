import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve as resolvePath } from 'path';
import { spawn } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger.js';
import { mergeTokenUsage, normalizeTokenUsage } from '../services/token-meter.js';
import { parseFirstJsonObject } from './json.js';

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function shouldWrapWindowsBatchCommand(command) {
  if (process.platform !== 'win32') return false;
  const cmd = String(command || '').trim().toLowerCase();
  return cmd.endsWith('.cmd') || cmd.endsWith('.bat');
}

export async function planWithCodexCli({ systemPrompt, userPrompt, timeoutMs, config }) {
  const command = config.codex.command;
  if (!command) throw new Error('CODEX_CLI_COMMAND is not set');

  const tmpBase = mkdtempSync(resolvePath(tmpdir(), 'morpheus-planner-codex-'));
  const lastPath = resolvePath(tmpBase, 'last.txt');
  const promptText = `${String(systemPrompt || '').trim()}\n\n${String(userPrompt || '').trim()}`;

  const args = ['exec'];
  if (config.codex.useDangerouslyBypassApprovals) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (config.codex.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (config.codex.sandboxMode) args.push('-s', config.codex.sandboxMode);
  args.push('--json');
  args.push('-o', lastPath);
  // Read prompt from stdin to avoid Windows command-line length limits.
  args.push('-');

  const cleanup = () => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  };

  return new Promise((resolve, reject) => {
    let stderr = '';
    let usage = null;
    let assistantBuffer = '';
    let settled = false;

    let child;
    let timeout = null;
    try {
      const wrapBatch = shouldWrapWindowsBatchCommand(command);
      const effectiveCommand = wrapBatch ? 'cmd.exe' : command;
      const effectiveArgs = wrapBatch
        ? ['/d', '/s', '/c', command, ...args]
        : args;

      child = spawn(effectiveCommand, effectiveArgs, {
        cwd: config.appRoot,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const rlOut = readline.createInterface({ input: child.stdout });
      rlOut.on('line', (line) => {
        const obj = safeJsonParse(line);
        if (!obj) return;

        const u = normalizeTokenUsage(obj, 'provider');
        if (u) usage = mergeTokenUsage(usage, u);

        if (obj.type === 'item.completed' && obj.item && typeof obj.item === 'object') {
          const item = obj.item;
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            const text = item.text.trim();
            if (text) assistantBuffer += `${text}\n`;
          }
        }
      });

      const rlErr = readline.createInterface({ input: child.stderr });
      rlErr.on('line', (line) => {
        stderr += `${line}\n`;
      });

      // Feed full planner prompt through stdin.
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
      const fromFile = existsSync(lastPath) ? String(readFileSync(lastPath, 'utf-8') || '').trim() : '';
      const assistantText = fromFile || assistantBuffer.trim();

      if (exitCode !== 0) {
        if (assistantText) {
          try {
            parseFirstJsonObject(assistantText);
            logger.warn(
              { exitCode, stderr: stderr.trim().slice(0, 500) },
              'Planner codex-cli exited non-zero but produced parseable output; accepting it'
            );
            cleanup();
            resolve({
              provider: 'codex-cli',
              model: null,
              assistantText,
              usage,
              stderr: stderr.trim(),
              exitCode,
            });
            return;
          } catch {}
        }

        cleanup();
        reject(new Error(`codex planner exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`));
        return;
      }

      cleanup();
      resolve({
        provider: 'codex-cli',
        model: null,
        assistantText,
        usage,
        stderr: stderr.trim(),
        exitCode,
      });
    });
  });
}
