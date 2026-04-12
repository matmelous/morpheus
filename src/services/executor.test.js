import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunStartBaseText,
  buildSilentStatusText,
  shouldSendNewSilentMessage,
} from './executor.js';

test('buildRunStartBaseText keeps the useful prompt and strips inline model directives', () => {
  assert.equal(
    buildRunStartBaseText({
      task: { title: 'wt' },
      prompt: 'model: gemma4:e4b\nListe os arquivos principais do projeto.',
    }),
    '🚀 Liste os arquivos principais do projeto.',
  );
});

test('buildSilentStatusText keeps the start message while only generic runner noise exists', () => {
  const out = buildSilentStatusText(
    {
      task_id: 'wt',
      started_at: new Date(Date.now() - 12_000).toISOString(),
      last_update: 'Running',
    },
    [{ content: 'Preparando runner' }],
    {
      fallbackBaseText: '🚀 Liste os arquivos principais do projeto.',
      lastBaseText: '',
      phase: 0,
    },
  );

  assert.equal(out.baseText, '🚀 Liste os arquivos principais do projeto');
  assert.match(out.text, /^🚀 Liste os arquivos principais do projeto\.+ \d+s$/);
});

test('buildSilentStatusText promotes the latest meaningful update over the start fallback', () => {
  const out = buildSilentStatusText(
    {
      task_id: 'wt',
      started_at: new Date(Date.now() - 65_000).toISOString(),
      last_update: 'Running',
    },
    [
      { content: 'Preparando runner' },
      { content: 'Verificando status do git' },
    ],
    {
      fallbackBaseText: '🚀 Liste os arquivos principais do projeto.',
      lastBaseText: '🚀 Liste os arquivos principais do projeto',
      phase: 0,
    },
  );

  assert.equal(out.baseText, 'Verificando status do git');
  assert.match(out.text, /^Verificando status do git\.+ 1m \d+s$/);
});

test('shouldSendNewSilentMessage rotates the edited Discord message only when the base update changes', () => {
  assert.equal(
    shouldSendNewSilentMessage(
      { lastSentBaseText: '🚀 Liste os arquivos principais do projeto' },
      { baseText: '🚀 Liste os arquivos principais do projeto' },
    ),
    false,
  );

  assert.equal(
    shouldSendNewSilentMessage(
      { lastSentBaseText: '🚀 Liste os arquivos principais do projeto' },
      { baseText: 'Verificando status do git' },
    ),
    true,
  );
});
