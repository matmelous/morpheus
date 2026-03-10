import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { spawnStreamingProcess } from './spawn.js';

test('spawnStreamingProcess closes promptly when a grandchild keeps inherited pipes open', async () => {
  const child = spawnStreamingProcess({
    command: process.execPath,
    args: [
      '-e',
      `
        const { spawn } = require('child_process');
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        }).unref();
      `,
    ],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    closeGraceMs: 200,
  });

  const startedAt = Date.now();
  const [code, signal] = await Promise.race([
    once(child, 'close'),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('close event timed out')), 2000).unref?.();
    }),
  ]);

  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(Date.now() - startedAt < 2000, 'close should not wait for the grandchild to finish');
});
