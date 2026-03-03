import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeParseLine } from './claude-cli.js';
import { cursorParseLine } from './cursor-cli.js';
import { geminiParseLine } from './gemini-cli.js';

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

  assert.equal(out?.updateText, 'Read: README.md');
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

  assert.equal(out?.updateText, 'Edit: index.js');
});

test('geminiParseLine summarizes Windows-style paths', () => {
  const out = geminiParseLine({
    obj: {
      type: 'tool_use',
      tool_name: 'Write',
      parameters: { file_path: 'C:\\dev\\morpheus\\notes\\todo.txt' },
    },
  });

  assert.equal(out?.updateText, 'tool:Write todo.txt');
});
