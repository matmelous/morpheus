/**
 * LongRun Recursive Execution Engine
 *
 * Drives the recursive, task-by-task execution of a LongRun session.
 * Each task is dispatched to a CLI runner via executor.enqueueTaskRun().
 * After each run completes (via the onRunComplete hook registered in inbound-core.js),
 * this module advances to the next task, runs epic validation, and handles auto-correction.
 *
 * State is persisted in:
 *   - longrun_sessions DB table (session status, current_task_uuid, auto_correct_attempt)
 *   - <project>/.morpheus/longrun/<feature-uuid>/tasks.txt  (per-task progress)
 *   - <project>/.morpheus/longrun/<feature-uuid>/validations.txt (per-epic validation status)
 *
 * No direct DB access here — all DB operations go through task-store.js.
 */

import crypto from 'node:crypto';
import { sendMessage } from './messenger.js';
import { executor } from './executor.js';
import { taskStore } from './task-store.js';
import { logger } from '../utils/logger.js';
import {
  getLongrunRoot,
  readTasksList,
  markTaskStatus,
  readValidationsList,
  markEpicValidationStatus,
  readTaskFile,
  readEpicFile,
  findEpicForTask,
  getTasksForEpic,
  getAllEpicsInOrder,
  findEpicGroupForEpic,
  insertAutoCorrectEpic,
} from './longrun.js';

// Default runner priority order for LongRun execution.
export const LONGRUN_RUNNER_PRIORITY = ['codex-cli', 'claude-cli', 'gemini-cli', 'cursor-cli'];

// Maximum consecutive auto-correct attempts before giving up.
const MAX_AUTO_CORRECT_ATTEMPTS = 2;

// --- Public API ---

/**
 * Starts execution of a confirmed LongRun session.
 * Sets session status to 'running' and begins advancing through tasks.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {object} params.task - Morpheus task object (task_id, project_id, cwd, phone)
 * @param {object} params.session - longrun_sessions DB row
 * @param {object} params.spec - Parsed spec_json object (complete spec)
 * @param {string} params.longrunRoot - Absolute path to .morpheus/longrun/<feature-uuid>/
 */
export async function startLongrunExecution({ phone, task, session, spec, longrunRoot }) {
  taskStore.updateLongrunSession(session.id, { status: 'running', auto_correct_attempt: 0 });
  try {
    taskStore.insertTaskAuditLog({
      taskId: task.task_id,
      stage: 'longrun',
      level: 'info',
      event: 'longrun_started',
      content: JSON.stringify({
        sessionId: session.id,
        featureUuid: session.feature_uuid,
        featureTitle: spec.feature?.title || session.feature_title || null,
        root: longrunRoot,
      }),
    });
  } catch {}

  const tasks = readTasksList(longrunRoot);
  const totalTasks = tasks.length;
  const epics = getAllEpicsInOrder(spec);

  await sendMessage(
    phone,
    `[LongRun] Iniciando execucao!\n` +
    `Feature: *${spec.feature?.title || session.feature_title || '(sem titulo)'}*\n` +
    `Waves: ${spec.waves?.length || 0} | Epics: ${epics.length} | Tasks: ${totalTasks}\n\n` +
    `Executando tasks automaticamente. Voce sera notificado a cada validacao de epic e ao concluir.`
  );

  await advanceLongrun({ phone, task, session, spec, longrunRoot });
}

/**
 * Main advancement function. Finds the next pending task and dispatches it.
 * Called after each task or validation run completes.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {object} params.task - Morpheus task object
 * @param {object} params.session - longrun_sessions DB row (may be stale — refreshed internally)
 * @param {object} params.spec - Parsed spec object (may have been mutated by auto-correct injection)
 * @param {string} params.longrunRoot
 */
