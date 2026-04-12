import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, normalize, isAbsolute, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { truncate } from '../utils/text.js';
import { humanizeTaskUpdate } from '../utils/run-updates.js';
import { projectManager } from './project-manager.js';
import { downloadMedia } from './whatsapp.js';
import { downloadDiscordAttachment } from './discord.js';
import { sendMessage } from './messenger.js';
import { taskStore } from './task-store.js';
import {
  getRunnerDefault,
  getOrchestratorProviderDefault,
  getTaskIdLength,
  getProjectTaskHistoryLimit,
  setSetting,
  SettingsKeys,
} from './settings.js';
import { executor } from './executor.js';
import { orchestrateTaskMessage } from './orchestrator.js';
import { formatTokenSummaryLine } from './token-meter.js';
import { extFromMime, safeFileName, buildCanonicalMediaMessage } from './media-utils.js';
import { transcribeAudioFile } from './transcription.js';
import { describeImage } from './vision.js';
import { isRunnerKindSupported, listSupportedRunnerKinds } from '../runners/index.js';
import {
  ensureLongrunDirs,
  getLongrunRoot,
  writePartialSpec,
  writeFinalSpec,
} from './longrun.js';
import {
  MIN_LONGRUN_DOC_LINES,
  formatLongrunDocumentationIssues,
  validateLongrunDocumentationSpec,
} from './longrun-doc-quality.js';
import { normalizeUserLogLevel, parseUserLogLevel, listUserLogLevels, isVerboseLogLevel } from './log-levels.js';
import { listSuggestedRunnerModels } from './runner-models.js';
import {
  startLongrunExecution,
  advanceLongrun,
  onLongrunTaskComplete,
  onLongrunTaskFailed,
  onLongrunValidationComplete,
  resolveRunnerForSession,
  LONGRUN_RUNNER_PRIORITY,
} from './longrun-executor.js';
import { buildPromptWithMemories } from './memory-context.js';

// Register LongRun post-run hook on the executor.
// This hook fires after every run completes and advances LongRun sessions automatically.
executor.registerRunCompleteHook(async ({ phone, taskId, status, summary, exitCode }) => {
  const session = taskStore.getLongrunSessionByTaskId(taskId);
  if (!session || session.status !== 'running') return;

  // Do not advance if the user has queued messages waiting — let them drain first via normal flow.
  const queuedItems = taskStore.listExecutionItems(taskId);
  if (queuedItems.length > 0) return;

  let spec;
  try {
    spec = JSON.parse(session.spec_json || 'null');
  } catch {
    logger.warn({ sessionId: session.id }, '[LongRun] Failed to parse spec_json in hook');
    return;
  }
  if (!spec) return;

  const task = taskStore.getTask(taskId);
  if (!task) return;

  const longrunRoot = getLongrunRoot(session.project_cwd, session.feature_uuid);
  const currentTaskUuid = session.current_task_uuid;

  if (!currentTaskUuid) return;

  // Validation run: current_task_uuid is prefixed with "validation:"
  if (currentTaskUuid.startsWith('validation:')) {
    const epicUuid = currentTaskUuid.slice('validation:'.length);
    let epic = null;
    outer: for (const wave of (spec.waves || [])) {
      for (const eg of (wave.epic_groups || [])) {
        for (const e of (eg.epics || [])) {
          if (e.uuid === epicUuid) { epic = e; break outer; }
        }
      }
    }
    if (!epic) {
      logger.warn({ sessionId: session.id, epicUuid }, '[LongRun] Epic not found in spec for validation');
      return;
    }
    await onLongrunValidationComplete({ phone, task, session, spec, longrunRoot, epic, runSummary: summary });
    return;
  }

  // Regular task run.
  if (status === 'done') {
    await onLongrunTaskComplete({ phone, task, session, spec, longrunRoot, completedTaskUuid: currentTaskUuid });
  } else if (status === 'blocked') {
    // Runner hit token limit — rotate to next runner in priority list.
    const freshSession = taskStore.getLongrunSession(session.id);
    let priority = LONGRUN_RUNNER_PRIORITY.slice();
    if (freshSession?.runner_priority) {
      try {
        const parsed = JSON.parse(freshSession.runner_priority);
        if (Array.isArray(parsed) && parsed.length > 0) priority = parsed;
      } catch {}
    }
    priority.shift(); // Remove the runner that hit the limit.
    if (priority.length === 0) {
      taskStore.updateLongrunSession(session.id, { status: 'failed' });
      await sendMessage(
        phone,
        `[LongRun] Todos os runners esgotaram os limites de tokens. LongRun parado.\n` +
        `Revise os documentos e reinicie manualmente.`
      );
      return;
    }
    taskStore.updateLongrunSession(session.id, { runner_priority: JSON.stringify(priority) });
    logger.info({ sessionId: session.id, nextRunner: priority[0] }, '[LongRun] runner rotated after block');
    await advanceLongrun({ phone, task, session: freshSession, spec, longrunRoot });
  } else if (status === 'error') {
    await onLongrunTaskFailed({ phone, session, errorMsg: `exit ${exitCode}`, taskUuid: currentTaskUuid });
  } else {
    // cancelled or other — pause the LongRun.
    taskStore.updateLongrunSession(session.id, { status: 'paused' });
    await sendMessage(
      phone,
      `[LongRun] Pausado (status=${status}).\nTask UUID: ${currentTaskUuid}\nEnvie */longrun-resume* para continuar.`
    );
  }
});

function listRunnerKindsText({ includeAuto = true } = {}) {
  return listSupportedRunnerKinds({ includeAuto }).join('|');
}

function extractPhone(jid) {
  if (!jid) return null;
  const left = String(jid).split('@')[0] || '';
  return left.split(':')[0] || null;
}

function isDiscordActor(actorId) {
  return String(actorId || '').startsWith('dc:');
}

function parseDiscordActor(actorId) {
  const raw = String(actorId || '').trim();
  if (!raw.startsWith('dc:')) return null;
  const rest = raw.slice(3);
  const p = rest.indexOf(':');
  if (p <= 0) return null;
  const guildId = rest.slice(0, p).trim();
  const channelId = rest.slice(p + 1).trim();
  if (!guildId || !channelId) return null;
  return { guildId, channelId };
}

function isWhatsAppAuthorized(actorId) {
  return config.allowedPhoneNumbers.includes(String(actorId || '').trim());
}

function isDiscordGuildAllowed(guildId) {
  return config.discord.allowedGuildIds.includes(String(guildId || '').trim());
}

function isDiscordAdmin(senderId) {
  return config.discord.adminUserIds.includes(String(senderId || '').trim());
}

function isAdmin(actorId, senderId = null) {
  if (isDiscordActor(actorId)) return isDiscordAdmin(senderId);
  return config.adminPhoneNumbers.includes(String(actorId || '').trim());
}

function shellSplit2(raw) {
  // Minimal parser for: <a> <b> <rest...>
  const s = String(raw || '').trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  if (parts.length < 2) return null;
  const a = parts[0];
  const b = parts[1];
  const rest = parts.slice(2).join(' ');
  return { a, b, rest };
}

function parseFlagArgs(rawText) {
  const tokens = String(rawText || '').trim().split(/\s+/).filter(Boolean);
  const out = { pos: [], flags: {} };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('--')) {
      out.pos.push(t);
      continue;
    }

    const key = t.slice(2);
    if (!key) continue;

    if (key === 'name') {
      // Consume the rest as the name (allows spaces).
      out.flags.name = tokens.slice(i + 1).join(' ');
      break;
    }

    const next = tokens[i + 1];
    if (!next || next.startsWith('--')) {
      out.flags[key] = true;
      continue;
    }
    out.flags[key] = next;
    i++;
  }

  return out;
}

function repoBasename(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const noQuery = s.split('?')[0];
  const last = noQuery.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const base = last.endsWith('.git') ? last.slice(0, -4) : last;
  return base || '';
}

function spawnPromise(command, args, opts) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf-8'); });
    child.on('error', (err) => rejectP(err));
    child.on('close', (code) => {
      if (code === 0) return resolveP({ code, stdout, stderr });
      const msg = `exit ${code}\n${stderr || stdout}`.trim();
      const e = new Error(msg);
      e.code = code;
      rejectP(e);
    });
  });
}

function resolveProjectPath(pathArg) {
  const devRoot = resolve(config.developmentRoot);
  const raw = String(pathArg || '').trim();
  if (!raw) throw new Error('Missing dir');

  if (isAbsolute(raw)) {
    const full = resolve(raw);
    return { devRoot: dirname(full), full, norm: full };
  }

  const norm = normalize(raw);
  if (norm === '..' || norm.startsWith(`..${sep}`)) throw new Error('Path traversal is not allowed');

  const full = resolve(devRoot, norm);
  return { devRoot, full, norm };
}

function parseTaskPrefix(text) {
  const m = String(text || '').match(/^([a-z0-9]{2}|task-[a-f0-9]{6,})\s*:\s*([\s\S]+)$/i);
  if (!m) return null;
  return { taskId: m[1], message: m[2].trim() };
}

function parseSelectionReply(text) {
  const t = String(text || '').trim();
  if (/^\d+$/.test(t)) return { index: parseInt(t, 10) };
  if (/^([a-z0-9]{2}|task-[a-f0-9]{6,})$/i.test(t)) return { taskId: t };
  return null;
}

function resolveTaskArgForPhone(phone, arg, { limit = 10, projectId = null } = {}) {
  const tasks = taskStore.listTasksByPhone(phone, { limit, projectId });
  const user = taskStore.getUser(phone);
  if (!arg) return { taskId: user?.focused_task_id || null, tasks, user };
  if (/^\d+$/.test(arg)) return { taskId: tasks[parseInt(arg, 10) - 1]?.task_id || null, tasks, user };
  return { taskId: arg, tasks, user };
}

function isExplicitTaskReferenceArg(arg) {
  const value = String(arg || '').trim();
  if (!value) return false;
  return /^\d+$/.test(value) || /^([a-z0-9]{2}|task-[a-f0-9]{6,})$/i.test(value);
}

function normalizeRunnerModel(value) {
  return String(value || '').trim();
}

function isRunnerModelClearValue(value) {
  const normalized = normalizeRunnerModel(value).toLowerCase();
  return normalized === 'clear'
    || normalized === 'off'
    || normalized === 'none'
    || normalized === 'default'
    || normalized === 'padrao';
}

function supportsTaskRunnerModel(runnerKind) {
  return String(runnerKind || '').trim().toLowerCase().startsWith('claude');
}

function resolveUserLogLevel(phone) {
  const user = taskStore.getUser(phone);
  return normalizeUserLogLevel(user?.log_level_override, 'silent');
}

function formatTaskRunnerLabel(task) {
  const runner = String(task?.runner_kind || '').trim() || 'unknown';
  const model = normalizeRunnerModel(task?.runner_model);
  return model && supportsTaskRunnerModel(runner) ? `${runner}/${model}` : runner;
}

function isPurchaseConfirmationText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t === '/confirm') return true;
  return t === 'confirmo compra' || t === 'confirmo a compra' || t === 'confirmo';
}

async function resumePendingConfirmation(phone, rawTextForAudit) {
  const pending = taskStore.getPendingConfirmation(phone);
  if (!pending) return { ok: false, reason: 'none' };

  const expiresAt = new Date(pending.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    taskStore.clearPendingConfirmation(phone);
    return { ok: false, reason: 'expired' };
  }

  const task = taskStore.getTask(pending.task_id);
  if (!task || task.phone !== phone) {
    taskStore.clearPendingConfirmation(phone);
    return { ok: false, reason: 'task_not_found' };
  }

  taskStore.insertTaskMessage(task.task_id, 'system', `User confirmed purchase: ${String(rawTextForAudit || '').slice(0, 200)}`);
  taskStore.clearPendingConfirmation(phone);

  await executor.enqueueTaskRun({
    phone,
    task,
    prompt: pending.resume_prompt,
    runnerKind: pending.runner_kind,
  });

  return { ok: true, taskId: task.task_id };
}

function resolveProjectForMemory(phone, explicitProjectId = null) {
  const requested = String(explicitProjectId || '').trim();
  if (requested) {
    const project = projectManager.getProject(requested);
    if (project) return project;
    return null;
  }

  const user = taskStore.getUser(phone);
  if (user?.focused_task_id) {
    const focused = taskStore.getTask(user.focused_task_id);
    if (focused && focused.phone === phone) {
      const p = projectManager.getProject(focused.project_id);
      if (p) return p;
    }
  }

  return resolveProjectForUser(phone);
}

