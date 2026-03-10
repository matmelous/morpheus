import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMemorySections, buildPromptWithMemories } from './memory-context.js';

test('buildMemorySections returns empty string when both memories are empty', () => {
  assert.equal(buildMemorySections({ sharedMemory: '', projectMemory: '', projectId: 'argo' }), '');
});

test('buildMemorySections includes shared and project sections', () => {
  const text = buildMemorySections({
    sharedMemory: '- prefiro respostas curtas',
    projectMemory: '- backend usa node 20',
    projectId: 'argo-api',
  });

  assert.match(text, /\[MEMORIA COMPARTILHADA\]/);
  assert.match(text, /\[MEMORIA DO PROJETO argo-api\]/);
  assert.match(text, /prefiro respostas curtas/);
  assert.match(text, /backend usa node 20/);
});

test('buildPromptWithMemories injects memory block before prompt', () => {
  const text = buildPromptWithMemories({
    prompt: 'implemente endpoint de status',
    sharedMemory: '- use pt-BR',
    projectMemory: '- arquitetura hexagonal',
    projectId: 'morpheus',
  });

  assert.match(text, /^\[MEMORIA COMPARTILHADA\]/);
  assert.match(text, /\[MEMORIA DO PROJETO morpheus\]/);
  assert.match(text, /\n\n\[PROMPT\]\nimplemente endpoint de status$/);
});
