import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { config } from '../config/index.js';

function pushUnique(list, value) {
  const text = String(value || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function safeReadJson(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readClaudeProfileModels(configDir) {
  const settingsPath = resolve(configDir, 'settings.json');
  const settings = safeReadJson(settingsPath);
  const out = [];

  if (!settings || typeof settings !== 'object') return out;

  if (Array.isArray(settings.availableModels)) {
    for (const item of settings.availableModels) pushUnique(out, item);
  }

  pushUnique(out, settings.model);

  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  pushUnique(out, env.ANTHROPIC_MODEL);
  pushUnique(out, env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  pushUnique(out, env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  pushUnique(out, env.ANTHROPIC_DEFAULT_OPUS_MODEL);

  return out;
}

function getHomeDir() {
  return os.homedir();
}

function listLocalClaudeModels() {
  const out = readClaudeProfileModels(resolve(getHomeDir(), '.claude-local'));
  pushUnique(out, 'gemma4:e4b');
  pushUnique(out, 'gemma4:26b');
  return out;
}

function listOpenRouterModels() {
  const out = readClaudeProfileModels(resolve(getHomeDir(), '.claude-openrouter'));
  pushUnique(out, process.env.CLAUDE_OPENROUTER_MODEL);
  pushUnique(out, 'openrouter/free');
  pushUnique(out, 'anthropic/claude-sonnet-4');
  pushUnique(out, 'openai/gpt-5-chat');
  return out;
}

function listGenericClaudeModels() {
  const out = [];
  pushUnique(out, config.claude?.model);
  pushUnique(out, 'sonnet');
  pushUnique(out, 'opus');
  pushUnique(out, 'haiku');
  return out;
}

export function listSuggestedRunnerModels(runnerKind, { taskModel = '' } = {}) {
  const normalizedRunner = String(runnerKind || '').trim().toLowerCase();
  const out = [];

  pushUnique(out, taskModel);

  if (normalizedRunner === 'claude-local') {
    for (const item of listLocalClaudeModels()) pushUnique(out, item);
    return out;
  }

  if (normalizedRunner === 'claude-openrouter') {
    for (const item of listOpenRouterModels()) pushUnique(out, item);
    return out;
  }

  if (normalizedRunner === 'claude-pessoal') {
    for (const item of readClaudeProfileModels(resolve(getHomeDir(), '.claude-pessoal'))) pushUnique(out, item);
    for (const item of listGenericClaudeModels()) pushUnique(out, item);
    return out;
  }

  if (normalizedRunner === 'claude-visionnaire') {
    for (const item of readClaudeProfileModels(resolve(getHomeDir(), '.claude-visionnaire'))) pushUnique(out, item);
    for (const item of listGenericClaudeModels()) pushUnique(out, item);
    return out;
  }

  if (normalizedRunner === 'claude-cli' || normalizedRunner.startsWith('claude')) {
    for (const item of listGenericClaudeModels()) pushUnique(out, item);
    return out;
  }

  return out;
}