function insertChatHistorySafe({ phone, taskId, projectId, role, content, actionSummary = null }) {
  try {
    taskStore.insertChatHistory({
      phone,
      taskId,
      projectId,
      role,
      content,
      actionSummary,
    });
  } catch {}
}

function summarizePlanAction(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const summary = {
    action: plan.action || null,
    runner_kind: plan.runner_kind || null,
    scope: plan.scope || null,
    provider: plan.provider || null,
    project_id: plan.project_id || null,
    memory_scope: plan.memory_scope || null,
  };
  return JSON.stringify(summary);
}

function appendTaskAuditLog(taskId, {
  runId = null,
  stage = 'system',
  level = 'info',
  event = 'event',
  content = '',
  meta = null,
} = {}) {
  try {
    taskStore.insertTaskAuditLog({
      taskId,
      runId,
      stage,
      level,
      event,
      content: String(content ?? ''),
      metaJson: meta == null ? null : JSON.stringify(meta),
    });
  } catch {}
}

function buildScopedExecutionPrompt({ plannerPrompt, userRequest }) {
  const basePrompt = String(plannerPrompt || '').trim();
  const request = String(userRequest || '').trim();

  return [
    '[CONTRATO DE EXECUCAO - OBRIGATORIO]',
    '1. Execute apenas o que o usuario pediu, sem adicionar escopo nao solicitado.',
    '2. Use as memorias recebidas como restricoes obrigatorias e contexto prioritario.',
    '3. Se faltar dado essencial, pare e explique claramente o que falta ao inves de inventar.',
    '4. Nao faca refatoracoes amplas, mudancas paralelas ou extras sem pedido explicito.',
    '5. Entregue validacoes objetivas do que foi executado.',
    '',
    '[PEDIDO ORIGINAL DO USUARIO]',
    request || '(pedido nao informado)',
    '',
    '[PLANO DO ORQUESTRADOR]',
    basePrompt || request || '(plano vazio)',
  ].join('\n');
}

