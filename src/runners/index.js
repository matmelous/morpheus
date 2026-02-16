import { buildCodexRun, codexParseLine } from './codex-cli.js';
import { buildClaudeRun, claudeParseLine } from './claude-cli.js';
import { buildCursorRun, cursorParseLine } from './cursor-cli.js';
import { buildGeminiRun, geminiParseLine } from './gemini-cli.js';
import { buildDesktopAgentRun, desktopAgentParseLine } from './desktop-agent.js';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const BUILTIN_RUNNERS = new Map([
  ['codex-cli', {
    kind: 'codex-cli',
    build: buildCodexRun,
    parseLine: (ctx) => codexParseLine(ctx),
  }],
  ['claude-cli', {
    kind: 'claude-cli',
    build: buildClaudeRun,
    parseLine: (ctx) => claudeParseLine(ctx),
  }],
  ['cursor-cli', {
    kind: 'cursor-cli',
    build: buildCursorRun,
    parseLine: (ctx) => cursorParseLine(ctx),
  }],
  ['gemini-cli', {
    kind: 'gemini-cli',
    build: buildGeminiRun,
    parseLine: (ctx) => geminiParseLine(ctx),
  }],
  ['desktop-agent', {
    kind: 'desktop-agent',
    build: buildDesktopAgentRun,
    parseLine: (ctx) => desktopAgentParseLine(ctx),
  }],
]);

function isLoadableModuleFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return ext === '.js' || ext === '.mjs' || ext === '.cjs';
}

function normalizeExternalRunner(rawRunner, sourcePath) {
  if (!rawRunner || typeof rawRunner !== 'object') return null;

  const kind = String(rawRunner.kind || '').trim().toLowerCase();
  if (!kind || kind === 'auto') {
    logger.warn({ sourcePath }, 'Runner module ignored: invalid kind');
    return null;
  }
  if (typeof rawRunner.build !== 'function') {
    logger.warn({ sourcePath, kind }, 'Runner module ignored: missing build()');
    return null;
  }

  return {
    kind,
    build: rawRunner.build,
    parseLine: typeof rawRunner.parseLine === 'function' ? rawRunner.parseLine : null,
  };
}

async function loadExternalRunners() {
  const out = new Map();
  const modulesDir = resolve(config.runnerModulesDir);

  if (!existsSync(modulesDir)) return out;

  let files = [];
  try {
    files = readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isLoadableModuleFile(entry.name))
      .map((entry) => resolve(modulesDir, entry.name));
  } catch (err) {
    logger.warn({ error: err?.message, modulesDir }, 'Failed to read runner modules dir');
    return out;
  }

  files.sort((a, b) => a.localeCompare(b));

  for (const filePath of files) {
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const candidate = mod?.default || mod?.runnerModule || mod;
      const normalized = normalizeExternalRunner(candidate, filePath);
      if (!normalized) continue;

      if (BUILTIN_RUNNERS.has(normalized.kind)) {
        logger.warn({ filePath, kind: normalized.kind }, 'Runner module ignored: kind conflicts with built-in runner');
        continue;
      }
      if (out.has(normalized.kind)) {
        logger.warn({ filePath, kind: normalized.kind }, 'Runner module ignored: duplicate kind');
        continue;
      }

      out.set(normalized.kind, normalized);
      logger.info({ kind: normalized.kind, file: basename(filePath) }, 'Runner module loaded');
    } catch (err) {
      logger.warn({ error: err?.message, filePath }, 'Failed to load runner module');
    }
  }

  return out;
}

const EXTERNAL_RUNNERS = await loadExternalRunners();
const RUNNERS = new Map([...BUILTIN_RUNNERS, ...EXTERNAL_RUNNERS]);

export function getRunner(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  return RUNNERS.get(normalized) || null;
}

export function listSupportedRunnerKinds({ includeAuto = false } = {}) {
  const kinds = Array.from(RUNNERS.keys());
  if (includeAuto) kinds.push('auto');
  return kinds;
}

export function isRunnerKindSupported(kind, { includeAuto = false } = {}) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return false;
  if (includeAuto && k === 'auto') return true;
  return RUNNERS.has(k);
}