export async function advanceLongrun({ phone, task, session, spec, longrunRoot }) {
  // Always work with a fresh session from DB to avoid stale state.
  const freshSession = taskStore.getLongrunSession(session.id);
  if (!freshSession || freshSession.status !== 'running') {
    logger.info(
      { sessionId: session.id, status: freshSession?.status },
      '[LongRun] advance skipped — session not in running state'
    );
    return;
  }

  const tasks = readTasksList(longrunRoot);
  const nextTask = tasks.find((t) => t.status === 'pending');

  if (!nextTask) {
    await completeLongrun({ phone, session: freshSession, spec });
    return;
  }

  const runnerKind = resolveRunnerForSession(freshSession);
  const taskFile = readTaskFile(longrunRoot, nextTask.uuid);
  const epic = findEpicForTask(spec, nextTask.uuid);
  const epicTasks = epic ? getTasksForEpic(spec, epic.uuid) : [];
  const taskIndex = epic ? epicTasks.findIndex((t) => t.uuid === nextTask.uuid) : -1;
  const isLastTaskOfEpic = epic && taskIndex >= 0 && taskIndex === epicTasks.length - 1;

  const commitPrefix = isLastTaskOfEpic
    ? `feat(${epic.title}): complete - `
    : `feat(${epic ? epic.title : 'task'}): `;

  const taskPrompt = buildTaskPrompt({
    taskFile,
    taskUuid: nextTask.uuid,
    epic,
    isLastTaskOfEpic,
    commitPrefix,
    projectCwd: freshSession.project_cwd,
  });

  // Persist current task UUID to session before dispatching.
  taskStore.updateLongrunSession(freshSession.id, { current_task_uuid: nextTask.uuid });

  const taskTitle = taskFile ? extractFirstHeading(taskFile) : nextTask.uuid;
  const taskNum = tasks.filter((t) => t.status === 'done').length + 1;
  const totalTasks = tasks.length;

  await sendMessage(
    phone,
    `[LongRun] Task ${taskNum}/${totalTasks}\n` +
    `*${taskTitle}*\n` +
    `Epic: ${epic ? epic.title : '(desconhecido)'}\n` +
    `Runner: ${runnerKind}`
  );

  logger.info(
    { sessionId: freshSession.id, taskUuid: nextTask.uuid, epic: epic?.title, runnerKind },
    '[LongRun] dispatching task'
  );
  try {
    taskStore.insertTaskAuditLog({
      taskId: task.task_id,
      stage: 'longrun',
      level: 'info',
      event: 'task_dispatched',
      content: JSON.stringify({
        sessionId: freshSession.id,
        taskUuid: nextTask.uuid,
        runnerKind,
        epicTitle: epic?.title || null,
        isLastTaskOfEpic,
      }),
    });
  } catch {}

  await executor.enqueueTaskRun({
    phone,
    task,
    prompt: taskPrompt,
    runnerKind,
  });
}

/**
 * Called by the inbound-core onRunComplete hook after a LongRun task run finishes successfully.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {object} params.task
 * @param {object} params.session - DB row (may be slightly stale)
 * @param {object} params.spec - Parsed spec (may have been mutated by auto-correct)
 * @param {string} params.longrunRoot
 * @param {string} params.completedTaskUuid
 */
export async function onLongrunTaskComplete({ phone, task, session, spec, longrunRoot, completedTaskUuid }) {
  markTaskStatus(longrunRoot, completedTaskUuid, 'done');
  try {
    taskStore.insertTaskAuditLog({
      taskId: task.task_id,
      stage: 'longrun',
      level: 'info',
      event: 'task_completed',
      content: completedTaskUuid,
      metaJson: JSON.stringify({ sessionId: session.id }),
    });
  } catch {}

  const epic = findEpicForTask(spec, completedTaskUuid);
  if (!epic) {
    // No epic context — just advance to next task.
    await advanceLongrun({ phone, task, session, spec, longrunRoot });
    return;
  }

  // Check if all tasks in this epic are now done.
  const epicTasks = getTasksForEpic(spec, epic.uuid);
  const tasksList = readTasksList(longrunRoot);
  const allEpicTasksDone = epicTasks.every((et) => {
    const entry = tasksList.find((t) => t.uuid === et.uuid);
    return entry?.status === 'done';
  });

  if (!allEpicTasksDone) {
    await advanceLongrun({ phone, task, session, spec, longrunRoot });
    return;
  }

  // All tasks of this epic are done — run epic validation.
  await runEpicValidation({ phone, task, session, spec, longrunRoot, epic });
}

/**
 * Called by the inbound-core onRunComplete hook after a LongRun task run fails.
 * Sets session status to 'paused' and notifies the user.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {object} params.session - DB row
 * @param {string} params.errorMsg
 * @param {string} params.taskUuid
 */