async function handleCommand(phone, rawText, meta = {}) {
  const parts = rawText.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/help') {
    await sendMessage(
      phone,
      `🤖 *Morpheus*\n\n` +
      `Envie uma mensagem para criar/continuar tasks. Suporta multiplas tasks em paralelo.\n\n` +
      `*Comandos:*\n` +
      `/status [projectId] - Ver tasks recentes (opcional: filtrar por projeto)\n` +
      `/logs [taskId|numero] [linhas] - Ver logs completos da execucao da task\n` +
      `/audit [taskId|numero] [linhas] - Ver trilha interna do Morpheus (planner/executor/longrun)\n` +
      `/cancel [taskId|numero] - Cancelar run (fila ou rodando)\n` +
      `/new [texto] - Criar uma nova task (e opcionalmente iniciar)\n` +
      `/task [taskId|numero] - Definir foco da task\n` +
      `/queue [taskId|numero] - Ver fila de execucao da task\n` +
      `/queue-edit <taskId|numero> <itemId> <texto> - Editar item da fila\n` +
      `/queue-del <taskId|numero> <itemId|all> - Remover item da fila\n` +
      `/projects - Listar projetos\n` +
      `/project [id] - Ver/alterar projeto default (cria task nova)\n` +
      `/project-add <id> <cwd> [type] [name...] - (admin) Adicionar/atualizar projeto\n` +
      `/project-base - (admin) Mostrar DEVELOPMENT_ROOT\n` +
      `/project-scan - (admin) Adicionar pastas do DEVELOPMENT_ROOT como projetos\n` +
      `/project-mkdir <id> <dir> [--type t] [--name ...] - (admin) Criar pasta no DEVELOPMENT_ROOT + registrar\n` +
      `/project-clone <id> <gitUrl> [--dir d] [--depth 1] [--type t] [--name ...] - (admin) Clonar no DEVELOPMENT_ROOT + registrar\n` +
      `/project-rm <id> - (admin) Remover projeto\n` +
      `/runner [kind] - Ver/alterar runner (${listRunnerKindsText({ includeAuto: true })})\n` +
      `/model [taskId|numero] [modelo|clear] - Ver/alterar modelo da task atual para runners Claude\n` +
      `/loglevel [silent|normal|verbose] - Ver/alterar o nivel de logs no canal/conversa\n` +
      `/orchestrator [provider] - Ver/alterar planner (gemini-cli|openrouter|codex-cli|auto)\n\n` +
      `/task-policy [taskIdLen] [historyLimit] - Ver/alterar politica de tasks\n\n` +
      `/confirm - Confirmar uma compra pendente (quando solicitado)\n\n` +
      `/memory - Ver memoria compartilhada\n` +
      `/remember <texto> - Adicionar preferencia/definicao na memoria\n` +
      `/forget-memory - Limpar memoria compartilhada\n\n` +
      `/project-memory [projectId] - Ver memoria do projeto atual/ou informado\n` +
      `/remember-project <texto> - Adicionar anotacao na memoria do projeto atual\n` +
      `/forget-project-memory [projectId] - Limpar memoria do projeto atual/ou informado\n\n` +
      `/longrun-status - Ver status do LongRun ativo\n` +
      `/longrun-resume - Retomar um LongRun pausado\n\n` +
      `Dica: para escolher uma task explicitamente: \`ab: sua mensagem\`\n` +
      `Dica 2: voce pode falar em linguagem natural, ex.: "troca pro projeto argo", "usa runner claude nesta task".\n` +
      `Dica 3: diga "quero iniciar um longrun" para execucao automatica de features completas.`
    );
    return true;
  }

  if (cmd === '/memory') {
    const mem = taskStore.getUserSharedMemory(phone);
    const content = String(mem?.content || '').trim();
    await sendMessage(
      phone,
      `🧠 *Memoria compartilhada*\n` +
      `${content ? `\n${content}` : '\n(vazia)'}`
    );
    return true;
  }

  if (cmd === '/remember') {
    const text = rawText.replace(/^\/remember\b/i, '').trim();
    if (!text) {
      await sendMessage(phone, '❌ Use: /remember <texto>');
      return true;
    }
    taskStore.appendUserSharedMemory(phone, text);
    await sendMessage(phone, '✅ Salvo na memoria compartilhada.');
    return true;
  }

  if (cmd === '/forget-memory') {
    taskStore.clearUserSharedMemory(phone);
    await sendMessage(phone, '🗑️ Memoria compartilhada limpa.');
    return true;
  }

  if (cmd === '/project-memory') {
    const projectIdArg = String(parts[1] || '').trim();
    const project = resolveProjectForMemory(phone, projectIdArg || null);
    if (!project) {
      await sendMessage(phone, `❌ Projeto nao encontrado: "${projectIdArg}". Use /projects.`);
      return true;
    }
    const mem = taskStore.getProjectMemory(project.id, phone);
    const content = String(mem?.content || '').trim();
    await sendMessage(
      phone,
      `🧠 *Memoria do projeto (${project.id})*\n` +
      `${content ? `\n${content}` : '\n(vazia)'}`
    );
    return true;
  }

  if (cmd === '/remember-project') {
    const text = rawText.replace(/^\/remember-project\b/i, '').trim();
    if (!text) {
      await sendMessage(phone, '❌ Use: /remember-project <texto>');
      return true;
    }
    const project = resolveProjectForMemory(phone);
    if (!project) {
      await sendMessage(phone, '❌ Nao foi possivel resolver o projeto atual. Use /project <id>.');
      return true;
    }
    taskStore.appendProjectMemory(project.id, phone, text);
    await sendMessage(phone, `✅ Salvo na memoria do projeto *${project.id}*.`);
    return true;
  }

  if (cmd === '/forget-project-memory') {
    const projectIdArg = String(parts[1] || '').trim();
    const project = resolveProjectForMemory(phone, projectIdArg || null);
    if (!project) {
      await sendMessage(phone, `❌ Projeto nao encontrado: "${projectIdArg}". Use /projects.`);
      return true;
    }
    taskStore.clearProjectMemory(project.id, phone);
    await sendMessage(phone, `🗑️ Memoria do projeto *${project.id}* limpa.`);
    return true;
  }

  if (cmd === '/longrun-status') {
    const session = taskStore.getActiveLongrunSessionForPhone(phone);
    if (!session) {
      await sendMessage(phone, 'Nenhum LongRun ativo.');
      return true;
    }
    const { getLongrunRoot: _getLongrunRoot, readTasksList: _readTasksList, readValidationsList: _readValList } = await import('./longrun.js');
    const lRoot = _getLongrunRoot(session.project_cwd, session.feature_uuid);
    const tasks = _readTasksList(lRoot);
    const done = tasks.filter((t) => t.status === 'done').length;
    const vals = _readValList(lRoot);
    const validated = vals.filter((v) => v.status === 'validated').length;
    await sendMessage(
      phone,
      `[LongRun Status]\n` +
      `Feature: ${session.feature_title || '(sem titulo)'}\n` +
      `Feature UUID: ${session.feature_uuid}\n` +
      `Status: ${session.status}\n` +
      `Task atual: ${session.current_task_uuid || '(nenhuma)'}\n` +
      `Tasks: ${done}/${tasks.length} concluidas\n` +
      `Epics validados: ${validated}/${vals.length}\n` +
      `Auto-correct attempts: ${session.auto_correct_attempt}\n` +
      `Docs: ${lRoot}`
    );
    return true;
  }

  if (cmd === '/longrun-resume') {
    const session = taskStore.getActiveLongrunSessionForPhone(phone);
    if (!session) {
      await sendMessage(phone, '❌ Nenhum LongRun ativo.');
      return true;
    }
    if (session.status !== 'paused') {
      await sendMessage(phone, `❌ LongRun nao esta pausado (status: ${session.status}). Use */longrun-status*.`);
      return true;
    }

    let spec;
    try {
      spec = JSON.parse(session.spec_json || 'null');
    } catch {
      await sendMessage(phone, '❌ Spec LongRun corrompido. Nao e possivel retomar.');
      return true;
    }
    if (!spec) {
      await sendMessage(phone, '❌ Spec LongRun vazio. Nao e possivel retomar.');
      return true;
    }

    const user = taskStore.getUser(phone);
    const focusedTaskId = user?.focused_task_id || session.task_id;
    const task = taskStore.getTask(focusedTaskId) || taskStore.getTask(session.task_id);
    if (!task) {
      await sendMessage(phone, '❌ Task associada ao LongRun nao encontrada.');
      return true;
    }

    taskStore.updateLongrunSession(session.id, { status: 'running' });
    const { getLongrunRoot: _lr } = await import('./longrun.js');
    const longrunRoot = _lr(session.project_cwd, session.feature_uuid);

    await sendMessage(phone, '[LongRun] Retomando...');
    await advanceLongrun({ phone, task, session, spec, longrunRoot });
    return true;
  }

  if (cmd === '/confirm') {
    const resumed = await resumePendingConfirmation(phone, rawText);
    if (resumed.ok) {
      await sendMessage(phone, `✅ Confirmacao recebida. Continuando na task *${resumed.taskId}*...`);
    } else if (resumed.reason === 'expired') {
      await sendMessage(phone, '⌛ Confirmacao expirada. Envie novamente a acao desejada.');
    } else if (resumed.reason === 'none') {
      await sendMessage(phone, 'ℹ️ Nao ha nenhuma confirmacao pendente.');
    } else {
      await sendMessage(phone, '❌ Nao foi possivel retomar a confirmacao. Envie novamente a acao desejada.');
    }
    return true;
  }

  if (cmd === '/status') {
    const projectFilter = (parts[1] || '').trim() || null;
    const tasks = taskStore.listTasksByPhone(phone, { limit: 10, projectId: projectFilter });
    const user = taskStore.getUser(phone);

    if (tasks.length === 0) {
      if (projectFilter) {
        await sendMessage(phone, `📭 Nenhuma task para o projeto *${projectFilter}*.`);
      } else {
        await sendMessage(phone, '📭 Nenhuma task ainda. Envie uma mensagem para criar a primeira.');
      }
      return true;
    }

    const lines = tasks.map((t, i) => {
      const focus = user?.focused_task_id === t.task_id ? ' ← foco' : '';
      const upd = humanizeTaskUpdate(t.last_update || '') || 'Sem atualizacao ainda';
      const queued = taskStore.listExecutionItems(t.task_id).length;
      return `${i + 1}) *${t.task_id}* (${t.status}) [${formatTaskRunnerLabel(t)}] (${t.project_id})${focus}\n   ${upd || '...'}${queued ? ` | fila: ${queued}` : ''} `;
    });

    const head = projectFilter ? `📊 *Tasks recentes (${projectFilter}):*` : '📊 *Tasks recentes:*';
    await sendMessage(phone, `${head}\n\n${lines.join('\n')}\n\nUse /task 1 para focar, ou /cancel 1 para cancelar.`);
    return true;
  }

  if (cmd === '/logs') {
    const arg = parts[1];
    const linesArg = Number(parts[2] || 80);
    const { taskId } = resolveTaskArgForPhone(phone, arg, { limit: 10 });
    if (!taskId) {
      await sendMessage(phone, '❌ Informe um taskId (ou use /status e depois /logs 1).');
      return true;
    }

    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
      return true;
    }

    const run = taskStore.getActiveRunForTask(taskId) || taskStore.getLatestRunForTask(taskId);
    if (!run) {
      await sendMessage(phone, `📭 A task *${taskId}* ainda nao possui execucoes.`);
      return true;
    }

    const take = Number.isFinite(linesArg) ? Math.max(1, Math.min(500, Math.trunc(linesArg))) : 80;
    const rows = taskStore.listRunLogsTailByRun(run.run_id, take);
    if (rows.length === 0) {
      await sendMessage(
        phone,
        `📭 Sem logs registrados para *${taskId}* (run *${run.run_id}*).` +
        `\nStatus run: *${run.status}*`
      );
      return true;
    }

    const rendered = rows
      .map((row) => `${row.created_at} [${row.stream}] ${row.content}`)
      .join('\n');

    await sendMessage(
      phone,
      `📜 *Logs da task ${taskId}*\n` +
      `Run: *${run.run_id}* (${run.status})\n` +
      `Linhas exibidas: ${rows.length}\n\n` +
      `${rendered}`
    );
    return true;
  }

  if (cmd === '/audit') {
    const arg = parts[1];
    const linesArg = Number(parts[2] || 120);
    const { taskId } = resolveTaskArgForPhone(phone, arg, { limit: 10 });
    if (!taskId) {
      await sendMessage(phone, '❌ Informe um taskId (ou use /status e depois /audit 1).');
      return true;
    }

    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
      return true;
    }

    const take = Number.isFinite(linesArg) ? Math.max(1, Math.min(500, Math.trunc(linesArg))) : 120;
    const rows = taskStore.listTaskAuditLogTailByTask(taskId, take);
    if (rows.length === 0) {
      await sendMessage(phone, `📭 Sem trilha interna registrada para *${taskId}* ainda.`);
      return true;
    }

    const rendered = rows.map((row) => {
      const runPart = row.run_id ? ` run=${row.run_id}` : '';
      return `${row.created_at} [${row.stage}/${row.level}] ${row.event}${runPart}\n${row.content}`;
    }).join('\n');

    await sendMessage(
      phone,
      `🧠 *Audit Morpheus da task ${taskId}*\n` +
      `Linhas exibidas: ${rows.length}\n\n` +
      `${rendered}`
    );
    return true;
  }

  if (cmd === '/queue') {
    const arg = parts[1];
    const { taskId } = resolveTaskArgForPhone(phone, arg, { limit: 10 });
    if (!taskId) {
      await sendMessage(phone, '❌ Informe um taskId (ou use /status e depois /queue 1).');
      return true;
    }
    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
      return true;
    }
    const items = taskStore.listExecutionItems(taskId);
    if (items.length === 0) {
      await sendMessage(phone, `🧾 Fila vazia para *${taskId}*.`);
      return true;
    }
    const lines = items.map((it, i) => `${i + 1}) id=${it.id} - ${String(it.content || '').slice(0, 400)}`);
    await sendMessage(phone, `🧾 *Fila de execucao* (${taskId})\n\n${lines.join('\n')}`);
    return true;
  }

  if (cmd === '/queue-edit') {
    const taskArg = parts[1];
    const itemId = parseInt(parts[2] || '', 10);
    const nextText = rawText.replace(/^\/queue-edit\b/i, '').trim().split(/\s+/).slice(2).join(' ').trim();
    if (!taskArg || !Number.isFinite(itemId) || !nextText) {
      await sendMessage(phone, '❌ Use: /queue-edit <taskId|numero> <itemId> <texto>');
      return true;
    }
    const { taskId } = resolveTaskArgForPhone(phone, taskArg, { limit: 10 });
    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId || taskArg}*`);
      return true;
    }
    const ok = taskStore.updateExecutionItem(taskId, itemId, nextText);
    if (!ok) {
      await sendMessage(phone, `❌ Item da fila nao encontrado: *${itemId}*`);
      return true;
    }
    await sendMessage(phone, `✅ Item *${itemId}* atualizado na fila da task *${taskId}*.`);
    return true;
  }

  if (cmd === '/queue-del') {
    const taskArg = parts[1];
    const itemArg = (parts[2] || '').toLowerCase();
    if (!taskArg || !itemArg) {
      await sendMessage(phone, '❌ Use: /queue-del <taskId|numero> <itemId|all>');
      return true;
    }
    const { taskId } = resolveTaskArgForPhone(phone, taskArg, { limit: 10 });
    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId || taskArg}*`);
      return true;
    }
    if (itemArg === 'all') {
      const removed = taskStore.clearExecutionItems(taskId);
      await sendMessage(phone, `🗑️ Fila limpa para *${taskId}* (${removed} item(ns)).`);
      return true;
    }
    const itemId = parseInt(itemArg, 10);
    if (!Number.isFinite(itemId)) {
      await sendMessage(phone, '❌ itemId invalido. Use um numero ou "all".');
      return true;
    }
    const removed = taskStore.deleteExecutionItem(taskId, itemId);
    if (!removed) {
      await sendMessage(phone, `❌ Item da fila nao encontrado: *${itemId}*`);
      return true;
    }
    await sendMessage(phone, `🗑️ Item *${itemId}* removido da fila da task *${taskId}*.`);
    return true;
  }

  if (cmd === '/cancel') {
    const arg = parts[1];
    const tasks = taskStore.listTasksByPhone(phone, { limit: 10 });
    const user = taskStore.getUser(phone);

    let taskId = null;
    if (!arg) taskId = user?.focused_task_id || null;
    else if (/^\d+$/.test(arg)) taskId = tasks[parseInt(arg, 10) - 1]?.task_id || null;
    else taskId = arg;

    if (!taskId) {
      await sendMessage(phone, '❌ Informe um taskId (ou use /status e depois /cancel 1).');
      return true;
    }

    const result = await executor.cancelTask(taskId);
    if (result.ok) {
      await sendMessage(phone, `🛑 Cancelamento enviado para *${taskId}* (${result.cancelled}).`);
    } else if (result.reason === 'not_found') {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
    } else if (result.reason === 'no_active_run') {
      await sendMessage(phone, `ℹ️ Nenhum run ativo para *${taskId}*`);
    } else {
      await sendMessage(phone, `❌ Nao foi possivel cancelar *${taskId}* (${result.reason}).`);
    }
    return true;
  }

  if (cmd === '/new') {
    const prompt = rawText.replace(/^\/new\b/i, '').trim();
    const project = resolveProjectForUser(phone);
    const runnerKind = resolveRunnerForUser(phone);

    const title = prompt ? prompt.slice(0, 80) : 'Nova task';
    const task = taskStore.createTask({
      phone,
      projectId: project.id,
      cwd: project.cwd,
      runnerKind,
      title,
    });
    taskStore.setUserFocusedTask(phone, task.task_id);

    await sendMessage(
      phone,
      `🆕 *Nova task criada*\n` +
      `• Task: *${task.task_id}*\n` +
      `• Projeto: *${project.id}*\n` +
      `• Runner: *${formatTaskRunnerLabel(task)}*`
    );

    if (prompt) {
      // Use the same routing/orchestration logic as normal messages.
      await routeToTask(phone, task.task_id, prompt, meta);
    }

    return true;
  }

  if (cmd === '/task') {
    const arg = parts[1];
    const tasks = taskStore.listTasksByPhone(phone, { limit: 10 });
    const user = taskStore.getUser(phone);

    if (!arg) {
      if (user?.focused_task_id) {
        const focused = taskStore.getTask(user.focused_task_id);
        if (focused && focused.phone === phone) {
          await sendMessage(phone, `🎯 Foco atual: *${focused.task_id}* (${focused.project_id}, ${formatTaskRunnerLabel(focused)})`);
        } else {
          await sendMessage(phone, `🎯 Foco atual: *${user.focused_task_id}*`);
        }
      } else {
        await sendMessage(phone, '🎯 Nenhum foco definido. Use /status e depois /task 1.');
      }
      return true;
    }

    let taskId = null;
    if (/^\d+$/.test(arg)) taskId = tasks[parseInt(arg, 10) - 1]?.task_id || null;
    else taskId = arg;

    const task = taskStore.getTask(taskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
      return true;
    }

    taskStore.setUserFocusedTask(phone, task.task_id);
    await sendMessage(phone, `🎯 Foco atualizado: *${task.task_id}* (${task.project_id}, ${formatTaskRunnerLabel(task)})`);
    return true;
  }

  if (cmd === '/projects') {
    const projects = projectManager.listProjects();
    const user = taskStore.getUser(phone);
    const current = user?.default_project_id || config.defaultProjectId || '';

    const lines = projects.map((p) => {
      const mark = p.id === current ? ' ← default' : '';
      return `• *${p.id}* - ${p.name} (${p.type})${mark}`;
    });
    await sendMessage(phone, `📁 *Projetos:*\n\n${lines.join('\n')}\n\nUse /project <id> para mudar.`);
    return true;
  }

  if (cmd === '/channel-enable') {
    const parsed = parseDiscordActor(phone);
    if (!parsed) {
      await sendMessage(phone, '❌ Comando disponivel apenas no Discord.');
      return true;
    }
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu usuario nao esta em DISCORD_ADMIN_USER_IDS.');
      return true;
    }
    if (!isDiscordGuildAllowed(parsed.guildId)) {
      await sendMessage(phone, `⛔ Guild nao permitida: ${parsed.guildId}`);
      return true;
    }

    const projectId = String(parts[1] || '').trim();
    const runnerKind = String(parts[2] || '').trim().toLowerCase();

    if (projectId) {
      const p = projectManager.getProject(projectId);
      if (!p) {
        await sendMessage(phone, `❌ Projeto \"${projectId}\" nao encontrado. Use /projects.`);
        return true;
      }
      taskStore.setUserDefaultProject(phone, p.id);
    }

    if (runnerKind) {
      if (!isRunnerKindSupported(runnerKind, { includeAuto: true })) {
        await sendMessage(phone, `❌ Runner invalido. Use: ${listRunnerKindsText({ includeAuto: true })}`);
        return true;
      }
      taskStore.setUserRunnerOverride(phone, runnerKind);
    }

    taskStore.upsertDiscordChannel({
      channelId: parsed.channelId,
      guildId: parsed.guildId,
      createdBy: meta?.senderId || null,
      enabled: true,
    });

    const user = taskStore.getUser(phone);
    const focused = user?.focused_task_id ? taskStore.getTask(user.focused_task_id) : null;
    let task = focused && focused.phone === phone ? focused : null;
    if (!task) {
      const active = taskStore.listActiveTasksByPhone(phone);
      task = active[0] || null;
      if (!task) {
        const project = resolveProjectForUser(phone);
        const resolvedRunner = resolveRunnerForUser(phone);
        task = taskStore.createTask({
          phone,
          projectId: project.id,
          cwd: project.cwd,
          runnerKind: resolvedRunner,
          title: `Canal ${parsed.channelId}`,
        });
      }
      taskStore.setUserFocusedTask(phone, task.task_id);
    }

    await sendMessage(
      phone,
      `✅ Canal habilitado.\n` +
      `• Guild: *${parsed.guildId}*\n` +
      `• Channel: *${parsed.channelId}*\n` +
      `• Task fixa: *${task.task_id}*`
    );
    return true;
  }

  if (cmd === '/channel-disable') {
    const parsed = parseDiscordActor(phone);
    if (!parsed) {
      await sendMessage(phone, '❌ Comando disponivel apenas no Discord.');
      return true;
    }
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu usuario nao esta em DISCORD_ADMIN_USER_IDS.');
      return true;
    }

    const current = taskStore.getDiscordChannel(parsed.channelId);
    if (!current) {
      taskStore.upsertDiscordChannel({
        channelId: parsed.channelId,
        guildId: parsed.guildId,
        createdBy: meta?.senderId || null,
        enabled: false,
      });
    } else {
      taskStore.setDiscordChannelEnabled(parsed.channelId, false);
    }

    await sendMessage(phone, `🛑 Canal desabilitado: *${parsed.channelId}*`);
    return true;
  }

  if (cmd === '/channel-info') {
    const parsed = parseDiscordActor(phone);
    if (!parsed) {
      await sendMessage(phone, '❌ Comando disponivel apenas no Discord.');
      return true;
    }
    const row = taskStore.getDiscordChannel(parsed.channelId);
    const user = taskStore.getUser(phone);
    const focusedTaskId = user?.focused_task_id || '(nenhuma)';
    const effectiveProject = user?.default_project_id || config.defaultProjectId || projectManager.getDefaultProject().id;
    const effectiveRunner = user?.runner_override || getRunnerDefault();

    await sendMessage(
      phone,
      `ℹ️ *Canal Discord*\n` +
      `• Guild: *${parsed.guildId}*\n` +
      `• Channel: *${parsed.channelId}*\n` +
      `• Habilitado: *${row && Number(row.enabled) === 1 ? 'sim' : 'nao'}*\n` +
      `• Task foco: *${focusedTaskId}*\n` +
      `• Projeto default: *${effectiveProject}*\n` +
      `• Runner efetivo: *${effectiveRunner}*\n` +
      `• Logs: *${resolveUserLogLevel(phone)}*`
    );
    return true;
  }

  if (cmd === '/project-add') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }

    const tail = rawText.replace(/^\/project-add\b/i, '').trim();
    const parsed = shellSplit2(tail);
    if (!parsed) {
      await sendMessage(phone, '❌ Use: /project-add <id> <cwd> [type] [name...]');
      return true;
    }

    const { a: id, b: cwd, rest } = parsed;
    const restParts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const type = restParts[0] || null;
    const name = restParts.length > 1 ? restParts.slice(1).join(' ') : null;

    try {
      // Validate cwd exists and is a directory.
      const { statSync } = await import('node:fs');
      const st = statSync(cwd);
      if (!st.isDirectory()) {
        await sendMessage(phone, `❌ cwd nao e uma pasta: ${cwd}`);
        return true;
      }
      // No path restrictions; cwd is used as context but projects can live anywhere.

      const p = projectManager.upsertProject({ id, cwd, type, name });
      await sendMessage(phone, `✅ Projeto upserted: *${p.id}* (${p.type})\n${p.cwd}`);
      return true;
    } catch (err) {
      await sendMessage(phone, `❌ Falha ao adicionar projeto: ${truncate(err?.message || 'erro desconhecido', 500)}`);
      return true;
    }
  }

  if (cmd === '/project-rm') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }

    const projectId = parts[1];
    if (!projectId) {
      await sendMessage(phone, '❌ Use: /project-rm <id>');
      return true;
    }

    try {
      const removed = projectManager.removeProject(projectId);
      if (!removed) {
        await sendMessage(phone, `ℹ️ Projeto nao existia: *${projectId}*`);
        return true;
      }
      await sendMessage(phone, `🗑️ Projeto removido: *${projectId}*`);
      return true;
    } catch (err) {
      await sendMessage(phone, `❌ Falha ao remover projeto: ${truncate(err?.message || 'erro desconhecido', 500)}`);
      return true;
    }
  }

  if (cmd === '/project-base') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }
    await sendMessage(
      phone,
      `📌 DEVELOPMENT_ROOT:\n${config.developmentRoot}`
    );
    return true;
  }

  if (cmd === '/project-scan') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }

    try {
      const result = projectManager.scanDevelopmentRoot({ type: 'local' });
      await sendMessage(phone, `🔎 Scan concluido em DEVELOPMENT_ROOT.\nAdicionados: *${result.added}*`);
      return true;
    } catch (err) {
      await sendMessage(phone, `❌ Falha no scan: ${truncate(err?.message || 'erro desconhecido', 500)}`);
      return true;
    }
  }

  if (cmd === '/project-mkdir') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }

    const tail = rawText.replace(/^\/project-mkdir\b/i, '').trim();
    const { pos, flags } = parseFlagArgs(tail);
    const id = pos[0];
    const dir = pos[1];
    if (!id || !dir) {
      await sendMessage(phone, '❌ Use: /project-mkdir <id> <dir> [--type t] [--name ...]');
      return true;
    }

    try {
      const { full: cwd } = resolveProjectPath(dir);
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

      const p = projectManager.upsertProject({
        id,
        cwd,
        type: flags.type || 'local',
        name: flags.name || basename(cwd),
      });
      await sendMessage(phone, `✅ Projeto criado/registrado: *${p.id}* (${p.type})\n${p.cwd}`);
      return true;
    } catch (err) {
      await sendMessage(phone, `❌ Falha no mkdir: ${truncate(err?.message || 'erro desconhecido', 500)}`);
      return true;
    }
  }

  if (cmd === '/project-clone') {
    if (!isAdmin(phone, meta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return true;
    }

    const tail = rawText.replace(/^\/project-clone\b/i, '').trim();
    const { pos, flags } = parseFlagArgs(tail);
    const id = pos[0];
    const gitUrl = pos[1];
    if (!id || !gitUrl) {
      await sendMessage(phone, '❌ Use: /project-clone <id> <gitUrl> [--dir d] [--depth 1] [--type t] [--name ...]');
      return true;
    }

    const inferred = repoBasename(gitUrl);
    const dir = String(flags.dir || inferred || '').trim();
    if (!dir) {
      await sendMessage(phone, '❌ Nao consegui inferir --dir. Passe explicitamente: --dir <pasta>');
      return true;
    }

    const depth = flags.depth ? parseInt(String(flags.depth), 10) : 1;
    const type = flags.type || 'git';
    const name = flags.name || dir;

    try {
      const { devRoot, full: target } = resolveProjectPath(dir);
      if (existsSync(target)) {
        await sendMessage(phone, `❌ Pasta ja existe: ${target}`);
        return true;
      }

      await sendMessage(phone, `⬇️ Clonando...\n${gitUrl}\n→ ${target}`);

      const args = ['clone'];
      if (Number.isFinite(depth) && depth > 0) args.push('--depth', String(depth));
      args.push(gitUrl, target);

      const result = await spawnPromise('git', args, { cwd: devRoot, env: process.env });
      const p = projectManager.upsertProject({ id, cwd: target, type, name });

      await sendMessage(
        phone,
        `✅ Clone ok + projeto registrado: *${p.id}* (${p.type})\n${p.cwd}\n\n` +
        `git: ${truncate((result.stderr || result.stdout || 'ok').trim(), 800)}`
      );
      return true;
    } catch (err) {
      await sendMessage(phone, `❌ Falha no clone: ${truncate(err?.message || 'erro desconhecido', 1200)}`);
      return true;
    }
  }

  if (cmd === '/project') {
    const projectId = parts[1];
    if (!projectId) {
      const user = taskStore.getUser(phone);
      const effective = user?.default_project_id || config.defaultProjectId || projectManager.getDefaultProject().id;
      const p = projectManager.getProject(effective) || projectManager.getDefaultProject();
      await sendMessage(phone, `📁 Projeto default: *${p.id}* (${p.type})\n${p.cwd}`);
      return true;
    }

    const p = projectManager.getProject(projectId);
    if (!p) {
      await sendMessage(phone, `❌ Projeto "${projectId}" nao encontrado. Use /projects.`);
      return true;
    }

    taskStore.setUserDefaultProject(phone, p.id);

    // Create a fresh task in the new project and focus it (avoid mixing contexts).
    const runnerKind = resolveRunnerForUser(phone);
    const task = taskStore.createTask({
      phone,
      projectId: p.id,
      cwd: p.cwd,
      runnerKind,
      title: `Projeto ${p.id}`,
    });
    taskStore.setUserFocusedTask(phone, task.task_id);

    await sendMessage(phone, `✅ Projeto default alterado para *${p.id}*.\nNova task: *${task.task_id}*`);
    return true;
  }

  if (cmd === '/runner') {
    const kind = (parts[1] || '').toLowerCase();
    const allowedText = listRunnerKindsText({ includeAuto: true });

    if (!kind) {
      const user = taskStore.getUser(phone);
      const globalDefault = getRunnerDefault();
      const effective = user?.runner_override || globalDefault;
      await sendMessage(
        phone,
        `🏃 Runner:\n` +
        `• Global default: *${globalDefault}*\n` +
        `• Seu override: *${user?.runner_override || '(nenhum)'}*\n` +
        `• Efetivo: *${effective}*\n` +
        `• Disponiveis: *${allowedText}*\n\n` +
        `Use /runner <kind> para mudar.`
      );
      return true;
    }

    if (kind === 'global') {
      if (!isAdmin(phone, meta?.senderId)) {
        await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
        return true;
      }
      const v = (parts[2] || '').toLowerCase();
      if (!isRunnerKindSupported(v, { includeAuto: true })) {
        await sendMessage(phone, `❌ Use: /runner global ${allowedText}`);
        return true;
      }
      setSetting(SettingsKeys.runnerDefault, v);
      await sendMessage(phone, `✅ Runner global atualizado: *${v}*`);
      return true;
    }

    if (!isRunnerKindSupported(kind, { includeAuto: true })) {
      await sendMessage(phone, `❌ Use: /runner ${allowedText}`);
      return true;
    }

    taskStore.setUserRunnerOverride(phone, kind);
    const linkedTaskId = applyRunnerOverrideToCurrentTask(phone, kind);
    await sendMessage(
      phone,
      linkedTaskId
        ? `✅ Runner atualizado: *${kind}* (task *${linkedTaskId}* tambem atualizada).`
        : `✅ Runner atualizado: *${kind}*.`
    );
    return true;
  }

  if (cmd === '/model') {
    const tail = rawText.replace(/^\/model\b/i, '').trim();
    const rawArgs = tail ? tail.split(/\s+/).filter(Boolean) : [];

    let targetTaskId = null;
    let modelValue = '';

    if (rawArgs.length > 0 && isExplicitTaskReferenceArg(rawArgs[0])) {
      const resolved = resolveTaskArgForPhone(phone, rawArgs[0], { limit: 10 });
      const candidate = resolved.taskId ? taskStore.getTask(resolved.taskId) : null;
      if (candidate && candidate.phone === phone) {
        targetTaskId = candidate.task_id;
        modelValue = rawArgs.slice(1).join(' ').trim();
      }
    }

    if (!targetTaskId) {
      const resolved = resolveTaskArgForPhone(phone, null, { limit: 10 });
      targetTaskId = resolved.taskId || null;
      modelValue = tail;
    }

    if (!targetTaskId) {
      await sendMessage(phone, '❌ Nenhuma task em foco. Use /task <id|numero> antes de definir o modelo.');
      return true;
    }

    const task = taskStore.getTask(targetTaskId);
    if (!task || task.phone !== phone) {
      await sendMessage(phone, `❌ Task nao encontrada: *${targetTaskId}*`);
      return true;
    }

    if (!modelValue) {
      const currentModel = normalizeRunnerModel(task.runner_model);
      const availableModels = listSuggestedRunnerModels(task.runner_kind, { taskModel: currentModel });
      const supportHint = supportsTaskRunnerModel(task.runner_kind)
        ? 'Este runner Claude vai usar essa configuracao como padrao da task.'
        : 'Essa configuracao so e usada por runners Claude.';
      await sendMessage(
        phone,
        `🧩 *Modelo da task ${task.task_id}*\n` +
        `• Projeto: *${task.project_id}*\n` +
        `• Runner: *${task.runner_kind}*\n` +
        `• Modelo salvo: *${currentModel || '(padrao do runner)'}*` +
        (availableModels.length > 0 ? `\n• Sugestoes: *${availableModels.join(', ')}*` : '') +
        `\n\n` +
        `${supportHint}\n` +
        `Use /model ${task.task_id} <modelo> para definir ou /model ${task.task_id} clear para limpar.`
      );
      return true;
    }

    if (isRunnerModelClearValue(modelValue)) {
      taskStore.updateTask(task.task_id, { runner_model: null });
      await sendMessage(
        phone,
        `✅ Modelo da task *${task.task_id}* limpo.\n` +
        `Runner: *${task.runner_kind}*\n` +
        `Agora ela volta a usar o padrao do runner.`
      );
      return true;
    }

    const normalizedModel = normalizeRunnerModel(modelValue);
    if (!normalizedModel) {
      await sendMessage(phone, '❌ Use: /model [taskId|numero] <modelo|clear>');
      return true;
    }

    taskStore.updateTask(task.task_id, { runner_model: normalizedModel });
    const supportHint = supportsTaskRunnerModel(task.runner_kind)
      ? 'Esse modelo sera usado como padrao nesta task.'
      : 'Modelo salvo na task. Ele passa a valer quando essa task usar um runner Claude.';
    await sendMessage(
      phone,
      `✅ Modelo da task *${task.task_id}* atualizado para *${normalizedModel}*.\n` +
      `Runner atual: *${task.runner_kind}*\n` +
      `${supportHint}`
    );
    return true;
  }

  if (cmd === '/loglevel') {
    const rawLevel = String(parts[1] || '').trim();
    const current = resolveUserLogLevel(phone);
    const allowed = listUserLogLevels().join('|');

    if (!rawLevel) {
      await sendMessage(
        phone,
        `🪵 Nivel de logs atual: *${current}*.\n` +
        `Use /loglevel <${allowed}> para alterar.`
      );
      return true;
    }

    const next = parseUserLogLevel(rawLevel);
    if (!next) {
      await sendMessage(phone, `❌ Use: /loglevel <${allowed}>`);
      return true;
    }

    taskStore.setUserLogLevel(phone, next);
    await sendMessage(phone, `✅ Nivel de logs atualizado para *${next}*.`);
    return true;
  }

  if (cmd === '/orchestrator') {
    const provider = (parts[1] || '').toLowerCase();
    const allowed = new Set(['gemini-cli', 'openrouter', 'codex-cli', 'auto']);

    if (!provider) {
      const user = taskStore.getUser(phone);
      const globalDefault = getOrchestratorProviderDefault();
      const effective = user?.orchestrator_provider_override || globalDefault;
      await sendMessage(
        phone,
        `🧠 Orchestrator (planner):\n` +
        `• Global default: *${globalDefault}*\n` +
        `• Seu override: *${user?.orchestrator_provider_override || '(nenhum)'}*\n` +
        `• Efetivo: *${effective}*\n\n` +
        `Use /orchestrator <provider> para mudar.`
      );
      return true;
    }

    if (provider === 'global') {
      if (!isAdmin(phone, meta?.senderId)) {
        await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
        return true;
      }
      const v = (parts[2] || '').toLowerCase();
      if (!allowed.has(v)) {
        await sendMessage(phone, '❌ Use: /orchestrator global gemini-cli|openrouter|codex-cli|auto');
        return true;
      }
      setSetting(SettingsKeys.orchestratorProviderDefault, v);
      await sendMessage(phone, `✅ Orchestrator global atualizado: *${v}*`);
      return true;
    }

    if (!allowed.has(provider)) {
      await sendMessage(phone, '❌ Use: /orchestrator gemini-cli|openrouter|codex-cli|auto');
      return true;
    }

    taskStore.setUserOrchestratorOverride(phone, provider);
    await sendMessage(phone, `✅ Orchestrator atualizado: *${provider}*`);
    return true;
  }

  if (cmd === '/task-policy') {
    const rawLen = parts[1];
    const rawHistory = parts[2];
    if (!rawLen && !rawHistory) {
      await sendMessage(
        phone,
        `🧩 Politica de tasks:\n` +
        `• task_id_length: *${getTaskIdLength()}*\n` +
        `• project_task_history_limit: *${getProjectTaskHistoryLimit()}*\n\n` +
        `Use /task-policy <taskIdLen> <historyLimit> para alterar.`
      );
      return true;
    }

    const len = Number.parseInt(String(rawLen || ''), 10);
    const history = Number.parseInt(String(rawHistory || ''), 10);
    if (!Number.isFinite(len) || len < 1 || len > 8 || !Number.isFinite(history) || history < 1 || history > 500) {
      await sendMessage(phone, '❌ Use: /task-policy <taskIdLen 1..8> <historyLimit 1..500>');
      return true;
    }

    setSetting(SettingsKeys.taskIdLength, String(len));
    setSetting(SettingsKeys.projectTaskHistoryLimit, String(history));
    await sendMessage(phone, `✅ Politica atualizada: task_id_length=*${len}*, project_task_history_limit=*${history}*`);
    return true;
  }

  return false;
}

