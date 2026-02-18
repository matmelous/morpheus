import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { formatElapsed } from '../utils/time.js';
import { truncate } from '../utils/text.js';
import { makeId } from '../utils/ids.js';
import { spawnStreamingProcess } from '../utils/spawn.js';
import { getRunner } from '../runners/index.js';
import { taskStore } from './task-store.js';
import { sendImage, sendMessage } from './messenger.js';
import {
  estimateUsage,
  formatTokenSummaryLine,
  logTokenUsage,
  logUsageFallbackEstimate,
  mergeTokenUsage,
  normalizeTokenUsage,
} from './token-meter.js';

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
  return s.includes("You've hit your usage limit") || s.includes('usage limit');
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

function isLikelyPng(path) {
  return String(path || '').toLowerCase().endsWith('.png');
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

function extractLastJsonlEventSummary(line) {
  try {
    const obj = JSON.parse(line);
    if (obj?.type && obj?.text) return `${obj.type}: ${String(obj.text).slice(0, 500)}`;
    if (obj?.type) return `${obj.type}: ${JSON.stringify(obj).slice(0, 500)}`;
    return JSON.stringify(obj).slice(0, 500);
  } catch {
    return String(line || '').slice(0, 500);
  }
}

function buildExecutionBrief({ prompt, taskTitle }) {
  const marker = '[PROMPT]';
  const rawPrompt = String(prompt || '').trim();
  let text = rawPrompt;

  if (rawPrompt.includes(marker)) {
    text = rawPrompt.slice(rawPrompt.lastIndexOf(marker) + marker.length).trim();
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) text = String(taskTitle || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  return truncate(text, 220);
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

    const runSpec = runner.build({ prompt, cwd: task.cwd, artifactsDir, config });
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

    const runSpec = runner.build({ prompt: run.prompt, cwd: task.cwd, artifactsDir: run.artifacts_dir, config });

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

    const phone = task.phone;
    const executionBrief = buildExecutionBrief({ prompt: run.prompt, taskTitle: task.title });

    await sendMessage(
      phone,
      `🚀 *Iniciando*:\n` +
      `• Task: *${task.task_id}*\n` +
      `• Projeto: *${task.project_id}*\n` +
      `• Runner: *${run.runner_kind}*` +
      (executionBrief ? `\n• Entendimento: ${executionBrief}` : '')
    );

    const state = {
      runId: run.run_id,
      model: null,
      sessionId: null,
      finalResult: null,
      assistantBuffer: '',
      usage: null,
    };
    const maxAssistantBufferChars = 120_000;

    const stdoutPath = resolve(run.artifacts_dir, 'stdout.jsonl');
    const stderrPath = resolve(run.artifacts_dir, 'stderr.log');
    const metaPath = resolve(run.artifacts_dir, 'meta.json');
    const summaryPath = resolve(run.artifacts_dir, 'summary.txt');
    const resultJsonPath = resolve(run.artifacts_dir, 'result.json');

    let lastUpdate = '';
    let lastUpdateAt = 0;
    let blockedReason = null;
    let finalised = false;

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

    const child = spawnStreamingProcess({
      command: runSpec.command,
      args: runSpec.args,
      cwd: task.cwd,
      env: process.env,
      stdoutPath,
      stderrPath,
      timeoutMs: config.taskTimeoutMs,
      onStdoutLine: (line) => {
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
          if (state.assistantBuffer.length > maxAssistantBufferChars) {
            state.assistantBuffer = state.assistantBuffer.slice(-maxAssistantBufferChars);
          }
        }

        const update = parsed?.updateText || null;
        if (update) {
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
        if (!blockedReason && isQuotaLine(line)) blockedReason = 'quota';
        // Keep last stderr line as a hint (throttled).
        const now = Date.now();
        if (now - lastUpdateAt < 1000) return;
        lastUpdateAt = now;
        taskStore.updateTask(task.task_id, { last_update: `stderr: ${String(line).slice(0, 120)}` });
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

      const endedAt = nowIso();
      const message = err?.message || 'spawn error';

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
        `${truncate(message, 500)}`
      );
    });

    child.on('close', async (code, signal) => {
      if (finalised) return;
      finalised = true;

      this.processes.delete(run.run_id);

      const endedAt = nowIso();
      const exitCode = code == null ? -1 : code;

      const killed = signal === 'SIGTERM' || signal === 'SIGKILL';
      const status = killed ? 'cancelled'
        : blockedReason ? 'blocked'
        : exitCode === 0 ? 'done'
        : 'error';

      const summary = await this.readSummaryForRun(run.runner_kind, runSpec, run.artifacts_dir, state);
      writeText(summaryPath, summary || '');

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

      if (summary && summary.trim()) {
        // Task-scoped memory: persist the assistant output per run.
        const maxChars = 20000;
        taskStore.insertTaskMessage(task.task_id, 'assistant', summary.trim().slice(0, maxChars));
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
        await sendMessage(phone, `🛑 *Cancelado* (${task.project_id})\nTask: *${task.task_id}*`);
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

          await sendMessage(
            phone,
            `⛔ *Confirmacao necessaria (compra)* (${task.project_id})\n` +
            `Task: *${task.task_id}*\n` +
            `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
            `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
            `Responda com *CONFIRMO COMPRA* ou envie */confirm* em ate 10 min para continuar.`
          );

          for (const it of pick) {
            const path = it?.path;
            if (!path || !existsSync(path) || !isLikelyPng(path)) continue;
            try {
              const base64 = readFileSync(path).toString('base64');
              const caption = it?.caption ? String(it.caption).slice(0, 500) : 'Evidencia';
              await sendImage(phone, { base64, caption });
            } catch {}
          }
        } else {
          await sendMessage(
            phone,
            `⛔ *Bloqueado* (${task.project_id})\n` +
            `Task: *${task.task_id}*\n` +
            `Runner: *${run.runner_kind}*\n` +
            `${state.model ? `Model: *${state.model}*\n` : ''}` +
            `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
            `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
            `Motivo: *${blockedReason || 'unknown'}*`
          );
        }
      } else if (status === 'done') {
        await sendMessage(
          phone,
          `✅ *Concluido* (${task.project_id})\n` +
          `Task: *${task.task_id}*\n` +
          `Runner: *${run.runner_kind}*\n\n` +
          `${state.model ? `Model: *${state.model}*\n\n` : ''}` +
          `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
          `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n\n` +
          `${truncate(summary || '(sem resumo)', 3500)}`
        );

        // Send evidence images if present.
        const result = safeReadJsonFile(resultJsonPath);
        const ev = Array.isArray(result?.evidence) ? result.evidence : [];
        const pick = ev.slice(-3);
        for (const it of pick) {
          const path = it?.path;
          if (!path || !existsSync(path) || !isLikelyPng(path)) continue;
          try {
            const base64 = readFileSync(path).toString('base64');
            const caption = it?.caption ? String(it.caption).slice(0, 500) : 'Evidencia';
            await sendImage(phone, { base64, caption });
          } catch {}
        }
      } else {
        // On errors, include the last log line and a screenshot if possible.
        const lastStdout = readLastNonEmptyLine(stdoutPath);
        const lastStderr = readLastNonEmptyLine(stderrPath);
        const lastLog = lastStdout ? extractLastJsonlEventSummary(lastStdout) : (lastStderr ? `stderr: ${lastStderr}` : '');

        await sendMessage(
          phone,
          `❌ *Erro* (${task.project_id})\n` +
          `Task: *${task.task_id}*\n` +
          `Runner: *${run.runner_kind}*\n` +
          `${state.model ? `Model: *${state.model}*\n` : ''}` +
          `${formatTokenSummaryLine('Tokens run', runTokenTotals)}\n` +
          `Tokens task acumulado: ${Number(taskTokenTotals?.totalTokens || 0)}\n` +
          `Exit: *${exitCode}*\n` +
          `${lastLog ? `Ultimo log: ${truncate(lastLog, 800)}\n` : ''}` +
          `Artefatos: ${run.artifacts_dir}`
        );

        await trySendFailureScreenshot(phone, run.artifacts_dir);
      }

      // Execute next queued user message for this task (if any), after current run finishes.
      if (status === 'done' || status === 'error' || status === 'cancelled') {
        const nextQueued = taskStore.popNextExecutionItem(task.task_id);
        if (nextQueued?.content) {
          const latestTask = taskStore.getTask(task.task_id);
          if (latestTask && latestTask.phone === phone) {
            const mem = taskStore.getUserSharedMemory(phone)?.content || '';
            const queuedPrompt = String(nextQueued.content).trim();
            const prompt = mem && mem.trim()
              ? `[MEMORIA COMPARTILHADA]\n${mem.trim()}\n\n[PROMPT]\n${queuedPrompt}`
              : queuedPrompt;

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
      const lines = tasks.slice(0, 5).map((t, i) => {
        const startedAt = t.started_at ? new Date(t.started_at).getTime() : Date.now();
        const elapsed = formatElapsed((Date.now() - startedAt) / 1000);
        const upd = (t.last_update || '').toString().slice(0, 160);
        const totalTokens = Number(t.total_tokens || 0);
        return `${i + 1}) *${t.task_id}* [${t.runner_kind}] (${t.project_id}) ${elapsed}\n   ${upd || '...'}\n   tokens: ${totalTokens}`;
      });

      await sendMessage(
        phone,
        `⏱️ *Atualizacao (${tasks.length} task(s) rodando):*\n\n${lines.join('\n')}`
      );
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
