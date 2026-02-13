import { getDb } from '../db/index.js';
import { config } from '../config/index.js';

export const SettingsKeys = {
  orchestratorProviderDefault: 'orchestrator_provider_default',
  runnerDefault: 'runner_default',
  maxParallelTasks: 'max_parallel_tasks',
  maxParallelGuiTasks: 'max_parallel_gui_tasks',
  artifactRetentionDays: 'artifact_retention_days',
  taskTimeoutMs: 'task_timeout_ms',
  pendingSelectionTtlMs: 'pending_selection_ttl_ms',
};

function nowIso() {
  return new Date().toISOString();
}

export function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

export function ensureDefaultSettings() {
  const defaults = new Map([
    [SettingsKeys.orchestratorProviderDefault, config.orchestratorProvider === 'auto' ? 'gemini-cli' : config.orchestratorProvider],
    [SettingsKeys.runnerDefault, config.runnerDefault],
    [SettingsKeys.maxParallelTasks, String(config.maxParallelTasks)],
    [SettingsKeys.maxParallelGuiTasks, String(config.maxParallelGuiTasks)],
    [SettingsKeys.artifactRetentionDays, String(config.artifactRetentionDays)],
    [SettingsKeys.taskTimeoutMs, String(config.taskTimeoutMs)],
    [SettingsKeys.pendingSelectionTtlMs, String(config.pendingSelectionTtlMs)],
  ]);

  for (const [key, value] of defaults.entries()) {
    const existing = getSetting(key);
    if (existing == null) setSetting(key, value);
  }
}

export function getRunnerDefault() {
  return getSetting(SettingsKeys.runnerDefault) || config.runnerDefault;
}

export function getOrchestratorProviderDefault() {
  return getSetting(SettingsKeys.orchestratorProviderDefault) || (config.orchestratorProvider === 'auto' ? 'gemini-cli' : config.orchestratorProvider);
}