function resolveProjectForUser(phone) {
  const user = taskStore.getUser(phone);
  const projectId = user?.default_project_id || config.defaultProjectId;
  if (projectId) {
    const p = projectManager.getProject(projectId);
    if (p) return p;
  }
  return projectManager.getDefaultProject();
}

function resolveRunnerForUser(phone) {
  const user = taskStore.getUser(phone);
  const globalDefault = (getRunnerDefault() || config.runnerDefault || 'codex-cli').toLowerCase();
  const effective = (user?.runner_override || globalDefault || 'codex-cli').toLowerCase();
  if (effective === 'auto') return 'codex-cli';
  if (isRunnerKindSupported(effective)) return effective;
  return 'codex-cli';
}

function applyRunnerOverrideToCurrentTask(phone, kind) {
  const normalizedKind = String(kind || '').toLowerCase();
  if (!normalizedKind) return null;

  const user = taskStore.getUser(phone);
  if (user?.focused_task_id) {
    const focused = taskStore.getTask(user.focused_task_id);
    if (focused && focused.phone === phone) {
      taskStore.updateTask(focused.task_id, { runner_kind: normalizedKind });
      return focused.task_id;
    }
  }

  const active = taskStore.listActiveTasksByPhone(phone);
  if (active.length === 1) {
    const only = active[0];
    if (only && only.phone === phone) {
      taskStore.updateTask(only.task_id, { runner_kind: normalizedKind });
      taskStore.setUserFocusedTask(phone, only.task_id);
      return only.task_id;
    }
  }

  return null;
}

