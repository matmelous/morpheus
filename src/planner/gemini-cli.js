import { spawn } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger.js';
import { parseFirstJsonObject } from './json.js';

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function planWithGeminiCli({ promptText, timeoutMs, config }) {
  const command = config.gemini.command;
  const args = [
    '--prompt', promptText,
    '--output-format', config.gemini.outputFormat || 'stream-json',
  ];
  if (config.gemini.approvalMode) args.push('--approval-mode', config.gemini.approvalMode);
  if (config.gemini.model) args.push('--model', config.gemini.model);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: config.appRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let model = null;
    let sessionId = null;
    let assistant = '';
    let stderr = '';

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type === 'init') {
        model = obj.model || model;
        sessionId = obj.session_id || sessionId;
        return;
      }

      if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
        if (obj.delta) assistant += obj.content;
        else assistant += obj.content + '\n';
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    let timeout = null;
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        logger.warn({ command, timeoutMs }, 'Planner gemini-cli timeout, killing');
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 5000).unref();
      }, timeoutMs);
      timeout.unref();
    }

    child.on('error', (err) => {
      try { rl.close(); } catch {}
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      try { rl.close(); } catch {}
      if (timeout) clearTimeout(timeout);

      const exitCode = code == null ? -1 : code;
      if (exitCode !== 0) {
        // Gemini CLI sometimes returns non-zero even after streaming a complete assistant JSON.
        // If we did get a parseable JSON plan, treat it as success and log the exit as warning.
        const assistantText = assistant.trim();
        if (assistantText) {
          try {
            parseFirstJsonObject(assistantText);
            logger.warn(
              { exitCode, stderr: stderr.trim().slice(0, 500) },
              'Planner gemini-cli exited non-zero but produced parseable output; accepting it'
            );
            return resolve({
              provider: 'gemini-cli',
              model,
              sessionId,
              assistantText,
              stderr: stderr.trim(),
              exitCode,
            });
          } catch {
            // fall through to reject below
          }
        }
        return reject(new Error(`gemini exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`));
      }

      resolve({
        provider: 'gemini-cli',
        model,
        sessionId,
        assistantText: assistant.trim(),
        stderr: stderr.trim(),
        exitCode,
      });
    });
  });
}