export async function onLongrunTaskFailed({ phone, session, errorMsg, taskUuid }) {
  taskStore.updateLongrunSession(session.id, { status: 'paused' });
  try {
    taskStore.insertTaskAuditLog({
      taskId: session.task_id,
      stage: 'longrun',
      level: 'error',
      event: 'task_failed',
      content: `${taskUuid}: ${String(errorMsg || '')}`,
      metaJson: JSON.stringify({ sessionId: session.id }),
    });
  } catch {}

  await sendMessage(
    phone,
    `[LongRun] Falha na task.\n` +
    `Task UUID: ${taskUuid}\n` +
    `Erro: ${String(errorMsg || '').slice(0, 600)}\n\n` +
    `LongRun pausado. Corrija o problema e envie */longrun-resume* para continuar.`
  );
}

/**
 * Called by the inbound-core onRunComplete hook after an epic validation run completes.
 * Determines pass/fail and either continues or triggers auto-correct.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {object} params.task
 * @param {object} params.session - DB row (may be slightly stale)
 * @param {object} params.spec - Parsed spec (may be mutated by auto-correct)
 * @param {string} params.longrunRoot
 * @param {object} params.epic - The epic that was validated
 * @param {string} params.runSummary - Summary text from the validation run
 */
export async function onLongrunValidationComplete({ phone, task, session, spec, longrunRoot, epic, runSummary }) {
  const freshSession = taskStore.getLongrunSession(session.id);
  const passed = inferValidationPassed(runSummary);

  if (passed) {
    markEpicValidationStatus(longrunRoot, epic.uuid, 'validated');
    taskStore.updateLongrunSession(freshSession.id, {
      auto_correct_attempt: 0,
      current_task_uuid: null,
    });

    await sendMessage(
      phone,
      `[LongRun] Validacao OK: *${epic.title}*\nContinuando...`
    );
    try {
      taskStore.insertTaskAuditLog({
        taskId: task.task_id,
        stage: 'longrun',
        level: 'info',
        event: 'epic_validated',
        content: epic.uuid,
        metaJson: JSON.stringify({ epicTitle: epic.title, sessionId: freshSession.id }),
      });
    } catch {}

    logger.info({ sessionId: freshSession.id, epic: epic.title }, '[LongRun] epic validated, advancing');
    await advanceLongrun({ phone, task, session: freshSession, spec, longrunRoot });
    return;
  }

  // Validation failed.
  const attempts = Number(freshSession?.auto_correct_attempt || 0);
  logger.info(
    { sessionId: freshSession.id, epic: epic.title, attempt: attempts + 1 },
    '[LongRun] epic validation failed, attempting auto-correct'
  );

  if (attempts >= MAX_AUTO_CORRECT_ATTEMPTS) {
    // Max consecutive auto-correct attempts reached — stop the LongRun.
    markEpicValidationStatus(longrunRoot, epic.uuid, 'failed');
    taskStore.updateLongrunSession(freshSession.id, { status: 'failed' });

    await sendMessage(
      phone,
      `[LongRun] PARADO — ${MAX_AUTO_CORRECT_ATTEMPTS} tentativas de auto-correcao falharam consecutivamente.\n\n` +
      `Epic com falha: *${epic.title}*\n` +
      `UUID: ${epic.uuid}\n\n` +
      `Saida da ultima validacao:\n${String(runSummary || '(sem saida)').slice(0, 1200)}\n\n` +
      `Documentos preservados em:\n${longrunRoot}\n\n` +
      `Revise os documentos, corrija os problemas e inicie um novo LongRun quando pronto.`
    );
    try {
      taskStore.insertTaskAuditLog({
        taskId: task.task_id,
        stage: 'longrun',
        level: 'error',
        event: 'auto_correct_exhausted',
        content: epic.uuid,
        metaJson: JSON.stringify({ epicTitle: epic.title, attempts: MAX_AUTO_CORRECT_ATTEMPTS }),
      });
    } catch {}
    return;
  }

  // Trigger auto-correct for this epic.
  await triggerAutoCorrect({
    phone,
    task,
    session: freshSession,
    spec,
    longrunRoot,
    failedEpic: epic,
    failureOutput: runSummary,
    attempt: attempts + 1,
  });
}