function resolveTaskForInboundMedia(phone) {
  // Similar to default routing, but for media we avoid the selection prompt.
  const user = taskStore.getUser(phone);
  const active = taskStore.listActiveTasksByPhone(phone);

  if (user?.focused_task_id) {
    const focused = taskStore.getTask(user.focused_task_id);
    if (focused && focused.phone === phone) return focused;
  }

  if (active.length === 1) {
    taskStore.setUserFocusedTask(phone, active[0].task_id);
    return active[0];
  }

  if (active.length > 1) {
    // Pick the most recent active task to keep flow moving.
    taskStore.setUserFocusedTask(phone, active[0].task_id);
    taskStore.insertTaskMessage(active[0].task_id, 'system', `Inbound media routed to most recent active task (had ${active.length} active).`);
    return active[0];
  }

  const project = resolveProjectForUser(phone);
  const runnerKind = resolveRunnerForUser(phone);
  const task = taskStore.createTask({
    phone,
    projectId: project.id,
    cwd: project.cwd,
    runnerKind,
    title: 'Midia recebida',
  });
  taskStore.setUserFocusedTask(phone, task.task_id);
  return task;
}

function normalizeInboundMediaType(value) {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'image') return 'image';
  if (t === 'audio' || t === 'voice') return 'audio';
  return 'file';
}

function buildStoredFileName(fileName, mimetype) {
  const safeName = safeFileName(fileName, 'original');
  const ext = extFromMime(mimetype);
  if (!ext || ext === 'bin') return safeName;
  const lowerName = safeName.toLowerCase();
  const suffix = `.${ext.toLowerCase()}`;
  if (lowerName.endsWith(suffix)) return safeName;
  return `${safeName}${suffix}`;
}

async function processInboundDownloadedMedia({
  phone,
  task,
  instanceId,
  messageId,
  mediaType,
  caption,
  downloaded,
  source = 'unknown',
}) {
  const inboxDir = resolve(config.runsDir, task.task_id, 'inbox', String(messageId || `msg-${Date.now()}`));
  mkdirSync(inboxDir, { recursive: true });

  const size = Number(downloaded.size || 0);
  if (Number.isFinite(size) && size > config.media.maxBytes) {
    throw new Error(`Media too large: ${size} bytes (max ${config.media.maxBytes})`);
  }

  const mimetype = downloaded.mimetype || null;
  const storedName = buildStoredFileName(downloaded.fileName, mimetype);
  const originalPath = resolve(inboxDir, storedName);
  const metaPath = resolve(inboxDir, 'meta.json');
  const derivedPath = resolve(inboxDir, 'derived.json');

  const buf = Buffer.from(downloaded.base64 || '', 'base64');
  writeFileSync(originalPath, buf);
  writeFileSync(metaPath, JSON.stringify({
    instanceId,
    messageId,
    mediaType,
    mimetype,
    fileName: storedName,
    size: buf.length,
    caption: caption || null,
    source,
    savedAt: new Date().toISOString(),
    path: originalPath,
  }, null, 2) + '\n', 'utf-8');

  let transcriptText = '';
  let visionText = '';

  if (mediaType === 'audio' || mediaType === 'voice') {
    const ext = extFromMime(mimetype);
    const r = await transcribeAudioFile({
      filePath: originalPath,
      mimetype: mimetype || 'application/octet-stream',
      fileName: storedName || `audio.${ext || 'bin'}`,
    });
    transcriptText = r.text || '';
    writeFileSync(derivedPath, JSON.stringify({ kind: 'audio', transcript: transcriptText, raw: r.raw || null }, null, 2) + '\n', 'utf-8');
  } else if (mediaType === 'image') {
    // Prefer dataUrl; if missing, build it from mimetype/base64.
    const dataUrl = downloaded.dataUrl || (mimetype ? `data:${mimetype};base64,${downloaded.base64}` : null);
    if (dataUrl) {
      const r = await describeImage({
        dataUrl,
        promptText: caption ? `Legenda: ${caption}\nDescreva a imagem e extraia informacoes importantes.` : undefined,
      });
      visionText = r.text || '';
      writeFileSync(derivedPath, JSON.stringify({ kind: 'image', description: visionText, model: r.model, raw: r.raw || null }, null, 2) + '\n', 'utf-8');
    } else {
      visionText = '(nao foi possivel gerar dataUrl para analise da imagem)';
      writeFileSync(derivedPath, JSON.stringify({ kind: 'image', description: visionText }, null, 2) + '\n', 'utf-8');
    }
  } else {
    writeFileSync(derivedPath, JSON.stringify({ kind: mediaType, note: 'generic file (saved only)' }, null, 2) + '\n', 'utf-8');
  }

  const canonical = buildCanonicalMediaMessage({
    kind: mediaType,
    caption,
    transcriptText,
    visionText,
    filePath: originalPath,
    mimetype,
    messageId,
  });

  await routeToTask(phone, task.task_id, canonical);
}

async function handleInboundMedia({ phone, instanceId, data }) {
  const media = data?.media;
  const mediaType = media?.type || data?.type || null;
  const msgObj = media?.message || null;
  if (!instanceId) throw new Error('missing instanceId');
  if (!mediaType || !msgObj) throw new Error('missing media payload');

  const messageId = data.messageId || data.message_id || null;
  const caption = data?.content?.caption || data?.content?.text || '';
  const task = resolveTaskForInboundMedia(phone);

  await sendMessage(phone, `📥 Midia recebida. Processando... (task: *${task.task_id}*)`);

  const downloaded = await downloadMedia(instanceId, { type: mediaType, message: msgObj, asDataUrl: true });
  await processInboundDownloadedMedia({
    phone,
    task,
    instanceId,
    messageId,
    mediaType,
    caption,
    downloaded,
    source: 'whatsapp',
  });
}

async function handleInboundDiscordAttachments({
  phone,
  instanceId,
  messageId,
  text,
  attachments,
}) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a?.url) : [];
  if (list.length === 0) return;
  if (!instanceId) throw new Error('missing instanceId');

  const task = resolveTaskForInboundMedia(phone);
  const textCaption = String(text || '').trim();
  const baseMessageId = String(messageId || `msg-${Date.now()}`);

  await sendMessage(
    phone,
    `📥 ${list.length} anexo(s) do Discord recebido(s). Processando... (task: *${task.task_id}*)`
  );

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const mediaType = normalizeInboundMediaType(item?.kind || item?.mimetype || 'file');
    const attachmentMessageId = `${baseMessageId}-${i + 1}`;
    const label = item?.fileName ? ` (${item.fileName})` : '';

    try {
      const downloaded = await downloadDiscordAttachment({
        url: item?.url,
        fileName: item?.fileName || null,
        mimetype: item?.mimetype || null,
        size: item?.size ?? null,
      });

      await processInboundDownloadedMedia({
        phone,
        task,
        instanceId,
        messageId: attachmentMessageId,
        mediaType,
        caption: textCaption || '',
        downloaded,
        source: 'discord',
      });
    } catch (err) {
      await sendMessage(
        phone,
        `❌ Falha ao processar anexo ${i + 1}/${list.length}${label}: ${truncate(err?.message || 'erro desconhecido', 800)}`
      );
    }
  }
}

