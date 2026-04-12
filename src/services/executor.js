import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { formatElapsed } from '../utils/time.js';
import { makeId } from '../utils/ids.js';
import { spawnStreamingProcess } from '../utils/spawn.js';
import { getRunner } from '../runners/index.js';
import { taskStore } from './task-store.js';
import { isDiscordActorId, sendAudio, sendFile, sendImage, sendMessage, upsertMessage } from './messenger.js';
import { safeFileName } from './media-utils.js';
import { buildPromptWithMemories } from './memory-context.js';
import { isSilentLogLevel, isVerboseLogLevel, normalizeUserLogLevel } from './log-levels.js';
import {
  estimateUsage,
  formatTokenSummaryLine,
  logTokenUsage,
  logUsageFallbackEstimate,
  mergeTokenUsage,
  normalizeTokenUsage,
} from './token-meter.js';
import { humanizeTaskUpdate, summarizeRecentRunActivity, summarizeStderrLine } from '../utils/run-updates.js';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isQuotaLine(line) {
  const s = String(line || '');
  return (
    s.includes("You've hit your usage limit") ||
    s.includes("You've hit your limit") ||
    s.includes('hit your limit') ||
    s.includes('usage limit')
  );
}

function writeJson(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  } catch (err) {
    logger.warn({ path, error: err?.message }, 'Failed to write JSON artifact');
  }
}

function writeText(path, value) {
  try {
    writeFileSync(path, String(value ?? ''), 'utf-8');
  } catch (err) {
    logger.warn({ path, error: err?.message }, 'Failed to write text artifact');
  }
}