// --- Internal functions ---

/**
 * Runs the validation step for a completed epic.
 * Builds a validation prompt from the epic's markdown and enqueues it as a run.
 */
async function runEpicValidation({ phone, task, session, spec, longrunRoot, epic }) {
  const epicFile = readEpicFile(longrunRoot, epic.uuid);
  const runnerKind = resolveRunnerForSession(taskStore.getLongrunSession(session.id));
  const validationPrompt = buildValidationPrompt({ epic, epicFile, projectCwd: session.project_cwd });

  // Mark session as currently running validation for this epic.
  taskStore.updateLongrunSession(session.id, {
    current_task_uuid: `validation:${epic.uuid}`,
  });

  await sendMessage(
    phone,
    `[LongRun] Validando epic: *${epic.title}*\nExecutando instrucoes de validacao...`
  );
  try {
    taskStore.insertTaskAuditLog({
      taskId: task.task_id,
      stage: 'longrun',
      level: 'info',
      event: 'epic_validation_dispatched',
      content: JSON.stringify({ epicUuid: epic.uuid, epicTitle: epic.title, runnerKind }),
    });
  } catch {}

  logger.info({ sessionId: session.id, epic: epic.title, runnerKind }, '[LongRun] running epic validation');

  await executor.enqueueTaskRun({
    phone,
    task,
    prompt: validationPrompt,
    runnerKind,
  });
}

/**
 * Creates an auto-correct epic from validation failure data,
 * inserts it into the execution plan, and resumes advancement.
 */
async function triggerAutoCorrect({ phone, task, session, spec, longrunRoot, failedEpic, failureOutput, attempt }) {
  taskStore.updateLongrunSession(session.id, { auto_correct_attempt: attempt });

  const autoCorrectEpic = buildAutoCorrectEpic({ failedEpic, failureOutput, attempt });
  const parentEpicGroupUuid = findEpicGroupForEpic(spec, failedEpic.uuid);
  const epicTasks = getTasksForEpic(spec, failedEpic.uuid);
  const afterTaskUuid = epicTasks.length > 0 ? epicTasks[epicTasks.length - 1].uuid : null;

  // Write files and update tasks.txt / validations.txt.
  insertAutoCorrectEpic(longrunRoot, {
    afterTaskUuid,
    parentEpicGroupUuid,
    autoCorrectEpic,
  });

  // Mutate in-memory spec so findEpicForTask works for the new auto-correct tasks.
  injectAutoCorrectEpicIntoSpec(spec, failedEpic.uuid, autoCorrectEpic);

  await sendMessage(
    phone,
    `[LongRun] Auto-correcao iniciada (tentativa ${attempt}/${MAX_AUTO_CORRECT_ATTEMPTS})\n` +
    `Epic com falha: *${failedEpic.title}*\n` +
    `Epic auto-correct criado: *auto-correct-${failedEpic.title}*\n\n` +
    `Retomando execucao...`
  );
  try {
    taskStore.insertTaskAuditLog({
      taskId: task.task_id,
      stage: 'longrun',
      level: 'warn',
      event: 'auto_correct_triggered',
      content: JSON.stringify({
        failedEpicUuid: failedEpic.uuid,
        failedEpicTitle: failedEpic.title,
        autoCorrectEpicUuid: autoCorrectEpic.uuid,
        attempt,
      }),
    });
  } catch {}

  logger.info(
    { sessionId: session.id, autoCorrectEpicUuid: autoCorrectEpic.uuid, attempt },
    '[LongRun] auto-correct epic injected, advancing'
  );

  await advanceLongrun({ phone, task, session, spec, longrunRoot });
}

/**
 * Marks the LongRun as completed and notifies the user.
 */
async function completeLongrun({ phone, session, spec }) {
  taskStore.updateLongrunSession(session.id, { status: 'completed', current_task_uuid: null });

  const validations = readValidationsList(getLongrunRoot(session.project_cwd, session.feature_uuid));
  const validated = validations.filter((v) => v.status === 'validated').length;
  const total = validations.length;

  await sendMessage(
    phone,
    `[LongRun] CONCLUIDO com sucesso!\n` +
    `Feature: *${spec.feature?.title || session.feature_title || '(sem titulo)'}*\n` +
    `Epics validados: ${validated}/${total}\n\n` +
    `Todas as tasks foram executadas e validadas.`
  );
  try {
    taskStore.insertTaskAuditLog({
      taskId: session.task_id,
      stage: 'longrun',
      level: 'info',
      event: 'longrun_completed',
      content: JSON.stringify({
        sessionId: session.id,
        featureTitle: spec.feature?.title || session.feature_title || null,
        validated,
        total,
      }),
    });
  } catch {}

  logger.info({ sessionId: session.id, feature: spec.feature?.title }, '[LongRun] completed');
}