async function processUserMessage(phone, text, meta = {}) {
  taskStore.ensureUser(phone);

  // Pending purchase confirmation flow (only blocks/asks on checkout).
  const pendingConf = taskStore.getPendingConfirmation(phone);
  if (pendingConf) {
    const expiresAt = new Date(pendingConf.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      taskStore.clearPendingConfirmation(phone);
    } else if (isPurchaseConfirmationText(text)) {
      const resumed = await resumePendingConfirmation(phone, text);
      if (resumed.ok) return;
      // If it failed, keep going with normal routing.
    }
  }

  // Pending selection flow (Option C)
  const pending = taskStore.getPendingSelection(phone);
  if (pending) {
    const expiresAt = new Date(pending.expires_at).getTime();
    if (Date.now() > expiresAt) {
      taskStore.clearPendingSelection(phone);
    }
  }

  const pref = parseTaskPrefix(text);
  if (pref) {
    await routeToTask(phone, pref.taskId, pref.message, meta);
    return;
  }

  const selection = parseSelectionReply(text);
  const pending2 = taskStore.getPendingSelection(phone);
  if (pending2 && selection) {
    const candidates = JSON.parse(pending2.candidate_task_ids || '[]');
    let chosen = null;
    if (selection.taskId) chosen = selection.taskId;
    else if (selection.index != null) chosen = candidates[selection.index - 1] || null;

    if (!chosen) {
      await sendMessage(phone, '❌ Selecao invalida. Responda com 1/2/3... ou com o taskId.');
      return;
    }

    const original = pending2.original_message;
    taskStore.clearPendingSelection(phone);
    await routeToTask(phone, chosen, original, meta);
    return;
  }

  // Discord channels run in fixed-task mode: focused -> most-recent-active -> new.
  const fixedTaskMode = meta?.transport === 'discord';

  // Default routing: focused -> only-active -> new task -> prompt selection
  const user = taskStore.getUser(phone);
  const active = taskStore.listActiveTasksByPhone(phone);

  if (user?.focused_task_id) {
    const focused = taskStore.getTask(user.focused_task_id);
    if (focused && focused.phone === phone) {
      await routeToTask(phone, focused.task_id, text, meta);
      return;
    }
  }

  if (fixedTaskMode && active.length > 0) {
    taskStore.setUserFocusedTask(phone, active[0].task_id);
    await routeToTask(phone, active[0].task_id, text, meta);
    return;
  }

  if (active.length === 1) {
    taskStore.setUserFocusedTask(phone, active[0].task_id);
    await routeToTask(phone, active[0].task_id, text, meta);
    return;
  }

  if (active.length > 1) {
    const candidateTaskIds = active.slice(0, 6).map((t) => t.task_id);
    const expiresAtIso = new Date(Date.now() + config.pendingSelectionTtlMs).toISOString();
    taskStore.setPendingSelection(phone, text, candidateTaskIds, expiresAtIso);

    const lines = active.slice(0, 6).map((t, i) => {
      const upd = humanizeTaskUpdate(t.last_update || '') || 'Sem atualizacao ainda';
      return `${i + 1}) *${t.task_id}* (${t.status}) [${formatTaskRunnerLabel(t)}] (${t.project_id})\n   ${upd || '...'} `;
    });

    await sendMessage(
      phone,
      `🧩 Voce tem ${active.length} tasks ativas. Qual usar para essa mensagem?\n\n` +
      `${lines.join('\n')}\n\n` +
      `Responda com *1/2/3...* ou com o *taskId*. (expira em ${Math.floor(config.pendingSelectionTtlMs / 1000)}s)`
    );
    return;
  }

  // No active tasks: create a new one and focus it.
  const project = resolveProjectForUser(phone);
  const runnerKind = resolveRunnerForUser(phone);

  const task = taskStore.createTask({
    phone,
    projectId: project.id,
    cwd: project.cwd,
    runnerKind,
    title: text.slice(0, 80),
  });
  taskStore.setUserFocusedTask(phone, task.task_id);

  await routeToTask(phone, task.task_id, text, meta);
}