function safeReadJsonFile(path) {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferMimeFromPath(path) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.m4a')) return 'audio/mp4';
  if (p.endsWith('.ogg') || p.endsWith('.oga')) return 'audio/ogg';
  if (p.endsWith('.wav')) return 'audio/wav';
  if (p.endsWith('.pdf')) return 'application/pdf';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.txt')) return 'text/plain';
  if (p.endsWith('.csv')) return 'text/csv';
  if (p.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function inferEvidenceKind(path, mimetype) {
  const mime = String(mimetype || inferMimeFromPath(path)).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const IMAGE_PATH_EXT_REGEX = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUTO_EVIDENCE_MAX_ITEMS = 3;

function isImageFilePath(path) {
  return IMAGE_PATH_EXT_REGEX.test(String(path || '').trim());
}

function sanitizePathToken(token) {
  let value = String(token || '').trim();
  if (!value) return '';

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('`') && value.endsWith('`'))
  ) {
    value = value.slice(1, -1).trim();
  }

  value = value.replace(/^[([{]+/, '').replace(/[)\]}.,;:!?]+$/, '').trim();
  return value;
}

function extractImagePathCandidates(text) {
  const raw = String(text || '');
  if (!raw) return [];

  const out = [];
  const patterns = [
    /[`'"]([^`'"\n\r]+?\.(?:png|jpe?g|webp|gif|bmp))[`'"]/gi,
    /(?:^|\s)(\/[^\s"'`]+?\.(?:png|jpe?g|webp|gif|bmp))/gi,
    /(?:^|\s)(\.\.?\/[^\s"'`]+?\.(?:png|jpe?g|webp|gif|bmp))/gi,
    /(?:^|\s)(runs\/[^\s"'`]+?\.(?:png|jpe?g|webp|gif|bmp))/gi,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(raw)) !== null) {
      const candidate = sanitizePathToken(match[1]);
      if (!candidate) continue;
      out.push(candidate);
    }
  }

  return out;
}

function resolveExistingImagePath(rawPath, { cwd, artifactsDir } = {}) {
  let candidate = sanitizePathToken(rawPath);
  if (!candidate) return null;

  if (candidate.startsWith('file://')) {
    candidate = candidate.slice('file://'.length).trim();
  }
  if (!candidate) return null;

  const variants = new Set([
    resolve(candidate),
    cwd ? resolve(cwd, candidate) : null,
    artifactsDir ? resolve(artifactsDir, candidate) : null,
  ].filter(Boolean));

  for (const fullPath of variants) {
    if (!isImageFilePath(fullPath)) continue;
    if (!existsSync(fullPath)) continue;
    return fullPath;
  }

  return null;
}

function listEvidenceImages(artifactsDir, maxItems = AUTO_EVIDENCE_MAX_ITEMS) {
  try {
    const evidenceDir = resolve(artifactsDir, 'evidence');
    if (!existsSync(evidenceDir)) return [];

    return readdirSync(evidenceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(evidenceDir, entry.name))
      .filter((fullPath) => isImageFilePath(fullPath))
      .sort((a, b) => {
        let aMtime = 0;
        let bMtime = 0;
        try { aMtime = statSync(a).mtimeMs; } catch {}
        try { bMtime = statSync(b).mtimeMs; } catch {}
        return bMtime - aMtime;
      })
      .slice(0, maxItems);
  } catch {
    return [];
  }
}

async function sendFallbackEvidenceFromSummary(phone, {
  summary,
  cwd,
  artifactsDir,
  maxItems = AUTO_EVIDENCE_MAX_ITEMS,
  alreadySentPaths = [],
} = {}) {
  const seen = new Set(
    (Array.isArray(alreadySentPaths) ? alreadySentPaths : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .map((p) => resolve(p))
  );

  const resolvedPaths = [];

  for (const rawPath of extractImagePathCandidates(summary)) {
    const fullPath = resolveExistingImagePath(rawPath, { cwd, artifactsDir });
    if (!fullPath) continue;
    const normalized = resolve(fullPath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    resolvedPaths.push(normalized);
    if (resolvedPaths.length >= maxItems) break;
  }

  if (resolvedPaths.length < maxItems) {
    for (const fullPath of listEvidenceImages(artifactsDir, maxItems * 2)) {
      const normalized = resolve(fullPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      resolvedPaths.push(normalized);
      if (resolvedPaths.length >= maxItems) break;
    }
  }

  let sent = 0;
  for (const fullPath of resolvedPaths) {
    try {
      const ok = await sendEvidenceItem(phone, {
        path: fullPath,
        caption: 'Evidencia',
        fileName: basename(fullPath),
      });
      if (ok) sent++;
    } catch {}
  }

  return sent;
}

async function sendEvidenceItem(phone, item) {
  const path = item?.path;
  if (!path || !existsSync(path)) return false;

  const mime = String(item?.mimetype || inferMimeFromPath(path)).toLowerCase();
  const kind = inferEvidenceKind(path, mime);
  const base64 = readFileSync(path).toString('base64');
  const caption = item?.caption ? String(item.caption).slice(0, 500) : 'Evidencia';
  const fileName = safeFileName(item?.fileName || basename(path), `evidence-${Date.now()}`);

  if (kind === 'image') {
    await sendImage(phone, { base64, caption, fileName, mimetype: mime });
    return true;
  }
  if (kind === 'audio') {
    await sendAudio(phone, { base64, caption, fileName, mimetype: mime });
    return true;
  }

  await sendFile(phone, { base64, caption, fileName, mimetype: mime });
  return true;
}

function readLastNonEmptyLine(path, maxBytes = 32_768) {
  try {
    const buf = readFileSync(path);
    const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    const text = slice.toString('utf-8');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  } catch {
    return '';
  }
}

/** Reads stderr and last stdout line to check for quota/rate-limit messages (e.g. when not seen line-by-line). */
function getRunOutputForQuotaCheck(artifactsDir) {
  try {
    const stderrPath = resolve(artifactsDir, 'stderr.log');
    const stdoutPath = resolve(artifactsDir, 'stdout.jsonl');
    let text = '';
    if (existsSync(stderrPath)) {
      const buf = readFileSync(stderrPath);
      const slice = buf.length > 8192 ? buf.subarray(buf.length - 8192) : buf;
      text += slice.toString('utf-8');
    }
    const lastStdout = readLastNonEmptyLine(stdoutPath, 4096);
    if (lastStdout) text += '\n' + lastStdout;
    return text;
  } catch {
    return '';
  }
}

function extractLastJsonlEventSummary(line) {
  try {
    const obj = JSON.parse(line);
    if (obj?.type && obj?.text) return `${obj.type}: ${String(obj.text)}`;
    if (obj?.type) return `${obj.type}: ${JSON.stringify(obj)}`;
    return JSON.stringify(obj);
  } catch {
    return String(line || '');
  }
}

function resolveUserLogLevel(phone) {
  return normalizeUserLogLevel(taskStore.getUser(phone)?.log_level_override, 'silent');
}

function extractPromptSection(prompt, startMarker, endMarker = null) {
  const rawPrompt = String(prompt || '').trim();
  if (!rawPrompt || !rawPrompt.includes(startMarker)) return '';

  const afterStart = rawPrompt.slice(rawPrompt.indexOf(startMarker) + startMarker.length);
  if (!endMarker || !afterStart.includes(endMarker)) {
    return afterStart.trim();
  }

  return afterStart.slice(0, afterStart.indexOf(endMarker)).trim();
}

function stripLeadingModelDirective(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length > 0) {
    const line = String(lines[0] || '').trim();
    if (!line) {
      lines.shift();
      continue;
    }

    if (
      /^(?:\/model|--model)\s+.+$/i.test(line)
      || /^(?:model|modelo)\s*[:=]\s*.+$/i.test(line)
    ) {
      lines.shift();
      continue;
    }
    break;
  }

  return lines.join('\n').trim();
}

function buildExecutionBrief({ prompt, taskTitle }) {
  const rawPrompt = String(prompt || '').trim();
  let text =
    extractPromptSection(rawPrompt, '[PEDIDO ORIGINAL DO USUARIO]', '[PLANO DO ORQUESTRADOR]')
    || extractPromptSection(rawPrompt, '[PROMPT]')
    || rawPrompt;

  text = stripLeadingModelDirective(text).trim();
  if (!text) text = String(taskTitle || '').trim();
  if (!text) return null;

  return text;
}

function buildPeriodicTaskSummary(task, recentUpdates = []) {
  const startedAt = task.started_at ? new Date(task.started_at).getTime() : Date.now();
  const elapsed = formatElapsed((Date.now() - startedAt) / 1000);
  const lines = [`*${task.task_id}* [${task.runner_kind}] (${task.project_id}) ${elapsed}`];
  const activityLines = summarizeRecentRunActivity(recentUpdates);

  if (activityLines.length > 0) {
    for (const line of activityLines) {
      lines.push(`   ${line}`);
    }
    return lines.join('\n');
  }

  const update = humanizeTaskUpdate(task.last_update || '') || 'Em execução';
  lines.push(`   Status atual: ${update}.`);
  return lines.join('\n');
}

function getCompactStatusText(task, recentUpdates = []) {
  const activityLines = summarizeRecentRunActivity(recentUpdates);
  if (activityLines.length > 0) {
    return String(activityLines[activityLines.length - 1] || '').trim();
  }
  return (humanizeTaskUpdate(task.last_update || '') || 'Em execução').trim();
}

function buildCompactTaskSummary(task, recentUpdates = [], { includeTaskId = false } = {}) {
  const startedAt = task.started_at ? new Date(task.started_at).getTime() : Date.now();
  const elapsed = formatElapsed((Date.now() - startedAt) / 1000);
  const statusText = getCompactStatusText(task, recentUpdates);
  if (!statusText) return includeTaskId ? `*${task.task_id}* ${elapsed}` : elapsed;
  return includeTaskId ? `*${task.task_id}* ${statusText} ${elapsed}` : `${statusText} ${elapsed}`;
}

function nextSilentDotPhase(previousBaseText, nextBaseText, previousPhase = 0) {
  if (!nextBaseText) return 0;
  if (previousBaseText !== nextBaseText) return 0;
  return (Number(previousPhase) + 1) % 4;
}

function buildSilentStatusText(task, recentUpdates = [], state = {}, { includeTaskId = false } = {}) {
  const startedAt = task.started_at ? new Date(task.started_at).getTime() : Date.now();
  const elapsed = formatElapsed((Date.now() - startedAt) / 1000);
  const baseText = getCompactStatusText(task, recentUpdates).replace(/[.]+$/, '').trim() || 'Em execução';
  const phase = nextSilentDotPhase(state.lastBaseText || '', baseText, state.phase || 0);
  const dots = ['.', '..', '...', '..'][phase] || '.';
  const text = includeTaskId
    ? `*${task.task_id}* ${baseText}${dots} ${elapsed}`
    : `${baseText}${dots} ${elapsed}`;

  return {
    text,
    phase,
    baseText,
  };
}

function buildRunStartMessage({ task, run, prompt, logLevel }) {
  const executionBrief = buildExecutionBrief({ prompt, taskTitle: task.title });
  if (!executionBrief) {
    return isVerboseLogLevel(logLevel)
      ? `🚀 *Iniciando*:\n• Task: *${task.task_id}*\n• Projeto: *${task.project_id}*\n• Runner: *${run.runner_kind}*`
      : null;
  }

  if (!isVerboseLogLevel(logLevel)) {
    return `🚀 ${executionBrief}`;
  }

  return (
    `🚀 *Iniciando*:\n` +
    `• Task: *${task.task_id}*\n` +
    `• Projeto: *${task.project_id}*\n` +
    `• Runner: *${run.runner_kind}*\n` +
    `• Entendimento: ${executionBrief}`
  );
}

function buildRunOutcomeMessage({
  status,
  task,
  run,
  logLevel,
  summary,
  blockedReason,
  exitCode,
  model,
  runTokenTotals,
  taskTokenTotals,
  lastLog = '',
}) {
  if (isVerboseLogLevel(logLevel)) {
    if (status === 'cancelled') {
      return `🛑 *Cancelado* (${task.project_id})\nTask: *${task.task_id}*`;
    }

    if (status === 'blocked' && blockedReason === 'purchase_confirmation') {
      return (
        `⛔ *Confirmacao necessaria (compra)* (${task.project_id})\n` +
        `Task: *${task.task_id}*\n` +
        `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
        `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
        `Responda com *CONFIRMO COMPRA* ou envie */confirm* em ate 10 min para continuar.`
      );
    }

    if (status === 'blocked') {
      return (
        `⛔ *Bloqueado* (${task.project_id})\n` +
        `Task: *${task.task_id}*\n` +
        `Runner: *${run.runner_kind}*\n` +
        `${model ? `Model: *${model}*\n` : ''}` +
        `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
        `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
        `Motivo: *${blockedReason || 'unknown'}*`
      );
    }

    if (status === 'done') {
      return (
        `✅ *Concluido* (${task.project_id})\n` +
        `Task: *${task.task_id}*\n` +
        `Runner: *${run.runner_kind}*\n\n` +
        `${model ? `Model: *${model}*\n\n` : ''}` +
        `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
        `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n\n` +
        `${summary || '(sem resumo)'}`
      );
    }

    return (
      `❌ *Erro* (${task.project_id})\n` +
      `Task: *${task.task_id}*\n` +
      `Runner: *${run.runner_kind}*\n` +
      `${model ? `Model: *${model}*\n` : ''}` +
      `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
      `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
      `Exit: *${exitCode}*\n` +
      `${lastLog ? `Ultimo log: ${lastLog}\n` : ''}` +
      `Artefatos: ${run.artifacts_dir}`
    );
  }

  if (status === 'cancelled') {
    return '🛑 Execucao cancelada.';
  }

  if (status === 'blocked' && blockedReason === 'purchase_confirmation') {
    return '⛔ Confirmação necessária para continuar a compra. Responda *CONFIRMO COMPRA* ou envie */confirm* em até 10 min.';
  }

  if (status === 'blocked') {
    return `⛔ Execucao bloqueada: ${blockedReason || 'motivo desconhecido'}.`;
  }

  if (status === 'done') {
    return `✅ ${summary || 'Concluido.'}`;
  }

  return (
    `❌ Falha na execucao (exit ${exitCode}).\n` +
    `${lastLog ? `Ultimo log: ${lastLog}\n` : ''}` +
    `Artefatos: ${run.artifacts_dir}`
  );
}

function shouldSendLiveRunLogs(phone) {
  return config.reportRunLogsEnabled && !isDiscordActorId(phone);
}

async function trySendFailureScreenshot(phone, artifactsDir) {
  // Prefer runner evidence, fall back to desktop screenshot if runner didn't capture.
  try {
    const evidenceDir = resolve(artifactsDir, 'evidence');
    const candidates = [
      resolve(evidenceDir, 'final.png'),
      resolve(evidenceDir, 'step-0000-desktop.png'),
      resolve(evidenceDir, 'step-0000-chrome-opened.png'),
    ];

    let pick = candidates.find((p) => existsSync(p));
    if (!pick) return false;

    const base64 = readFileSync(pick).toString('base64');
    await sendImage(phone, { base64, caption: 'Print (erro)' });
    return true;
  } catch {
    return false;
  }
}

class Executor {
  constructor() {
    /** @type {Map<string, { child: any, taskId: string, runId: string, phone: string, startedAt: number, runnerKind: string }>} */
    this.processes = new Map();
    this.schedulerTimer = null;
    this.reportTimer = null;
    this.cleanupTimer = null;
    this.reportCursorByRun = new Map();
    this.silentStatusByRun = new Map();
    // Optional hook called after any run completes (used by longrun-executor.js)
    this.onRunComplete = null;
  }

  /**
   * Registers a callback to be fired after every run completion.
   * The hook receives: { phone, taskId, runId, runnerKind, status, summary, exitCode }
   * @param {function} fn
   */
  registerRunCompleteHook(fn) {
    this.onRunComplete = fn;
  }

  start() {
    taskStore.markOrphanedRunningRunsAsError();

    mkdirSync(config.runsDir, { recursive: true });

    this.schedulerTimer = setInterval(() => {
      this.tick().catch((err) => logger.error({ error: err?.message }, 'Executor tick failed'));
    }, 1000);
    this.schedulerTimer.unref();

    if (config.reportIntervalMs > 0) {
      this.reportTimer = setInterval(() => {
        this.sendPeriodicReports().catch((err) => logger.error({ error: err?.message }, 'Periodic reports failed'));
      }, config.reportIntervalMs);
      this.reportTimer.unref();
    }

    // Cleanup old artifacts every hour.
    this.cleanupTimer = setInterval(() => {
      this.cleanupArtifacts().catch((err) => logger.error({ error: err?.message }, 'Artifacts cleanup failed'));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stop() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    for (const p of this.processes.values()) {
      try { p.child.kill('SIGTERM'); } catch {}
      try { p.child.kill('SIGKILL'); } catch {}
    }
    this.processes.clear();
    this.silentStatusByRun.clear();
  }

  async enqueueTaskRun({ phone, task, prompt, runnerKind }) {
    const activeRun = taskStore.getActiveRunForTask(task.task_id);
    if (activeRun) {
      await sendMessage(
        phone,
        `⏳ A task *${task.task_id}* ja tem uma execucao ${activeRun.status === 'running' ? 'rodando' : 'na fila'}. ` +
        `Use /status para ver e /cancel ${task.task_id} para cancelar.`
      );
      return null;
    }

    const runner = getRunner(runnerKind);
    if (!runner) {
      await sendMessage(phone, `❌ Runner "${runnerKind}" nao suportado (ainda).`);
      return null;
    }

    const runId = makeId('run');
    const artifactsDir = resolve(config.runsDir, task.task_id, runId);
    mkdirSync(artifactsDir, { recursive: true });

    const runSpec = runner.build({ prompt, cwd: task.cwd, artifactsDir, config, task });
    const run = taskStore.createRunWithId({
      runId,
      taskId: task.task_id,
      runnerKind,
      prompt,
      commandJson: runSpec.commandJson || JSON.stringify({ command: runSpec.command, args: [] }),
      artifactsDir,
      status: 'queued',
    });

    taskStore.updateTask(task.task_id, {
      status: 'queued',
      last_update: 'Queued',
      last_error: null,
    });

    // Attempt to start immediately. startRun() will send the "Iniciando" message.
    await this.tick();

    const refreshed = taskStore.getRun(run.run_id);
    if (refreshed?.status === 'queued') {
      await sendMessage(
        phone,
        `🧩 *Run enfileirado*:\n` +
        `• Task: *${task.task_id}*\n` +
        `• Projeto: *${task.project_id}*\n` +
        `• Runner: *${runnerKind}*`
      );
    }
    return run;
  }

  async tick() {
    // Start queued runs while we have capacity.
    while (true) {
      const running = taskStore.countRunningRuns();
      if (running >= config.maxParallelTasks) return;

      const queued = taskStore.listQueuedRuns(1);
      if (queued.length === 0) return;

      const run = queued[0];
      await this.startRun(run);
    }
  }

  async startRun(run) {
    const task = taskStore.getTask(run.task_id);
    if (!task) {
      taskStore.updateRun(run.run_id, { status: 'error', ended_at: nowIso(), exit_code: -1, summary_text: 'Task not found' });
      return;
    }

    const runner = getRunner(run.runner_kind);
    if (!runner) {
      taskStore.updateRun(run.run_id, { status: 'error', ended_at: nowIso(), exit_code: -1, summary_text: 'Runner not supported' });
      taskStore.updateTask(task.task_id, { status: 'error', ended_at: nowIso(), last_error: 'Runner not supported' });
      return;
    }

    const runSpec = runner.build({ prompt: run.prompt, cwd: task.cwd, artifactsDir: run.artifacts_dir, config, task });

    taskStore.updateRun(run.run_id, {
      status: 'running',
      started_at: nowIso(),
      command: runSpec.commandJson || run.command,
    });

    taskStore.updateTask(task.task_id, {
      status: 'running',
      started_at: nowIso(),
      ended_at: null,
      last_update: 'Running',
      last_error: null,
      runner_kind: run.runner_kind,
    });
    try {
      taskStore.insertTaskAuditLog({
        taskId: task.task_id,
        runId: run.run_id,
        stage: 'executor',
        level: 'info',
        event: 'run_started',
        content: JSON.stringify({
          runnerKind: run.runner_kind,
          cwd: task.cwd,
          command: safeJsonParse(runSpec.commandJson) || runSpec.commandJson || null,
        }),
      });
    } catch {}

    const phone = task.phone;
    const logLevel = resolveUserLogLevel(phone);
    const runStartMessage = buildRunStartMessage({
      task,
      run,
      prompt: run.prompt,
      logLevel,
    });
    if (runStartMessage) {
      await sendMessage(phone, runStartMessage);
    }

    const state = {
      runId: run.run_id,
      model: null,
      sessionId: null,
      finalResult: null,
      assistantBuffer: '',
      usage: null,
    };

    const stdoutPath = resolve(run.artifacts_dir, 'stdout.jsonl');
    const stderrPath = resolve(run.artifacts_dir, 'stderr.log');
    const metaPath = resolve(run.artifacts_dir, 'meta.json');
    const summaryPath = resolve(run.artifacts_dir, 'summary.txt');
    const resultJsonPath = resolve(run.artifacts_dir, 'result.json');

    let lastUpdate = '';
    let lastUpdateAt = 0;
    let blockedReason = null;
    let finalised = false;
    const appendRunLog = (stream, content) => {
      try {
        taskStore.insertRunLog({
          runId: run.run_id,
          taskId: task.task_id,
          stream,
          content,
        });
      } catch (err) {
        logger.warn({ runId: run.run_id, stream, error: err?.message }, 'Failed to persist run log line');
      }
    };

    writeJson(metaPath, {
      runId: run.run_id,
      taskId: task.task_id,
      phone: task.phone,
      projectId: task.project_id,
      cwd: task.cwd,
      runnerKind: run.runner_kind,
      startedAt: run.started_at || nowIso(),
      command: safeJsonParse(runSpec.commandJson) || runSpec.commandJson || null,
    });
    appendRunLog('system', `run.start task=${task.task_id} runner=${run.runner_kind}`);

    const child = spawnStreamingProcess({
      command: runSpec.command,
      args: runSpec.args,
      cwd: task.cwd,
      env: process.env,
      stdoutPath,
      stderrPath,
      timeoutMs: config.taskTimeoutMs,
      onStdoutLine: (line) => {
        appendRunLog('stdout', line);
        const obj = safeJsonParse(line);
        if (!blockedReason && isQuotaLine(line)) blockedReason = 'quota';

        const parsed = runner.parseLine?.({ obj, rawLine: line, state }) || null;
        if (parsed?.blockedReason && !blockedReason) blockedReason = parsed.blockedReason;
        if (parsed?.usage) state.usage = mergeTokenUsage(state.usage, normalizeTokenUsage(parsed.usage, 'provider'));

        if (parsed?.model && !state.model) {
          state.model = parsed.model;
          taskStore.updateRun(run.run_id, { model: state.model });
          writeJson(metaPath, {
            ...safeJsonParse(readFileSync(metaPath, 'utf-8')) || {},
            model: state.model,
          });
        }

        if (parsed?.sessionId && !state.sessionId) {
          state.sessionId = parsed.sessionId;
          taskStore.updateRun(run.run_id, { session_id: state.sessionId });
          writeJson(metaPath, {
            ...safeJsonParse(readFileSync(metaPath, 'utf-8')) || {},
            sessionId: state.sessionId,
          });
        }

        if (parsed?.finalResult && !state.finalResult) {
          state.finalResult = parsed.finalResult;
        }

        if (parsed?.assistantDelta) {
          state.assistantBuffer += String(parsed.assistantDelta);
        }

        const update = humanizeTaskUpdate(parsed?.updateText || null);
        if (update) {
          appendRunLog('update', update);
          const now = Date.now();
          // Throttle DB writes.
          if (now - lastUpdateAt >= 1000 || update !== lastUpdate) {
            lastUpdateAt = now;
            lastUpdate = update;
            taskStore.updateTask(task.task_id, { last_update: update });
          }
        }
      },
      onStderrLine: (line) => {
        appendRunLog('stderr', line);
        if (!blockedReason && isQuotaLine(line)) blockedReason = 'quota';
        const stderrUpdate = summarizeStderrLine(line);
        if (!stderrUpdate) return;

        // Keep only meaningful stderr hints as status updates.
        const now = Date.now();
        if (now - lastUpdateAt < 1000) return;
        lastUpdateAt = now;
        taskStore.updateTask(task.task_id, { last_update: stderrUpdate });
      },
    });

    this.processes.set(run.run_id, {
      child,
      taskId: task.task_id,
      runId: run.run_id,
      phone,
      startedAt: Date.now(),
      runnerKind: run.runner_kind,
    });

    child.once('error', async (err) => {
      if (finalised) return;
      finalised = true;

      this.processes.delete(run.run_id);
      this.reportCursorByRun.delete(run.run_id);
      this.silentStatusByRun.delete(run.run_id);

      const endedAt = nowIso();
      const message = err?.message || 'spawn error';
      appendRunLog('system', `run.error ${message}`);
      try {
        taskStore.insertTaskAuditLog({
          taskId: task.task_id,
          runId: run.run_id,
          stage: 'executor',
          level: 'error',
          event: 'run_spawn_error',
          content: message,
        });
      } catch {}

      taskStore.updateRun(run.run_id, {
        status: 'error',
        ended_at: endedAt,
        exit_code: -1,
        summary_text: message,
      });

      taskStore.updateTask(task.task_id, {
        status: 'error',
        ended_at: endedAt,
        last_update: 'error',
        last_error: message,
      });

      await sendMessage(
        phone,
        `❌ *Erro ao iniciar* (${task.project_id})\n` +
        `Task: *${task.task_id}*\n` +
        `Runner: *${run.runner_kind}*\n` +
        `${message}`
      );
    });

    child.on('close', async (code, signal) => {
      if (finalised) return;
      finalised = true;

      this.processes.delete(run.run_id);
      this.reportCursorByRun.delete(run.run_id);
      this.silentStatusByRun.delete(run.run_id);

      const endedAt = nowIso();
      const exitCode = code == null ? -1 : code;

      const killed = signal === 'SIGTERM' || signal === 'SIGKILL';
      const status = killed ? 'cancelled'
        : blockedReason ? 'blocked'
        : exitCode === 0 ? 'done'
        : 'error';
      appendRunLog('system', `run.close status=${status} exit=${exitCode} blocked=${blockedReason || ''}`);

      const summary = await this.readSummaryForRun(run.runner_kind, runSpec, run.artifacts_dir, state);
      writeText(summaryPath, summary || '');
      try {
        taskStore.insertTaskAuditLog({
          taskId: task.task_id,
          runId: run.run_id,
          stage: 'executor',
          level: status === 'error' ? 'error' : status === 'blocked' ? 'warn' : 'info',
          event: 'run_closed',
          content: summary || '',
          metaJson: JSON.stringify({
            status,
            exitCode,
            signal,
            blockedReason,
            model: state.model || null,
            runnerKind: run.runner_kind,
          }),
        });
      } catch {}

      const providerUsage = normalizeTokenUsage(state.usage, 'provider');
      const runUsage = providerUsage || estimateUsage({
        inputText: String(run.prompt || ''),
        outputText: String(summary || state.assistantBuffer || ''),
      });
      if (!providerUsage) {
        logUsageFallbackEstimate({
          task_id: task.task_id,
          run_id: run.run_id,
          stage: 'runner',
          provider: run.runner_kind,
          model: state.model || null,
        });
      }

      taskStore.insertTokenUsageEvent({
        phone,
        taskId: task.task_id,
        runId: run.run_id,
        stage: 'runner',
        provider: run.runner_kind,
        model: state.model || null,
        inputTokens: runUsage.inputTokens,
        outputTokens: runUsage.outputTokens,
        totalTokens: runUsage.totalTokens,
        source: runUsage.source || 'estimated',
        budgetBefore: null,
        budgetAfter: null,
        compacted: false,
        metaJson: JSON.stringify({ runnerKind: run.runner_kind }),
      });

      const runTokenTotals = taskStore.sumTokensByRun(run.run_id);
      const taskTokenTotals = taskStore.sumTokensByTask(task.task_id);
      taskStore.updateRunTokenTotals(run.run_id, runTokenTotals);
      taskStore.updateTaskTokenTotals(task.task_id, taskTokenTotals);

      logTokenUsage({
        task_id: task.task_id,
        run_id: run.run_id,
        phone,
        provider: run.runner_kind,
        model: state.model || null,
        stage: 'runner',
        input_tokens: runUsage.inputTokens,
        output_tokens: runUsage.outputTokens,
        total_tokens: runUsage.totalTokens,
        source: runUsage.source || 'estimated',
      });

      writeJson(metaPath, {
        ...safeJsonParse(readFileSync(metaPath, 'utf-8')) || {},
        endedAt,
        exitCode,
        status,
        blockedReason,
      });

      taskStore.updateRun(run.run_id, {
        status,
        blocked_reason: blockedReason,
        ended_at: endedAt,
        exit_code: exitCode,
        summary_text: summary || null,
      });
      const appendAssistantHistory = (content, actionSummary = null) => {
        try {
          taskStore.insertChatHistory({
            phone,
            taskId: task.task_id,
            projectId: task.project_id,
            role: 'assistant',
            content,
            actionSummary,
          });
        } catch {}
      };

      // Quota fallback: retry immediately with codex-cli without failing the task or notifying LongRun.
      if (status === 'blocked' && blockedReason === 'quota' && run.runner_kind !== 'codex-cli') {
        logger.info(
          { taskId: task.task_id, runId: run.run_id, previousRunner: run.runner_kind },
          'Quota exceeded, retrying with codex-cli'
        );
        const currentTask = taskStore.getTask(task.task_id);
        if (currentTask) {
          try {
            taskStore.insertTaskAuditLog({
              taskId: task.task_id,
              runId: run.run_id,
              stage: 'executor',
              level: 'warn',
              event: 'quota_fallback_triggered',
              content: `runner=${run.runner_kind} -> codex-cli`,
            });
          } catch {}
          const quotaMsg =
            `🔄 *Limite de uso atingido* (${task.project_id})\n` +
            `Task: *${task.task_id}* | Runner anterior: *${run.runner_kind}*\n` +
            `Reexecutando com *codex-cli*...`;
          appendAssistantHistory(
            quotaMsg,
            JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, retry_runner: 'codex-cli' })
          );
          await sendMessage(phone, quotaMsg);
          await this.enqueueTaskRun({
            phone,
            task: currentTask,
            prompt: run.prompt,
            runnerKind: 'codex-cli',
          });
        }
        this.tick().catch((err) => logger.error({ error: err?.message }, 'tick after quota fallback failed'));
        return;
      }

      if (summary && summary.trim()) {
        // Task-scoped memory: persist the assistant output per run.
        taskStore.insertTaskMessage(task.task_id, 'assistant', summary.trim());
      }

      taskStore.updateTask(task.task_id, {
        status: status === 'done'
          ? 'done'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'blocked' && blockedReason === 'purchase_confirmation'
              ? 'waiting'
              : status === 'blocked'
                ? 'error'
                : 'error',
        ended_at: endedAt,
        last_update: status,
        last_error: status === 'error' ? `Exit ${exitCode}` : blockedReason ? `Blocked: ${blockedReason}` : null,
      });

      if (status === 'cancelled') {
        const cancelledMsg = buildRunOutcomeMessage({
          status,
          task,
          run,
          logLevel,
          summary,
          blockedReason,
          exitCode,
          model: state.model || null,
          runTokenTotals,
          taskTokenTotals,
        });
        appendAssistantHistory(
          cancelledMsg,
          JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, exit_code: exitCode })
        );
        await sendMessage(phone, cancelledMsg);
      } else if (status === 'blocked') {
        if (blockedReason === 'purchase_confirmation') {
          const result = safeReadJsonFile(resultJsonPath);
          const ev = Array.isArray(result?.evidence) ? result.evidence : [];
          const pick = ev.slice(-3);

          // Store a pending confirmation tied to this phone (single active confirmation at a time).
          const expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          const resumePrompt =
            `O usuario confirmou a compra. Continue de forma cuidadosa a partir do contexto abaixo.\n\n` +
            `Contexto (JSON):\n${JSON.stringify(result?.purchase_context || {}, null, 2)}\n\n` +
            `Instrucoes:\n- Prossiga apenas com a etapa de compra/checkout que estava pendente.\n- Tire screenshot apos concluir.\n- Responda com o resultado e evidencias.\n`;

          taskStore.setPendingConfirmation(phone, {
            kind: 'purchase_confirmation',
            taskId: task.task_id,
            runnerKind: run.runner_kind,
            resumePrompt,
            contextJson: JSON.stringify(result?.purchase_context || {}),
            expiresAtIso,
          });

          const blockedPurchaseMsg = buildRunOutcomeMessage({
            status,
            task,
            run,
            logLevel,
            summary,
            blockedReason,
            exitCode,
            model: state.model || null,
            runTokenTotals,
            taskTokenTotals,
          });
          appendAssistantHistory(
            blockedPurchaseMsg,
            JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, exit_code: exitCode })
          );
          await sendMessage(phone, blockedPurchaseMsg);

          for (const it of pick) {
            try {
              await sendEvidenceItem(phone, it);
            } catch {}
          }
        } else {
          const blockedMsg = buildRunOutcomeMessage({
            status,
            task,
            run,
            logLevel,
            summary,
            blockedReason,
            exitCode,
            model: state.model || null,
            runTokenTotals,
            taskTokenTotals,
          });
          appendAssistantHistory(
            blockedMsg,
            JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, exit_code: exitCode })
          );
          await sendMessage(phone, blockedMsg);
        }
      } else if (status === 'done') {
        const doneMsg = buildRunOutcomeMessage({
          status,
          task,
          run,
          logLevel,
          summary,
          blockedReason,
          exitCode,
          model: state.model || null,
          runTokenTotals,
          taskTokenTotals,
        });
        appendAssistantHistory(
          doneMsg,
          JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, exit_code: exitCode })
        );
        await sendMessage(phone, doneMsg);

        // Send evidence images if present.
        const result = safeReadJsonFile(resultJsonPath);
        const ev = Array.isArray(result?.evidence) ? result.evidence : [];
        const pick = ev.slice(-3);
        const sentEvidencePaths = [];
        let sentEvidenceCount = 0;
        for (const it of pick) {
          try {
            const ok = await sendEvidenceItem(phone, it);
            if (ok) {
              sentEvidenceCount++;
              if (it?.path) sentEvidencePaths.push(resolve(String(it.path)));
            }
          } catch {}
        }

        if (sentEvidenceCount === 0) {
          try {
            await sendFallbackEvidenceFromSummary(phone, {
              summary,
              cwd: task.cwd,
              artifactsDir: run.artifacts_dir,
              alreadySentPaths: sentEvidencePaths,
              maxItems: AUTO_EVIDENCE_MAX_ITEMS,
            });
          } catch {}
        }
      } else {
        // On errors, include the last log line and a screenshot if possible.
        const lastStdout = readLastNonEmptyLine(stdoutPath);
        const lastStderr = readLastNonEmptyLine(stderrPath);
        const lastLog = lastStdout ? extractLastJsonlEventSummary(lastStdout) : (lastStderr ? `stderr: ${lastStderr}` : '');

        const errorMsg = buildRunOutcomeMessage({
          status,
          task,
          run,
          logLevel,
          summary,
          blockedReason,
          exitCode,
          model: state.model || null,
          runTokenTotals,
          taskTokenTotals,
          lastLog,
        });
        appendAssistantHistory(
          errorMsg,
          JSON.stringify({ source: 'executor', status, blockedReason, runner_kind: run.runner_kind, exit_code: exitCode })
        );
        await sendMessage(phone, errorMsg);

        await trySendFailureScreenshot(phone, run.artifacts_dir);
      }

      // Execute next queued user message for this task (if any), after current run finishes.
      if (status === 'done' || status === 'error' || status === 'cancelled') {
        const nextQueued = taskStore.popNextExecutionItem(task.task_id);
        if (nextQueued?.content) {
          const latestTask = taskStore.getTask(task.task_id);
          if (latestTask && latestTask.phone === phone) {
            const queuedPrompt = String(nextQueued.content).trim();
            const sharedMemory = taskStore.getUserSharedMemory(phone)?.content || '';
            const projectMemory = taskStore.getProjectMemory(latestTask.project_id, phone)?.content || '';
            const prompt = buildPromptWithMemories({
              prompt: queuedPrompt,
              sharedMemory,
              projectMemory,
              projectId: latestTask.project_id,
            });

            await sendMessage(
              phone,
              `▶️ Retomando fila da task *${task.task_id}* (item ${nextQueued.id}).`
            );
            await this.enqueueTaskRun({
              phone,
              task: latestTask,
              prompt,
              runnerKind: latestTask.runner_kind || run.runner_kind,
            });
          }
        }
      }

      // Fire LongRun post-run hook if registered.
      if (this.onRunComplete) {
        try {
          await this.onRunComplete({
            phone,
            taskId: task.task_id,
            runId: run.run_id,
            runnerKind: run.runner_kind,
            status,
            summary,
            exitCode,
          });
        } catch (err) {
          logger.warn({ error: err?.message }, 'onRunComplete hook error');
        }
      }

      // Start next queued work if any.
      this.tick().catch((err) => logger.error({ error: err?.message }, 'tick after close failed'));
    });
  }

  async readSummaryForRun(runnerKind, runSpec, artifactsDir, state) {
    try {
      if (runnerKind === 'codex-cli' && runSpec.lastPath) {
        return readFileSync(runSpec.lastPath, 'utf-8').trim();
      }
      if (state?.finalResult) return String(state.finalResult).trim();
      if (state?.assistantBuffer) return String(state.assistantBuffer).trim();

      // Fallback: try common last.txt
      const lastTxt = resolve(artifactsDir, 'last.txt');
      return readFileSync(lastTxt, 'utf-8').trim();
    } catch {
      return '';
    }
  }

  async cancelTask(taskId) {
    const task = taskStore.getTask(taskId);
    if (!task) return { ok: false, reason: 'not_found' };

    const run = taskStore.getActiveRunForTask(taskId);
    if (!run) return { ok: false, reason: 'no_active_run' };

    if (run.status === 'queued') {
      taskStore.updateRun(run.run_id, { status: 'cancelled', ended_at: nowIso(), exit_code: -1, summary_text: 'Cancelled before start.' });
      taskStore.updateTask(taskId, { status: 'cancelled', ended_at: nowIso(), last_update: 'cancelled' });
      return { ok: true, cancelled: 'queued' };
    }

    const proc = this.processes.get(run.run_id);
    if (!proc) {
      // Process map lost; mark as error.
      taskStore.updateRun(run.run_id, { status: 'error', ended_at: nowIso(), exit_code: -1, summary_text: 'Process handle missing.' });
      taskStore.updateTask(taskId, { status: 'error', ended_at: nowIso(), last_error: 'Process handle missing.' });
      return { ok: false, reason: 'process_missing' };
    }

    try { proc.child.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { proc.child.kill('SIGKILL'); } catch {}
    }, 5000).unref();

    return { ok: true, cancelled: 'running' };
  }

  async sendPeriodicReports() {
    const runningTasks = taskStore.listRunningTasks();
    if (runningTasks.length === 0) return;

    const byPhone = new Map();
    for (const t of runningTasks) {
      if (!byPhone.has(t.phone)) byPhone.set(t.phone, []);
      byPhone.get(t.phone).push(t);
    }

    for (const [phone, tasks] of byPhone.entries()) {
      const logLevel = resolveUserLogLevel(phone);

      if (isSilentLogLevel(logLevel)) {
        for (const task of tasks) {
          const run = taskStore.getActiveRunForTask(task.task_id);
          if (!run) continue;
          const recentUpdates = taskStore
            .listRunLogsTailByRun(run.run_id, 80)
            .filter((row) => row.stream === 'update');
          await this.sendSilentPeriodicUpdate(phone, task, run, recentUpdates, { totalTasks: tasks.length });
        }

        if (shouldSendLiveRunLogs(phone)) {
          for (const task of tasks) {
            const run = taskStore.getActiveRunForTask(task.task_id);
            if (!run) continue;
            await this.sendLiveRunLogs(phone, task, run);
          }
        }
        continue;
      }

      if (!isVerboseLogLevel(logLevel)) {
        const lines = tasks.slice(0, 5).map((t) => {
          const run = taskStore.getActiveRunForTask(t.task_id);
          const recentUpdates = run
            ? taskStore
              .listRunLogsTailByRun(run.run_id, 80)
              .filter((row) => row.stream === 'update')
            : [];
          return buildCompactTaskSummary(t, recentUpdates, { includeTaskId: tasks.length > 1 });
        });

        await sendMessage(phone, lines.join('\n'));

        if (shouldSendLiveRunLogs(phone)) {
          for (const task of tasks) {
            const run = taskStore.getActiveRunForTask(task.task_id);
            if (!run) continue;
            await this.sendLiveRunLogs(phone, task, run);
          }
        }
        continue;
      }

      const lines = tasks.slice(0, 5).map((t, i) => {
        const run = taskStore.getActiveRunForTask(t.task_id);
        const recentUpdates = run
          ? taskStore
            .listRunLogsTailByRun(run.run_id, 80)
            .filter((row) => row.stream === 'update')
          : [];
        return `${i + 1}) ${buildPeriodicTaskSummary(t, recentUpdates)}`;
      });

      const header = tasks.length === 1
        ? '⏱️ *Atualização (1 task em execução):*'
        : `⏱️ *Atualização (${tasks.length} tasks em execução):*`;

      await sendMessage(
        phone,
        `${header}\n\n${lines.join('\n\n')}\n\nPara log detalhado, use */logs <taskId>* quando precisar.`
      );

      if (shouldSendLiveRunLogs(phone)) {
        for (const task of tasks) {
          const run = taskStore.getActiveRunForTask(task.task_id);
          if (!run) continue;
          await this.sendLiveRunLogs(phone, task, run);
        }
      }
    }
  }

  async sendSilentPeriodicUpdate(phone, task, run, recentUpdates, { totalTasks = 1 } = {}) {
    const previous = this.silentStatusByRun.get(run.run_id) || {
      messageId: null,
      lastBaseText: '',
      phase: 0,
      lastRenderedText: '',
      lastSentBaseText: '',
    };

    const next = buildSilentStatusText(task, recentUpdates, previous, { includeTaskId: totalTasks > 1 });

    if (isDiscordActorId(phone)) {
      const result = await upsertMessage(phone, next.text, { messageId: previous.messageId || null });
      this.silentStatusByRun.set(run.run_id, {
        messageId: result?.primaryMessageId || previous.messageId || null,
        lastBaseText: next.baseText,
        phase: next.phase,
        lastRenderedText: next.text,
        lastSentBaseText: next.baseText,
      });
      return;
    }

    if (previous.lastSentBaseText === next.baseText) {
      this.silentStatusByRun.set(run.run_id, {
        ...previous,
        lastBaseText: next.baseText,
        phase: next.phase,
        lastRenderedText: next.text,
      });
      return;
    }

    await sendMessage(phone, next.text);
    this.silentStatusByRun.set(run.run_id, {
      ...previous,
      lastBaseText: next.baseText,
      phase: next.phase,
      lastRenderedText: next.text,
      lastSentBaseText: next.baseText,
    });
  }

  async sendLiveRunLogs(phone, task, run) {
    const batchSize = 120;
    let cursor = Number(this.reportCursorByRun.get(run.run_id) || 0);
    let sentAny = false;

    while (true) {
      const rows = taskStore.listRunLogsByRun(run.run_id, { afterId: cursor, limit: batchSize });
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].id || cursor);
      this.reportCursorByRun.set(run.run_id, cursor);

      const rendered = rows.map((row) => `[${row.stream}] ${row.content}`).join('\n');
      await sendMessage(
        phone,
        `📜 *Logs da task ${task.task_id}* (${task.project_id})\n` +
        `Run: *${run.run_id}*\n` +
        `${rendered}`
      );
      sentAny = true;

      if (rows.length < batchSize) break;
    }

    if (!sentAny) {
      // Ensure next periodic call only sends truly new lines after this checkpoint.
      this.reportCursorByRun.set(run.run_id, cursor);
    }
  }

  async cleanupArtifacts() {
    // Conservative: only remove run folders older than retention threshold.
    const thresholdMs = Date.now() - config.artifactRetentionDays * 24 * 60 * 60 * 1000;
    const base = config.runsDir;

    let removed = 0;
    try {
      // Structure: runs/<taskId>/<runFolder>/
      const taskIds = safeReadDir(base);
      for (const taskId of taskIds) {
        const taskDir = resolve(base, taskId);
        const runDirs = safeReadDir(taskDir);
        for (const runDirName of runDirs) {
          const full = resolve(taskDir, runDirName);
          const st = safeStat(full);
          if (!st?.isDirectory()) continue;
          if (st.mtimeMs < thresholdMs) {
            rmSync(full, { recursive: true, force: true });
            removed += 1;
          }
        }
      }
    } catch (err) {
      logger.warn({ error: err?.message }, 'cleanupArtifacts scan failed');
    }

    if (removed > 0) logger.info({ removed, retentionDays: config.artifactRetentionDays }, 'Artifacts cleaned up');
  }
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export const executor = new Executor();
export default executor;