// --- Prompt builders ---

/**
 * Builds a task execution prompt for the runner.
 * Instructs the runner to implement the task and commit with the correct message format.
 */
function buildTaskPrompt({ taskFile, taskUuid, epic, isLastTaskOfEpic, commitPrefix, projectCwd }) {
  return [
    `Voce esta executando uma task dentro de um LongRun (execucao automatica de feature).`,
    ``,
    `PROJETO: ${projectCwd}`,
    ``,
    `TASK A EXECUTAR:`,
    taskFile || `(uuid: ${taskUuid} — arquivo nao encontrado)`,
    ``,
    epic
      ? [
          `CONTEXTO DO EPIC:`,
          `Titulo: ${epic.title}`,
          epic.description ? `Descricao: ${epic.description}` : '',
        ].filter(Boolean).join('\n')
      : '',
    ``,
    `INSTRUCOES OBRIGATORIAS:`,
    `1. Implemente exatamente o que a task descreve — nem mais, nem menos.`,
    `2. Ao final, crie um commit com a mensagem: ${commitPrefix}<descricao-breve-da-mudanca>`,
    `   Exemplo: ${commitPrefix}implementar endpoint de login`,
    `3. Use a identidade git ja configurada no repositorio. Nao adicione trailers, coautoria ou atribuicao do Claude/IA no commit.`,
    isLastTaskOfEpic
      ? `4. Esta e a ULTIMA task do epic. Certifique-se de que toda a implementacao do epic esta integrada e funcionando antes de commitar.`
      : `4. Esta NAO e a ultima task do epic. Nao tente implementar o epic completo — apenas esta task.`,
    `5. O commit deve ser atomico: uma mudanca coesa que passe em lint/tests se aplicavel.`,
    `6. Nao inclua arquivos nao relacionados com esta task no commit.`,
  ].filter((l) => l !== undefined).join('\n');
}

/**
 * Builds an epic validation prompt for the runner.
 * Instructs the runner to run the validation steps and output VALIDATION_PASSED or VALIDATION_FAILED.
 */
function buildValidationPrompt({ epic, epicFile, projectCwd }) {
  return [
    `Voce esta executando a VALIDACAO de um epic LongRun.`,
    ``,
    `PROJETO: ${projectCwd}`,
    ``,
    `EPIC VALIDADO:`,
    epicFile || `Titulo: ${epic.title}\nUUID: ${epic.uuid}`,
    ``,
    `INSTRUCOES:`,
    `1. Execute TODAS as instrucoes de validacao descritas na secao "Validation Instructions" do epic acima.`,
    `2. Verifique se todos os criterios foram atendidos.`,
    `3. Ao final, responda OBRIGATORIAMENTE com UMA das seguintes linhas:`,
    `   VALIDATION_PASSED — se todas as validacoes passaram`,
    `   VALIDATION_FAILED: <motivo detalhado> — se alguma validacao falhou`,
    `4. Inclua o output dos testes/comandos de validacao como evidencia.`,
    ``,
    `IMPORTANTE: A linha VALIDATION_PASSED ou VALIDATION_FAILED deve estar no final da sua resposta.`,
  ].join('\n');
}

// --- Spec helpers ---

/**
 * Mutates the in-memory spec to insert the auto-correct epic after the failed epic.
 * This is needed so findEpicForTask() works correctly for new auto-correct task UUIDs.
 */
function injectAutoCorrectEpicIntoSpec(spec, failedEpicUuid, autoCorrectEpic) {
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      const idx = (eg?.epics || []).findIndex((e) => e.uuid === failedEpicUuid);
      if (idx >= 0) {
        eg.epics.splice(idx + 1, 0, {
          uuid: autoCorrectEpic.uuid,
          title: `auto-correct-${autoCorrectEpic.title}`,
          description: autoCorrectEpic.description,
          validation_instructions: autoCorrectEpic.validationInstructions,
          tasks: autoCorrectEpic.tasks,
        });
        return;
      }
    }
  }
}