async function routeToTask(phone, taskId, message, messageMeta = {}) {
  const task = taskStore.getTask(taskId);
  if (!task || task.phone !== phone) {
    await sendMessage(phone, `❌ Task nao encontrada: *${taskId}*`);
    return;
  }

  taskStore.setUserFocusedTask(phone, task.task_id);
  taskStore.insertTaskMessage(task.task_id, 'user', message);
  insertChatHistorySafe({
    phone,
    taskId: task.task_id,
    projectId: task.project_id,
    role: 'user',
    content: message,
  });
  appendTaskAuditLog(task.task_id, {
    stage: 'inbound',
    level: 'info',
    event: 'message_routed',
    content: String(message || ''),
    meta: {
      transport: messageMeta?.transport || null,
      senderId: messageMeta?.senderId || null,
      messageId: messageMeta?.messageId || null,
    },
  });

  const activeRun = taskStore.getActiveRunForTask(task.task_id);
  if (activeRun) {
    const queued = taskStore.enqueueExecutionItem(task.task_id, message);
    appendTaskAuditLog(task.task_id, {
      runId: activeRun.run_id,
      stage: 'queue',
      level: 'info',
      event: 'message_enqueued',
      content: String(message || ''),
      meta: { queueItemId: queued.id, position: queued.position },
    });
    await sendMessage(
      phone,
      `🧾 Mensagem adicionada na fila da task *${task.task_id}* (item ${queued.id}, posicao ${queued.position}).\n` +
      `Use /queue ${task.task_id} para ver/editar.`
    );
    return;
  }

  const user = taskStore.getUser(phone);
  const globalRunnerDefault = (getRunnerDefault() || config.runnerDefault || 'codex-cli').toLowerCase();
  const taskRunner = String(task.runner_kind || '').toLowerCase();
  const userRunner = String(user?.runner_override || '').toLowerCase();

  // Runner forcing rules:
  // - concrete runner on the task always wins
  // - otherwise concrete user override wins
  // - if user/task explicitly set "auto", allow the planner to choose
  // - do NOT force the global default into the planner; the planner should decide.
  let forcedRunnerKind = null;
  if (taskRunner && taskRunner !== 'auto') forcedRunnerKind = taskRunner;
  else if (userRunner && userRunner !== 'auto') forcedRunnerKind = userRunner;
  else if (taskRunner === 'auto' || userRunner === 'auto') forcedRunnerKind = null;

  const longrunSession = taskStore.getActiveLongrunSessionForPhone(phone);

  let orchestration = null;
  try {
    appendTaskAuditLog(task.task_id, {
      stage: 'planner',
      level: 'info',
      event: 'orchestration_requested',
      content: String(message || ''),
      meta: {
        forcedRunnerKind,
        longrunSessionId: longrunSession?.id || null,
      },
    });
    orchestration = await orchestrateTaskMessage({
      phone,
      task,
      userMessage: String(message || '').trim(),
      preferredRunnerKind: forcedRunnerKind,
      longrunSession,
    });
  } catch (err) {
    appendTaskAuditLog(task.task_id, {
      stage: 'planner',
      level: 'error',
      event: 'orchestration_failed',
      content: err?.message || String(err),
      meta: { forcedRunnerKind, fallback: true },
    });
    logger.warn({ error: err?.message }, 'Orchestrator failed, falling back to direct execution');
    const fallbackRunner = (() => {
      const v = String(forcedRunnerKind || globalRunnerDefault || 'codex-cli').toLowerCase();
      if (v === 'auto') return 'codex-cli';
      return isRunnerKindSupported(v) ? v : 'codex-cli';
    })();
    await sendMessage(
      phone,
      `⚠️ Planner falhou, executando direto com runner *${fallbackRunner}*.\n` +
      `${String(err?.message || 'erro desconhecido')}`
    );
    orchestration = {
      plan: {
        version: 1,
        action: 'run',
        runner_kind: fallbackRunner,
        prompt: message,
      },
      providerUsed: 'fallback',
      usedFallback: false,
    };
  }

  appendTaskAuditLog(task.task_id, {
    stage: 'planner',
    level: 'info',
    event: 'orchestration_resolved',
    content: JSON.stringify({
      providerUsed: orchestration?.providerUsed || null,
      usedFallback: Boolean(orchestration?.usedFallback),
      previousErrors: orchestration?.previousErrors || [],
      circuitBreaker: orchestration?.circuitBreaker || null,
      tokenUsagePlanner: orchestration?.tokenUsagePlanner || null,
      planAction: orchestration?.plan?.action || null,
    }),
  });

  const userLogLevel = resolveUserLogLevel(phone);

  if (isVerboseLogLevel(userLogLevel) && orchestration?.usedFallback) {
    const err0 = Array.isArray(orchestration.previousErrors) ? orchestration.previousErrors[0] : null;
    const why = err0?.provider && err0?.error ? ` (${err0.provider}: ${String(err0.error)})` : '';
    await sendMessage(phone, `⚠️ Planner usou fallback: *${orchestration.providerUsed}*${why}`);
  }
  if (
    isVerboseLogLevel(userLogLevel)
    && !orchestration?.usedFallback
    && orchestration?.circuitBreaker?.geminiSkipReason
  ) {
    const reason = orchestration.circuitBreaker.geminiSkipReason;
    await sendMessage(phone, `ℹ️ Planner pulou gemini-cli (cooldown por ${reason}). Usando *${orchestration.providerUsed}*.`);
  }
  if (isVerboseLogLevel(userLogLevel) && config.token.notificationLevel === 'summary' && orchestration?.tokenUsagePlanner) {
    await sendMessage(
      phone,
      `🧮 ${formatTokenSummaryLine('Tokens planner', orchestration.tokenUsagePlanner)}\n` +
      `Tokens task acumulado: ${Number(orchestration?.taskTokenTotals?.totalTokens || 0)}`
    );
  }

  const plan = orchestration?.plan;
  if (!plan) {
    appendTaskAuditLog(task.task_id, {
      stage: 'planner',
      level: 'error',
      event: 'plan_empty',
      content: 'Planner retornou plano vazio.',
    });
    await sendMessage(phone, '❌ Planner retornou um plano vazio.');
    return;
  }
  appendTaskAuditLog(task.task_id, {
    stage: 'planner',
    level: 'info',
    event: 'plan_received',
    content: JSON.stringify(plan),
    meta: { provider: orchestration.providerUsed || null },
  });

  // Store the plan for audit/debug (task-scoped).
  try {
    taskStore.insertTaskMessage(task.task_id, 'system', `PLAN ${JSON.stringify({ ...plan, provider: orchestration.providerUsed })}`);
  } catch {}
  const planActionSummary = summarizePlanAction(plan);
  const actionsWithExplicitMessage = new Set(['reply', 'memory_show', 'memory_clear', 'memory_set', 'memory_append']);
  if (!actionsWithExplicitMessage.has(plan.action)) {
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: `Plano definido: action=${plan.action}`,
      actionSummary: planActionSummary,
    });
  }

  if (plan.action === 'reply') {
    const reply = String(plan.reply_text || '').trim();
    if (!reply) {
      await sendMessage(phone, '❌ Planner retornou reply vazio.');
      return;
    }
    taskStore.insertTaskMessage(task.task_id, 'assistant', reply);
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: reply,
      actionSummary: planActionSummary,
    });
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'reply' });
    await sendMessage(phone, reply);
    return;
  }

  appendTaskAuditLog(task.task_id, {
    stage: 'planner',
    level: 'info',
    event: 'plan_action_dispatch',
    content: String(plan.action || ''),
    meta: {
      summary: planActionSummary,
      scope: plan.scope || null,
      provider: plan.provider || null,
      runner_kind: plan.runner_kind || null,
    },
  });

  if (plan.action === 'set_project') {
    const projectId = String(plan.project_id || '').trim();
    const p = projectManager.getProject(projectId);
    if (!p) {
      await sendMessage(phone, `❌ Projeto "${projectId}" nao encontrado. Use /projects.`);
      return;
    }

    taskStore.setUserDefaultProject(phone, p.id);

    const createNewTask = plan.create_new_task !== false;
    if (createNewTask) {
      const runnerKind = resolveRunnerForUser(phone);
      const t2 = taskStore.createTask({
        phone,
        projectId: p.id,
        cwd: p.cwd,
        runnerKind,
        title: `Projeto ${p.id}`,
      });
      taskStore.setUserFocusedTask(phone, t2.task_id);
      await sendMessage(phone, `✅ Projeto alterado para *${p.id}*.\nNova task: *${t2.task_id}*`);
    } else {
      await sendMessage(phone, `✅ Projeto default alterado para *${p.id}*.`);
    }

    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: `set_project ${p.id}` });
    return;
  }

  if (plan.action === 'set_runner') {
    const kind = String(plan.runner_kind || '').toLowerCase();
    const scope = String(plan.scope || 'user').toLowerCase();
    const allowedText = listRunnerKindsText({ includeAuto: true });

    if (!isRunnerKindSupported(kind, { includeAuto: true })) {
      await sendMessage(phone, `❌ Runner invalido. Use: ${allowedText}`);
      return;
    }

    if (scope === 'global') {
      if (!isAdmin(phone, messageMeta?.senderId)) {
        await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
        return;
      }
      setSetting(SettingsKeys.runnerDefault, kind);
      await sendMessage(phone, `✅ Runner global atualizado: *${kind}*`);
      return;
    }

    if (scope === 'task') {
      taskStore.updateTask(task.task_id, { runner_kind: kind });
      await sendMessage(phone, `✅ Runner desta task atualizado: *${kind}*`);
      return;
    }

    taskStore.setUserRunnerOverride(phone, kind);
    const linkedTaskId = applyRunnerOverrideToCurrentTask(phone, kind);
    await sendMessage(
      phone,
      linkedTaskId
        ? `✅ Runner atualizado: *${kind}* (task *${linkedTaskId}* tambem atualizada).`
        : `✅ Runner atualizado: *${kind}*.`
    );
    return;
  }

  if (plan.action === 'set_orchestrator') {
    const provider = String(plan.provider || '').toLowerCase();
    const scope = String(plan.scope || 'user').toLowerCase();
    const allowed = new Set(['gemini-cli', 'openrouter', 'codex-cli', 'auto']);

    if (!allowed.has(provider)) {
      await sendMessage(phone, '❌ Orchestrator invalido. Use: gemini-cli|openrouter|codex-cli|auto');
      return;
    }

    if (scope === 'global') {
      if (!isAdmin(phone, messageMeta?.senderId)) {
        await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
        return;
      }
      setSetting(SettingsKeys.orchestratorProviderDefault, provider);
      await sendMessage(phone, `✅ Orchestrator global atualizado: *${provider}*`);
      return;
    }

    taskStore.setUserOrchestratorOverride(phone, provider);
    await sendMessage(phone, `✅ Orchestrator atualizado: *${provider}*`);
    return;
  }

  if (plan.action === 'set_task_policy') {
    const len = plan.task_id_length != null ? Number.parseInt(String(plan.task_id_length), 10) : null;
    const history = plan.project_task_history_limit != null
      ? Number.parseInt(String(plan.project_task_history_limit), 10)
      : null;

    if (len == null && history == null) {
      await sendMessage(phone, '❌ Planner retornou politica de task vazia.');
      return;
    }
    if (len != null && (!Number.isFinite(len) || len < 1 || len > 8)) {
      await sendMessage(phone, '❌ task_id_length invalido (use 1..8).');
      return;
    }
    if (history != null && (!Number.isFinite(history) || history < 1 || history > 500)) {
      await sendMessage(phone, '❌ project_task_history_limit invalido (use 1..500).');
      return;
    }

    if (len != null) setSetting(SettingsKeys.taskIdLength, String(len));
    if (history != null) setSetting(SettingsKeys.projectTaskHistoryLimit, String(history));

    await sendMessage(
      phone,
      `✅ Politica de tasks atualizada:\n` +
      `• task_id_length: *${getTaskIdLength()}*\n` +
      `• project_task_history_limit: *${getProjectTaskHistoryLimit()}*`
    );
    return;
  }

  if (plan.action === 'memory_show') {
    const memoryScope = String(plan.memory_scope || 'user').toLowerCase();
    if (memoryScope === 'project') {
      const mem = taskStore.getProjectMemory(task.project_id, phone);
      const content = String(mem?.content || '').trim();
      const reply = `🧠 *Memoria do projeto (${task.project_id})*\n${content ? `\n${content}` : '\n(vazia)'}`;
      insertChatHistorySafe({
        phone,
        taskId: task.task_id,
        projectId: task.project_id,
        role: 'assistant',
        content: reply,
        actionSummary: planActionSummary,
      });
      await sendMessage(phone, reply);
      taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_show_project' });
      return;
    }

    const mem = taskStore.getUserSharedMemory(phone);
    const content = String(mem?.content || '').trim();
    const reply = `🧠 *Memoria compartilhada*\n${content ? `\n${content}` : '\n(vazia)'}`;
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: reply,
      actionSummary: planActionSummary,
    });
    await sendMessage(phone, reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_show_user' });
    return;
  }

  if (plan.action === 'memory_clear') {
    const memoryScope = String(plan.memory_scope || 'user').toLowerCase();
    if (memoryScope === 'project') {
      taskStore.clearProjectMemory(task.project_id, phone);
      const reply = `🗑️ Memoria do projeto *${task.project_id}* limpa.`;
      insertChatHistorySafe({
        phone,
        taskId: task.task_id,
        projectId: task.project_id,
        role: 'assistant',
        content: reply,
        actionSummary: planActionSummary,
      });
      await sendMessage(phone, reply);
      taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_clear_project' });
      return;
    }

    taskStore.clearUserSharedMemory(phone);
    const reply = '🗑️ Memoria compartilhada limpa.';
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: reply,
      actionSummary: planActionSummary,
    });
    await sendMessage(phone, reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_clear_user' });
    return;
  }

  if (plan.action === 'memory_set') {
    const text = String(plan.memory_text || '').trim();
    if (!text) {
      await sendMessage(phone, '❌ Planner retornou memory_text vazio.');
      return;
    }
    const memoryScope = String(plan.memory_scope || 'user').toLowerCase();
    if (memoryScope === 'project') {
      taskStore.setProjectMemory(task.project_id, phone, text);
      const reply = `✅ Memoria do projeto *${task.project_id}* atualizada.`;
      insertChatHistorySafe({
        phone,
        taskId: task.task_id,
        projectId: task.project_id,
        role: 'assistant',
        content: reply,
        actionSummary: planActionSummary,
      });
      await sendMessage(phone, reply);
      taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_set_project' });
      return;
    }

    taskStore.setUserSharedMemory(phone, text);
    const reply = '✅ Memoria compartilhada atualizada.';
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: reply,
      actionSummary: planActionSummary,
    });
    await sendMessage(phone, reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_set_user' });
    return;
  }

  if (plan.action === 'memory_append') {
    const text = String(plan.memory_text || '').trim();
    if (!text) {
      await sendMessage(phone, '❌ Planner retornou memory_text vazio.');
      return;
    }
    const memoryScope = String(plan.memory_scope || 'user').toLowerCase();
    if (memoryScope === 'project') {
      taskStore.appendProjectMemory(task.project_id, phone, text);
      const reply = `✅ Salvo na memoria do projeto *${task.project_id}*.`;
      insertChatHistorySafe({
        phone,
        taskId: task.task_id,
        projectId: task.project_id,
        role: 'assistant',
        content: reply,
        actionSummary: planActionSummary,
      });
      await sendMessage(phone, reply);
      taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_append_project' });
      return;
    }

    taskStore.appendUserSharedMemory(phone, text);
    const reply = '✅ Salvo na memoria compartilhada.';
    insertChatHistorySafe({
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      role: 'assistant',
      content: reply,
      actionSummary: planActionSummary,
    });
    await sendMessage(phone, reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'memory_append_user' });
    return;
  }

  if (plan.action === 'project_scan') {
    if (!isAdmin(phone, messageMeta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return;
    }
    try {
      const result = projectManager.scanDevelopmentRoot({ type: 'local' });
      await sendMessage(phone, `🔎 Scan concluido em DEVELOPMENT_ROOT.\nAdicionados: *${result.added}*`);
    } catch (err) {
      await sendMessage(phone, `❌ Falha no scan: ${truncate(err?.message || 'erro desconhecido', 800)}`);
    }
    return;
  }

  if (plan.action === 'project_add') {
    if (!isAdmin(phone, messageMeta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return;
    }
    const id = String(plan.id || '').trim();
    const cwd = String(plan.cwd || '').trim();
    if (!id || !cwd) {
      await sendMessage(phone, '❌ Faltando id/cwd.');
      return;
    }
    try {
      const { statSync } = await import('node:fs');
      const st = statSync(cwd);
      if (!st.isDirectory()) {
        await sendMessage(phone, `❌ cwd nao e uma pasta: ${cwd}`);
        return;
      }
      // No path restrictions; cwd is used as context but projects can live anywhere.
      const p = projectManager.upsertProject({ id, cwd, type: plan.type || null, name: plan.name || null });
      await sendMessage(phone, `✅ Projeto upserted: *${p.id}* (${p.type})\n${p.cwd}`);
    } catch (err) {
      await sendMessage(phone, `❌ Falha ao adicionar projeto: ${truncate(err?.message || 'erro desconhecido', 800)}`);
    }
    return;
  }

  if (plan.action === 'project_mkdir') {
    if (!isAdmin(phone, messageMeta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return;
    }
    const id = String(plan.id || '').trim();
    const dir = String(plan.dir || '').trim();
    if (!id || !dir) {
      await sendMessage(phone, '❌ Faltando id/dir.');
      return;
    }
    try {
      const { full } = resolveProjectPath(dir);
      if (!existsSync(full)) mkdirSync(full, { recursive: true });
      const p = projectManager.upsertProject({ id, cwd: full, type: plan.type || 'local', name: plan.name || basename(full) });
      await sendMessage(phone, `✅ Projeto criado/registrado: *${p.id}* (${p.type})\n${p.cwd}`);
    } catch (err) {
      await sendMessage(phone, `❌ Falha no mkdir: ${truncate(err?.message || 'erro desconhecido', 800)}`);
    }
    return;
  }

  if (plan.action === 'project_clone') {
    if (!isAdmin(phone, messageMeta?.senderId)) {
      await sendMessage(phone, '⛔ Comando admin. Seu numero nao esta em ADMIN_PHONE_NUMBERS.');
      return;
    }
    const id = String(plan.id || '').trim();
    const gitUrl = String(plan.git_url || '').trim();
    const dir = String(plan.dir || repoBasename(gitUrl) || '').trim();
    const depth = typeof plan.depth === 'number' ? plan.depth : 1;
    if (!id || !gitUrl) {
      await sendMessage(phone, '❌ Faltando id/git_url.');
      return;
    }
    if (!dir) {
      await sendMessage(phone, '❌ Nao consegui inferir dir. Informe dir.');
      return;
    }
    try {
      const { devRoot, full: target } = resolveProjectPath(dir);
      if (existsSync(target)) {
        await sendMessage(phone, `❌ Pasta ja existe: ${target}`);
        return;
      }

      await sendMessage(phone, `⬇️ Clonando...\n${gitUrl}\n→ ${target}`);

      const args = ['clone'];
      if (Number.isFinite(depth) && depth > 0) args.push('--depth', String(depth));
      args.push(gitUrl, target);

      const result = await spawnPromise('git', args, { cwd: devRoot, env: process.env });
      const p = projectManager.upsertProject({ id, cwd: target, type: plan.type || 'git', name: plan.name || dir });

      await sendMessage(
        phone,
        `✅ Clone ok + projeto registrado: *${p.id}* (${p.type})\n${p.cwd}\n\n` +
        `git: ${truncate((result.stderr || result.stdout || 'ok').trim(), 800)}`
      );
    } catch (err) {
      await sendMessage(phone, `❌ Falha no clone: ${truncate(err?.message || 'erro desconhecido', 1200)}`);
    }
    return;
  }

  // action=longrun_initiate
  // First detection: planner has generated a feature UUID and first gathering questions.
  if (plan.action === 'longrun_initiate') {
    const featureUuid = String(plan.feature_uuid || '').trim();
    const reply = String(plan.reply_text || '').trim();
    if (!featureUuid || !reply) {
      await sendMessage(phone, '❌ Planner retornou longrun_initiate invalido (faltando feature_uuid ou reply_text).');
      return;
    }

    const existingActive = taskStore.getActiveLongrunSessionForPhone(phone);
    if (existingActive && existingActive.status !== 'failed' && existingActive.status !== 'completed') {
      await sendMessage(
        phone,
        `⚠️ Ja existe um LongRun ativo (feature: *${existingActive.feature_title || existingActive.feature_uuid}*, status: ${existingActive.status}).\n` +
        `Envie */longrun-status* para ver detalhes ou conclua/cancele o atual primeiro.`
      );
      return;
    }

    const sessionId = crypto.randomUUID();
    const longrunRoot = getLongrunRoot(task.cwd, featureUuid);
    ensureLongrunDirs(longrunRoot);

    taskStore.createLongrunSession({
      id: sessionId,
      phone,
      taskId: task.task_id,
      projectId: task.project_id,
      projectCwd: task.cwd,
      featureUuid,
      featureTitle: null,
      specJson: null,
      preferredRunner: null,
      runnerPriority: LONGRUN_RUNNER_PRIORITY,
    });

    taskStore.insertTaskMessage(task.task_id, 'assistant', reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'longrun_initiate' });
    await sendMessage(phone, reply);
    return;
  }

  // action=longrun_gather
  // Incremental gathering: planner has accumulated more spec data. Write files to disk.
  if (plan.action === 'longrun_gather') {
    const specJsonRaw = String(plan.spec_json || '').trim();
    const reply = String(plan.reply_text || '').trim();

    const activeSession = longrunSession || taskStore.getActiveLongrunSessionForPhone(phone);
    if (!activeSession) {
      await sendMessage(phone, '❌ Nenhuma sessao LongRun ativa para longrun_gather.');
      return;
    }
    if (activeSession.status !== 'gathering' && activeSession.status !== 'confirming') {
      await sendMessage(phone, `❌ Sessao LongRun em estado invalido para gather: ${activeSession.status}`);
      return;
    }

    let partialSpec;
    try {
      partialSpec = JSON.parse(specJsonRaw);
    } catch {
      await sendMessage(phone, '❌ spec_json invalido em longrun_gather.');
      return;
    }

    const longrunRoot = getLongrunRoot(activeSession.project_cwd, activeSession.feature_uuid);
    ensureLongrunDirs(longrunRoot);
    writePartialSpec(longrunRoot, partialSpec);

    const featureTitle = partialSpec?.feature?.title || activeSession.feature_title || null;
    taskStore.updateLongrunSession(activeSession.id, {
      spec_json: specJsonRaw,
      feature_title: featureTitle,
      status: 'gathering',
    });

    taskStore.insertTaskMessage(task.task_id, 'assistant', reply);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'longrun_gather' });
    await sendMessage(phone, reply);
    return;
  }

  // action=longrun_confirm
  // Full spec ready: write final files (including tasks.txt and validations.txt), await user confirmation.
  if (plan.action === 'longrun_confirm') {
    const specJsonRaw = String(plan.spec_json || '').trim();
    const summary = String(plan.reply_text || '').trim();

    const activeSession = longrunSession || taskStore.getActiveLongrunSessionForPhone(phone);
    if (!activeSession) {
      await sendMessage(phone, '❌ Nenhuma sessao LongRun ativa para longrun_confirm.');
      return;
    }

    let spec;
    try {
      spec = JSON.parse(specJsonRaw);
    } catch {
      await sendMessage(phone, '❌ spec_json invalido em longrun_confirm.');
      return;
    }

    const docQuality = validateLongrunDocumentationSpec(spec, {
      minLinesPerSection: MIN_LONGRUN_DOC_LINES,
    });
    if (!docQuality.ok) {
      const issuesText = formatLongrunDocumentationIssues(docQuality.issues, { maxItems: 20 });
      const issueCount = docQuality.issues.length;
      taskStore.updateLongrunSession(activeSession.id, {
        status: 'gathering',
        spec_json: specJsonRaw,
        feature_title: spec?.feature?.title || activeSession.feature_title || null,
      });
      await sendMessage(
        phone,
        `❌ LongRun ainda nao pode ir para confirmacao final.\n` +
        `Exigencia minima: ${MIN_LONGRUN_DOC_LINES} linhas nao vazias por nivel de documentacao ` +
        `(feature/wave/epic group/epic/validation/task), com conteudo nao repetitivo.\n\n` +
        `Pendencias (${issueCount}):\n${issuesText}\n\n` +
        `Ajuste o spec e tente novamente.`
      );
      return;
    }

    const longrunRoot = getLongrunRoot(activeSession.project_cwd, activeSession.feature_uuid);
    ensureLongrunDirs(longrunRoot);

    try {
      writeFinalSpec(longrunRoot, spec);
    } catch (err) {
      await sendMessage(phone, `❌ Falha ao escrever arquivos LongRun: ${truncate(err?.message || 'erro desconhecido', 600)}`);
      return;
    }

    const featureTitle = spec?.feature?.title || activeSession.feature_title || null;
    taskStore.updateLongrunSession(activeSession.id, {
      status: 'confirming',
      spec_json: specJsonRaw,
      feature_title: featureTitle,
    });

    taskStore.insertTaskMessage(task.task_id, 'assistant', summary);
    taskStore.updateTask(task.task_id, { status: 'waiting', last_update: 'longrun_confirm' });
    await sendMessage(phone, summary);
    await sendMessage(
      phone,
      `Documentos criados em:\n${longrunRoot}\n\n` +
      `Responda *confirmo* para iniciar a execucao ou sugira modificacoes.`
    );
    return;
  }

  // action=longrun_execute
  // User confirmed: start the recursive execution engine.
  if (plan.action === 'longrun_execute') {
    const activeSession = longrunSession || taskStore.getActiveLongrunSessionForPhone(phone);
    if (!activeSession || activeSession.status !== 'confirming') {
      await sendMessage(phone, '❌ Nenhum LongRun aguardando confirmacao. Use */longrun-status* para verificar.');
      return;
    }

    let spec;
    try {
      spec = JSON.parse(activeSession.spec_json || 'null');
    } catch {
      await sendMessage(phone, '❌ spec_json corrompido na sessao LongRun.');
      return;
    }
    if (!spec) {
      await sendMessage(phone, '❌ Spec LongRun vazio. Reinicie o processo de coleta.');
      return;
    }

    const longrunRoot = getLongrunRoot(activeSession.project_cwd, activeSession.feature_uuid);
    await startLongrunExecution({ phone, task, session: activeSession, spec, longrunRoot });
    return;
  }

  // action=run
  // Keep forced runner precedence (task/user override) over planner suggestion.
  let runnerKind = String(forcedRunnerKind || plan.runner_kind || globalRunnerDefault || 'codex-cli').toLowerCase();
  if (runnerKind === 'auto') {
    runnerKind = String(globalRunnerDefault || 'codex-cli').toLowerCase();
  }
  if (runnerKind === 'auto' || !isRunnerKindSupported(runnerKind)) {
    const forced = String(forcedRunnerKind || '').toLowerCase();
    runnerKind = isRunnerKindSupported(forced) ? forced : 'codex-cli';
  }
  const sharedMemory = taskStore.getUserSharedMemory(phone)?.content || '';
  const projectMemory = taskStore.getProjectMemory(task.project_id, phone)?.content || '';
  const scopedPrompt = buildScopedExecutionPrompt({
    plannerPrompt: String(plan.prompt || message).trim(),
    userRequest: String(message || '').trim(),
  });
  const prompt = buildPromptWithMemories({
    prompt: scopedPrompt,
    sharedMemory,
    projectMemory,
    projectId: task.project_id,
  });
  if (plan.title) taskStore.updateTask(task.task_id, { title: String(plan.title).slice(0, 120) });

  appendTaskAuditLog(task.task_id, {
    stage: 'executor',
    level: 'info',
    event: 'run_dispatch',
    content: prompt,
    meta: { runnerKind, forcedRunnerKind: forcedRunnerKind || null },
  });

  await executor.enqueueTaskRun({ phone, task, prompt, runnerKind });
}

