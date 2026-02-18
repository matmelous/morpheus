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
    planner: {
      purpose: 'Runner geral para tarefas de codigo/shell com alta autonomia.',
    },
  }],
  ['claude-cli', {
    kind: 'claude-cli',
    build: buildClaudeRun,
    parseLine: (ctx) => claudeParseLine(ctx),
    planner: {
      purpose: 'Runner geral alternativo para tarefas de codigo/shell.',
    },
  }],
  ['cursor-cli', {
    kind: 'cursor-cli',
    build: buildCursorRun,
    parseLine: (ctx) => cursorParseLine(ctx),
    planner: {
      purpose: 'Runner geral alternativo para tarefas de codigo/shell.',
    },
  }],
  ['gemini-cli', {
    kind: 'gemini-cli',
    build: buildGeminiRun,
    parseLine: (ctx) => geminiParseLine(ctx),
    planner: {
      purpose: 'Runner geral alternativo para tarefas de codigo/shell.',
    },
  }],
  ['desktop-agent', {
    kind: 'desktop-agent',
    build: buildDesktopAgentRun,
    parseLine: (ctx) => desktopAgentParseLine(ctx),
    planner: {
      purpose: 'Automacao de interface (web/desktop) com evidencia visual.',
      whenToUse: [
        'Quando precisar clicar/navegar em UI real.',
        'Quando o usuario pedir screenshot/evidencia visual.',
      ],
    },
  }],
]);

function isLoadableModuleFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return ext === '.js' || ext === '.mjs' || ext === '.cjs';
}

function normalizePlannerText(value, maxLen = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function normalizePlannerList(value, { maxItems = 5, maxLen = 220 } = {}) {
  const rawList = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const out = [];
  for (const item of rawList) {
    const normalized = normalizePlannerText(item, maxLen);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizePlannerMetadata(rawPlanner) {
  if (!rawPlanner || typeof rawPlanner !== 'object') return null;

  const purpose = normalizePlannerText(rawPlanner.purpose || rawPlanner.description || '', 220);
  const whenToUse = normalizePlannerList(rawPlanner.whenToUse || rawPlanner.when_to_use || rawPlanner.triggers, {
    maxItems: 4,
    maxLen: 180,
  });
  const promptRules = normalizePlannerList(
    rawPlanner.promptRules || rawPlanner.prompt_rules || rawPlanner.promptContract || rawPlanner.prompt_contract,
    { maxItems: 6, maxLen: 220 },
  );
  const promptExamples = normalizePlannerList(rawPlanner.promptExamples || rawPlanner.prompt_examples || rawPlanner.examples, {
    maxItems: 4,
    maxLen: 220,
  });

  if (!purpose && whenToUse.length === 0 && promptRules.length === 0 && promptExamples.length === 0) {
    return null;
  }

  return {
    purpose: purpose || null,
    whenToUse,
    promptRules,
    promptExamples,
  };
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
    planner: normalizePlannerMetadata(rawRunner.planner || rawRunner.capabilities || null),
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

export function listRunnerCatalog({ includeAuto = false } = {}) {
  const items = Array.from(RUNNERS.values())
    .map((runner) => ({
      kind: runner.kind,
      planner: normalizePlannerMetadata(runner.planner || null),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  if (includeAuto) {
    items.push({
      kind: 'auto',
      planner: {
        purpose: 'Deixar o planner escolher automaticamente o runner.',
        whenToUse: ['Quando o usuario pedir explicitamente modo automatico.'],
        promptRules: [],
        promptExamples: [],
      },
    });
  }

  return items;
}

export function isRunnerKindSupported(kind, { includeAuto = false } = {}) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return false;
  if (includeAuto && k === 'auto') return true;
  return RUNNERS.has(k);
}
