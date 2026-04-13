import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRunnerModelProfileResolverForTest,
  __setRunnerModelProfileResolverForTest,
  listSuggestedRunnerModels,
} from './runner-models.js';

function withRunnerModelResolver(resolver, fn) {
  __setRunnerModelProfileResolverForTest(resolver);
  try {
    return fn();
  } finally {
    __resetRunnerModelProfileResolverForTest();
  }
}

test('listSuggestedRunnerModels reads local Claude profile metadata from runner modules', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'morpheus-runner-models-'));
  const settingsDir = join(tempRoot, '.claude-team');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    availableModels: ['claude-sonnet-team', 'claude-opus-team'],
    model: 'claude-primary-team',
    env: {
      ANTHROPIC_MODEL: 'claude-env-team',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-team',
    },
  }));

  try {
    const suggestions = withRunnerModelResolver(
      (runnerKind) => runnerKind === 'claude-team-private'
        ? {
          type: 'claude-settings',
          configDir: settingsDir,
          models: ['claude-fallback-team'],
          includeGenericModels: true,
        }
        : null,
      () => listSuggestedRunnerModels('claude-team-private', { taskModel: 'task-model' }),
    );

    assert.deepEqual(suggestions, [
      'task-model',
      'claude-sonnet-team',
      'claude-opus-team',
      'claude-primary-team',
      'claude-env-team',
      'claude-haiku-team',
      'claude-fallback-team',
      'sonnet',
      'opus',
      'haiku',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('listSuggestedRunnerModels falls back to generic Claude suggestions when local metadata has no models', () => {
  const suggestions = withRunnerModelResolver(
    (runnerKind) => runnerKind === 'claude-empty-profile'
      ? {
        type: 'claude-settings',
        configDir: '/path/that/does/not/exist',
        includeGenericModels: false,
      }
      : null,
    () => listSuggestedRunnerModels('claude-empty-profile', { taskModel: 'task-model' }),
  );

  assert.deepEqual(suggestions, ['task-model', 'sonnet', 'opus', 'haiku']);
});

test('listSuggestedRunnerModels supports static local suggestions for non-Claude runners', () => {
  const suggestions = withRunnerModelResolver(
    (runnerKind) => runnerKind === 'custom-runner'
      ? {
        models: ['fast-mode', 'safe-mode'],
      }
      : null,
    () => listSuggestedRunnerModels('custom-runner', { taskModel: 'task-model' }),
  );

  assert.deepEqual(suggestions, ['task-model', 'fast-mode', 'safe-mode']);
});
