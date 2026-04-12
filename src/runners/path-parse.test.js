import test from 'node:test';
import assert from 'node:assert/strict';
import { codexParseLine } from './codex-cli.js';
import { buildClaudeRun, claudeParseLine } from './claude-cli.js';
import { cursorParseLine } from './cursor-cli.js';
import { geminiParseLine } from './gemini-cli.js';

test('buildClaudeRun disables commit attribution by default', () => {
  const out = buildClaudeRun({
    prompt: 'reply with ok',
    config: {
      claude: {
        command: 'claude',
        outputFormat: 'stream-json',
        verbose: true,
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
        disableCommitAttribution: true,
      },
    },
  });

  const settingsIndex = out.args.indexOf('--settings');
  assert.notEqual(settingsIndex, -1);
  assert.equal(out.args[settingsIndex + 1], '{"attribution":{"commit":""}}');
});

test('buildClaudeRun preserves attribution config override', () => {
  const out = buildClaudeRun({
    prompt: 'reply with ok',
    config: {
      claude: {
        command: 'claude',
        outputFormat: 'stream-json',
        verbose: true,
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
        disableCommitAttribution: false,
      },
    },
  });

  assert.equal(out.args.includes('--settings'), false);
});

test('buildClaudeRun prefers task runner_model over config model', () => {
  const out = buildClaudeRun({
    prompt: 'reply with ok',
    task: {
      runner_model: 'gemma4:e4b',
    },
    config: {
      claude: {
        command: 'claude',
        outputFormat: 'stream-json',
        verbose: true,
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
        disableCommitAttribution: true,
      },
    },
  });

  const modelIndex = out.args.indexOf('--model');
  assert.notEqual(modelIndex, -1);
  assert.equal(out.args[modelIndex + 1], 'gemma4:e4b');
});

test('claudeParseLine summarizes Windows-style paths', () => {
  const out = claudeParseLine({
    obj: {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: 'C:\\dev\\morpheus\\README.md' },
          },
        ],
      },
    },
  });

  assert.equal(out?.updateText, 'Read: C:\\dev\\morpheus\\README.md');
});

test('cursorParseLine summarizes Windows-style paths', () => {
  const out = cursorParseLine({
    obj: {
      type: 'tool_call',
      tool_call: {
        editToolCall: {
          args: { path: 'C:\\dev\\morpheus\\src\\index.js' },
        },
      },
    },
  });

  assert.equal(out?.updateText, 'Edit: C:\\dev\\morpheus\\src\\index.js');
});

test('geminiParseLine summarizes Windows-style paths', () => {
  const out = geminiParseLine({
    obj: {
      type: 'tool_use',
      tool_name: 'Write',
      parameters: { file_path: 'C:\\dev\\morpheus\\notes\\todo.txt' },
    },
  });

  assert.equal(out?.updateText, 'tool:Write C:\\dev\\morpheus\\notes\\todo.txt');
});

test('codexParseLine ignores thread lifecycle noise', () => {
  const out = codexParseLine({
    obj: {
      type: 'thread.started',
      thread_id: 'thread-123',
    },
  });

  assert.equal(out?.sessionId, 'thread-123');
  assert.equal(out?.updateText, undefined);
});

test('codexParseLine summarizes command execution without dumping the whole command', () => {
  const out = codexParseLine({
    obj: {
      type: 'item.started',
      item: {
        type: 'command_execution',
        command: '/bin/bash -lc "rg --files src"',
      },
    },
  });

  assert.equal(out?.updateText, 'Listando arquivos do projeto');
});
