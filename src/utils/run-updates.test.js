import test from 'node:test';
import assert from 'node:assert/strict';

import {
  humanizeTaskUpdate,
  summarizeRecentRunActivity,
  summarizeShellCommand,
  summarizeStderrLine,
} from './run-updates.js';

test('summarizeShellCommand classifies file listing commands', () => {
  assert.equal(
    summarizeShellCommand('/bin/bash -lc "rg --files src"'),
    'Listando arquivos do projeto',
  );
});

test('humanizeTaskUpdate converts bash updates to friendly text', () => {
  assert.equal(
    humanizeTaskUpdate('Bash: /bin/bash -lc "sed -n \'1,40p\' AGENTS.md"'),
    'Lendo arquivos do projeto',
  );
});

test('humanizeTaskUpdate strips assistant prefix for display', () => {
  assert.equal(
    humanizeTaskUpdate('assistant: Vou revisar a estrutura e resumir o que encontrar.'),
    'Vou revisar a estrutura e resumir o que encontrar.',
  );
});

test('summarizeStderrLine ignores noisy informational stderr', () => {
  assert.equal(summarizeStderrLine('info: reconnecting transport'), null);
});

test('summarizeStderrLine preserves meaningful failures', () => {
  assert.match(
    summarizeStderrLine('fatal: repository not found'),
    /Aviso do runner: fatal: repository not found/i,
  );
});

test('summarizeRecentRunActivity builds a compact digest from recent updates', () => {
  assert.deepEqual(
    summarizeRecentRunActivity([
      { content: 'Listando arquivos do projeto' },
      { content: 'Buscando no codigo do projeto' },
      { content: 'Editando arquivo: /Users/matheus/development/morpheus/src/services/executor.js' },
      { content: 'Escrevendo arquivo: /Users/matheus/development/morpheus/src/utils/run-updates.js' },
      { content: 'Vou ajustar o formato do feedback e limpar o excesso de ruído no Discord.' },
    ]),
    [
      'Vou ajustar o formato do feedback e limpar o excesso de ruído no Discord.',
      'Atividade recente: 1 leitura, 1 busca, 2 arquivos alterados.',
      'Arquivos tocados: src/services/executor.js, src/utils/run-updates.js.',
    ],
  );
});

test('summarizeRecentRunActivity keeps the latest warning when relevant', () => {
  assert.deepEqual(
    summarizeRecentRunActivity([
      { content: 'Buscando no codigo do projeto' },
      { content: 'Aviso do runner: fatal: repository not found' },
    ]),
    [
      'Atividade recente: 1 busca.',
      'Aviso do runner: fatal: repository not found',
    ],
  );
});