/**
 * Builds an auto-correct epic descriptor from failure data.
 * @returns {{ uuid, title, description, validationInstructions, tasks }}
 */
function buildAutoCorrectEpic({ failedEpic, failureOutput, attempt }) {
  const uuid = crypto.randomUUID();
  const taskUuid = crypto.randomUUID();

  const failureSnippet = String(failureOutput || '(sem saida de falha)').slice(0, 2000);

  return {
    uuid,
    title: failedEpic.title,
    description: [
      `Auto-correcao do epic: ${failedEpic.title} (tentativa ${attempt}/${MAX_AUTO_CORRECT_ATTEMPTS})`,
      ``,
      `## O que era esperado`,
      failedEpic.description || '(sem descricao)',
      ``,
      `## Instrucoes de validacao originais`,
      failedEpic.validation_instructions || '(sem instrucoes)',
      ``,
      `## O que falhou`,
      failureSnippet,
      ``,
      `## Sugestoes de correcao`,
      `- Analise a saida de falha acima e identifique a causa raiz.`,
      `- Corrija o codigo ou configuracao que causou a falha.`,
      `- Garanta que as instrucoes de validacao do epic original sao satisfeitas apos a correcao.`,
    ].join('\n'),
    validationInstructions: failedEpic.validation_instructions || '',
    tasks: [
      {
        uuid: taskUuid,
        title: `Corrigir falhas de validacao — ${failedEpic.title}`,
        description: [
          `Esta task de auto-correcao deve resolver as falhas identificadas na validacao do epic "${failedEpic.title}".`,
          ``,
          `## Falhas identificadas`,
          failureSnippet,
          ``,
          `## Instrucoes`,
          `1. Analise a saida de falha acima.`,
          `2. Identifique e corrija a causa raiz.`,
          `3. Verifique localmente que a validacao agora passa.`,
          `4. Commite com a mensagem: fix(auto-correct-${failedEpic.title}): corrigir falhas de validacao`,
        ].join('\n'),
      },
    ],
  };
}

// --- Utility helpers ---

/**
 * Determines whether a validation run passed based on its summary text.
 * Looks for explicit VALIDATION_PASSED / VALIDATION_FAILED tokens first,
 * then falls back to heuristics.
 *
 * @param {string} summary - The summary text from the validation run
 * @returns {boolean}
 */
function inferValidationPassed(summary) {
  const s = String(summary || '');

  if (s.includes('VALIDATION_PASSED')) return true;
  if (s.includes('VALIDATION_FAILED')) return false;

  // Heuristic: if no explicit token found, look for common failure signals.
  const lower = s.toLowerCase();
  if (
    lower.includes('test failed') ||
    lower.includes('tests failed') ||
    lower.includes('assertion failed') ||
    lower.includes('error:') ||
    lower.includes('falhou') ||
    lower.includes('failure') ||
    lower.includes('exit code 1')
  ) {
    return false;
  }

  // If no failure signals found, assume pass (optimistic default).
  return true;
}

/**
 * Resolves the runner kind to use for the current session.
 * Uses preferred_runner if forced, otherwise first from runner_priority list.
 *
 * @param {object} session - longrun_sessions row
 * @returns {string} runner kind
 */
export function resolveRunnerForSession(session) {
  if (session?.preferred_runner) return session.preferred_runner;

  let priority = LONGRUN_RUNNER_PRIORITY;
  if (session?.runner_priority) {
    try {
      const parsed = JSON.parse(session.runner_priority);
      if (Array.isArray(parsed) && parsed.length > 0) priority = parsed;
    } catch {}
  }

  return priority[0] || 'claude-cli';
}

/**
 * Extracts the first heading from a markdown string.
 * Falls back to the raw string truncated to 80 chars.
 *
 * @param {string} mdContent
 * @returns {string}
 */
function extractFirstHeading(mdContent) {
  const match = String(mdContent || '').match(/^#+ (.+)$/m);
  return match ? match[1].trim() : String(mdContent || '').slice(0, 80).trim();
}
