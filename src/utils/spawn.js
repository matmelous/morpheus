import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import readline from 'readline';
import { logger } from './logger.js';

export function spawnStreamingProcess({
  command,
  args,
  cwd,
  env,
  stdoutPath,
  stderrPath,
  timeoutMs,
  onStdoutLine,
  onStderrLine,
}) {
  if (stdoutPath) mkdirSync(dirname(stdoutPath), { recursive: true });
  if (stderrPath) mkdirSync(dirname(stderrPath), { recursive: true });

  const child = spawn(command, args, {
    cwd,
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutStream = stdoutPath ? createWriteStream(stdoutPath, { flags: 'a' }) : null;
  const stderrStream = stderrPath ? createWriteStream(stderrPath, { flags: 'a' }) : null;

  const closeStreams = () => {
    try { stdoutStream?.end(); } catch {}
    try { stderrStream?.end(); } catch {}
  };

  const stdoutRl = child.stdout
    ? readline.createInterface({ input: child.stdout })
    : null;
  stdoutRl?.on('line', (line) => {
    try { stdoutStream?.write(line + '\n'); } catch {}
    try { onStdoutLine?.(line); } catch (err) {
      logger.warn({ error: err?.message }, 'onStdoutLine handler failed');
    }
  });

  const stderrRl = child.stderr
    ? readline.createInterface({ input: child.stderr })
    : null;
  stderrRl?.on('line', (line) => {
    try { stderrStream?.write(line + '\n'); } catch {}
    try { onStderrLine?.(line); } catch (err) {
      logger.warn({ error: err?.message }, 'onStderrLine handler failed');
    }
  });

  let timeout = null;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => {
      logger.warn({ command, cwd, timeoutMs }, 'Process timeout reached, killing');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5000).unref();
    }, timeoutMs);
    timeout.unref();
  }

  child.on('close', () => {
    try { stdoutRl?.close(); } catch {}
    try { stderrRl?.close(); } catch {}
    if (timeout) clearTimeout(timeout);
    closeStreams();
  });

  return child;
}