export function normalizeWhatsAppPayload(payload) {
  if (payload?.event !== 'message.received') return null;

  const instanceId = payload?.instanceId || payload?.instance_id || config.whatsappInstanceId;
  const data = payload?.data;
  if (!data) return null;

  if (data.type !== 'text' && data.type !== 'image' && data.type !== 'audio' && data.type !== 'voice' && data.type !== 'file') return null;
  if (data.isGroup) return null;
  if (data.fromMe) return null;

  const actorId = extractPhone(data.from);
  if (!actorId) return null;

  const text = typeof data.content === 'string' ? data.content : data.content?.text || '';
  const messageId = data.messageId || data.message_id || null;

  return {
    transport: 'whatsapp',
    actorId,
    senderId: actorId,
    guildId: null,
    channelId: null,
    type: data.type,
    text: String(text || ''),
    messageId: messageId ? String(messageId) : null,
    instanceId: instanceId ? String(instanceId) : null,
    attachmentsCount: 0,
    rawData: data,
  };
}

function shouldAllowDiscordMessage(payload) {
  const actor = parseDiscordActor(payload.actorId);
  const guildId = String(payload.guildId || actor?.guildId || '').trim();
  const channelId = String(payload.channelId || actor?.channelId || '').trim();
  const senderId = String(payload.senderId || '').trim();

  if (!guildId || !channelId) return { ok: false, reason: 'invalid_actor' };
  if (!isDiscordGuildAllowed(guildId)) return { ok: false, reason: 'guild_not_allowed' };

  const text = String(payload.text || '').trim();
  const isEnableCommand = /^\/channel-enable\b/i.test(text);
  const isChannelAdminCommand = /^\/channel-(enable|disable|info)\b/i.test(text);
  const channelEnabled = taskStore.isDiscordChannelEnabled(channelId);
  if (!channelEnabled && !((isEnableCommand || isChannelAdminCommand) && isDiscordAdmin(senderId))) {
    return { ok: false, reason: 'channel_disabled', guildId, channelId };
  }

  return { ok: true, guildId, channelId };
}

export async function processInboundMessage(payload) {
  try {
    const transport = String(payload?.transport || '').trim().toLowerCase();
    const actorId = String(payload?.actorId || '').trim();
    if (!transport || !actorId) return;

    const type = String(payload?.type || '').trim().toLowerCase();
    if (type !== 'text' && type !== 'image' && type !== 'audio' && type !== 'voice' && type !== 'file') return;

    if (transport === 'whatsapp') {
      if (!isWhatsAppAuthorized(actorId)) {
        logger.warn({ actorId }, 'Unauthorized WhatsApp message received');
        return;
      }
    } else if (transport === 'discord') {
      const check = shouldAllowDiscordMessage(payload);
      if (!check.ok) {
        if (check.reason === 'guild_not_allowed') {
          logger.warn({ actorId, guildId: payload?.guildId }, 'Discord guild not allowed');
          return;
        }
        if (check.reason === 'channel_disabled') {
          logger.debug({ actorId, channelId: payload?.channelId }, 'Discord channel disabled, message ignored');
          return;
        }
        logger.warn({ actorId, reason: check.reason }, 'Discord message rejected');
        return;
      }
    } else {
      return;
    }

    const instanceId = String(payload?.instanceId || '').trim();
    const messageId = String(payload?.messageId || '').trim();
    if (instanceId && messageId) {
      const first = taskStore.markInboundMessageProcessed({ instanceId, messageId, phone: actorId });
      if (!first) {
        logger.info({ actorId, instanceId, messageId }, 'Duplicate inbound message ignored');
        return;
      }
    }

    logger.info({ actorId, transport, type }, 'Inbound message');

    if (type === 'text') {
      const rawText = String(payload?.text || '');
      const text = rawText.trim();
      const isSlashCommand = text.startsWith('/');
      const attachments = transport === 'discord' && Array.isArray(payload?.attachments)
        ? payload.attachments
        : [];
      const meta = {
        transport,
        senderId: payload?.senderId || null,
      };

      if (text) {
        if (isSlashCommand) {
          const handled = await handleCommand(actorId, text, meta);
          if (handled) return;
        }

        await processUserMessage(actorId, text, meta);
      }

      if (transport === 'discord' && attachments.length > 0 && !isSlashCommand) {
        await handleInboundDiscordAttachments({
          phone: actorId,
          instanceId: instanceId || config.discord.instanceId || 'discord',
          messageId: messageId || null,
          text,
          attachments,
        });
      }

      return;
    }

    if (transport !== 'whatsapp') return;
    const data = payload?.rawData;
    if (!data) return;

    try {
      await handleInboundMedia({
        phone: actorId,
        instanceId: instanceId || config.whatsappInstanceId,
        data,
      });
    } catch (err) {
      await sendMessage(actorId, `❌ Falha ao processar midia: ${truncate(err?.message || 'erro desconhecido', 800)}`);
      throw err;
    }
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Inbound processing failed');
  }
}

export async function processWhatsAppPayload(payload) {
  const normalized = normalizeWhatsAppPayload(payload);
  if (!normalized) return;
  await processInboundMessage(normalized);
}

export default {
  normalizeWhatsAppPayload,
  processInboundMessage,
  processWhatsAppPayload,
};
