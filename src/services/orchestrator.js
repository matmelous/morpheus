import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { parseFirstJsonObject } from '../planner/json.js';
import { validatePlan } from '../planner/schema.js';
import { buildPlannerMessages } from '../planner/prompt.js';
import { planWithGeminiCli } from '../planner/gemini-cli.js';
import { planWithOpenRouter } from '../planner/openrouter.js';
import { planWithCodexCli } from '../planner/codex-cli.js';
import { isRunnerKindSupported, listRunnerCatalog, listSupportedRunnerKinds } from '../runners/index.js';
import { taskStore } from './task-store.js';
import { getOrchestratorProviderDefault, getRunnerDefault } from './settings.js';
import { projectManager } from './project-manager.js';
import { buildMemorySections } from './memory-context.js';
import {
  compactPlannerPayload,
  estimateTokensFromText,
  estimateUsage,
  logBudgetCompaction,
  logTokenUsage,
  logUsageFallbackEstimate,
  normalizeTokenUsage,
} from './token-meter.js';

const geminiCircuit = {
  untilMs: 0,
  reason: null,
  lastError: null,
};

function classifyGeminiFailure(message) {
  const m = String(message || '').toLowerCase();

  if (
    m.includes('no capacity available') ||
    m.includes('resource_exhausted') ||
    m.includes('ratelimitexceeded') ||
    m.includes('rate limit') ||
    m.includes('http 429') ||
    m.includes('status 429') ||
    (m.includes('exited with code') && m.includes('429'))
  ) {
    return { kind: 'capacity', cooldownMs: 10 * 60 * 1000 };
  }

  if (
    m.includes("you've hit your usage limit") ||
    m.includes('usage limit') ||
    m.includes('quota') ||
    m.includes('insufficient_quota')
  ) {
    return { kind: 'quota', cooldownMs: 60 * 60 * 1000 };
  }

  return null;
}

function normalizeProvider(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'openrouter') return 'openrouter';
  if (v === 'gemini-cli') return 'gemini-cli';
  if (v === 'codex-cli') return 'codex-cli';
  if (v === 'auto') return 'auto';
  return null;
}

function shouldReplyAsGreeting(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return [
    'oi', 'ola', 'olá',
    'bom dia', 'boa tarde', 'boa noite',
    'hello', 'hi', 'hey',
  ].includes(t);
}

function buildPlannerPromptPayload({
  userMessage,
  contextMessages,
  globalChatHistory,
  taskId,
  projectId,
  forcedRunnerKind,
  defaultRunnerKind,
  runnerKinds,
  runnerCatalog,
  projects,
  sharedMemory,
  longrunSession,
}) {
  const { system, user } = buildPlannerMessages({
    userMessage,
    contextMessages,
    globalChatHistory,
    taskId,
    projectId,
    forcedRunnerKind,
    defaultRunnerKind,
    runnerKinds,
    runnerCatalog,
    projects,
    sharedMemory,
    longrunSession,
  });

  return {
    system,
    userPrompt: user,
    estimatedInputTokens: estimateTokensFromText(`${system}\n\n${user}`),
  };
}

export async function orchestrateTaskMessage({
  phone,
  task,
  userMessage,
  preferredRunnerKind,
  longrunSession = null,
}) {
  const user = taskStore.getUser(phone);
  const originalSharedMemory = taskStore.getUserSharedMemory(phone)?.content || '';
  const originalProjectMemory = taskStore.getProjectMemory(task.project_id, phone)?.content || '';
  const originalMemoryContext = buildMemorySections({
    sharedMemory: originalSharedMemory,
    projectMemory: originalProjectMemory,
    projectId: task.project_id,
  });
  const globalHistoryLimit = 10;
  const incomingMessage = String(userMessage || '').trim();
  const rawGlobalChatHistory = taskStore.listChatHistory(phone, { limit: globalHistoryLimit });
  const filteredGlobalChatHistory = rawGlobalChatHistory.filter((row, idx) => {
    if (idx !== 0) return true;
    return !(
      String(row?.role || '') === 'user'
      && String(row?.task_id || '') === String(task.task_id)
      && String(row?.content || '').trim() === incomingMessage
    );
  });
  const providerPref = normalizeProvider(user?.orchestrator_provider_override)
    || normalizeProvider(getOrchestratorProviderDefault())
    || normalizeProvider(config.orchestratorProvider)
    || 'gemini-cli';

  const globalRunnerDefault = (getRunnerDefault() || config.runnerDefault || 'codex-cli').toLowerCase();
  const forcedRunnerKind = (() => {
    const normalized = String(preferredRunnerKind || '').toLowerCase();
    if (!normalized || normalized === 'auto') return null;
    return isRunnerKindSupported(normalized) ? normalized : null;
  })();
  const defaultRunnerKind = (() => {
    const v = forcedRunnerKind || globalRunnerDefault;
    if (!v || v === 'auto') return 'codex-cli';
    const normalized = String(v).toLowerCase();
    return isRunnerKindSupported(normalized) ? normalized : 'codex-cli';
  })();

  if (shouldReplyAsGreeting(userMessage)) {
    const reply = `Oi! Me diga o que voce quer fazer no projeto *${task.project_id}*.\n\n` +
      `Comandos uteis:\n` +
      `/help\n/status\n/projects\n/project <id>\n/runner <kind>\n/orchestrator <provider>\n\n` +
      `Tambem pode falar em linguagem natural, ex.:\n` +
      `- "troca pro projeto argo"\n` +
      `- "usa runner claude nesta task"\n` +
      `- "muda orchestrator para openrouter/codex-cli"`;

    return {
      plan: { version: 1, action: 'reply', reply_text: reply },
      providerUsed: 'local-heuristic',
      usedFallback: false,
      tokenUsagePlanner: { inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 'estimated' },
      taskTokenTotals: taskStore.sumTokensByTask(task.task_id),
    };
  }

  const taskTotalsBefore = taskStore.sumTokensByTask(task.task_id);
  const plannerCallBudget = Math.max(1, Number(config.token.budgetPlannerPerCall || 12000));
  const taskBudgetTotal = Math.max(plannerCallBudget, Number(config.token.budgetTaskTotal || 120000));
  const taskBudgetRemaining = Math.max(0, taskBudgetTotal - Number(taskTotalsBefore?.totalTokens || 0));
  const budgetBefore = Math.max(1, Math.min(plannerCallBudget, taskBudgetRemaining || plannerCallBudget));

  const rawContextMessages = taskStore.listTaskMessages(task.task_id, config.plannerMaxContextMessages);
  const runnerKinds = listSupportedRunnerKinds({ includeAuto: true });
  const runnerCatalog = listRunnerCatalog({ includeAuto: true });
  let effectiveContextMessages = rawContextMessages;
  let effectiveSharedMemory = originalMemoryContext;

  let promptPayload = buildPlannerPromptPayload({
    userMessage,
    contextMessages: effectiveContextMessages,
    globalChatHistory: filteredGlobalChatHistory,
    taskId: task.task_id,
    projectId: task.project_id,
    forcedRunnerKind,
    defaultRunnerKind,
    runnerKinds,
    runnerCatalog,
    projects: projectManager.listProjects(),
    sharedMemory: effectiveSharedMemory,
    longrunSession,
  });
  const projectedBeforeCompaction = promptPayload.estimatedInputTokens;

  let compactionMeta = null;
  if (promptPayload.estimatedInputTokens > budgetBefore) {
    const compacted = compactPlannerPayload({
      contextMessages: rawContextMessages,
      sharedMemory: originalMemoryContext,
      plannerMaxContextMessages: config.plannerMaxContextMessages,
      tokenBudgetPlannerPerCall: budgetBefore,
      tokenBudgetSharedMemoryMax: config.token.budgetSharedMemoryMax,
    });

    effectiveContextMessages = compacted.contextMessages;
    effectiveSharedMemory = compacted.sharedMemory;
    compactionMeta = compacted.meta;

    promptPayload = buildPlannerPromptPayload({
      userMessage,
      contextMessages: effectiveContextMessages,
      globalChatHistory: filteredGlobalChatHistory,
      taskId: task.task_id,
      projectId: task.project_id,
      forcedRunnerKind,
      defaultRunnerKind,
      runnerKinds,
      runnerCatalog,
      projects: projectManager.listProjects(),
      sharedMemory: effectiveSharedMemory,
      longrunSession,
    });

    logBudgetCompaction({
      task_id: task.task_id,
      phone,
      stage: 'planner',
      budget_before: budgetBefore,
      projected_before: projectedBeforeCompaction,
      projected_after: promptPayload.estimatedInputTokens,
      meta: compactionMeta,
    });
  }

  const { system, userPrompt } = promptPayload;

  const providersToTry = [];
  const now = Date.now();
  const geminiInCooldown = providerPref !== 'openrouter' && providerPref !== 'codex-cli' && geminiCircuit.untilMs && now < geminiCircuit.untilMs;

  if (providerPref === 'codex-cli') {
    providersToTry.push('codex-cli');
  } else if (providerPref === 'openrouter' || geminiInCooldown) {
    providersToTry.push('openrouter');
  } else {
    providersToTry.push('gemini-cli', 'openrouter');
  }

  const errors = [];

  for (const provider of providersToTry) {
    try {
      try {
        taskStore.insertTaskAuditLog({
          taskId: task.task_id,
          stage: 'planner',
          level: 'info',
          event: 'provider_attempt',
          content: provider,
          metaJson: JSON.stringify({
            providersToTry,
            forcedRunnerKind: forcedRunnerKind || null,
            defaultRunnerKind,
            budgetBefore,
          }),
        });
      } catch {}

      let assistantText = '';
      let providerMeta = {};
      let providerUsage = null;

      if (provider === 'gemini-cli') {
        const result = await planWithGeminiCli({
          promptText: `${system}\n\n${userPrompt}`,
          timeoutMs: config.plannerTimeoutMs,
          config,
        });
        assistantText = result.assistantText;
        providerMeta = { model: result.model, sessionId: result.sessionId };
        providerUsage = normalizeTokenUsage(result.usage, 'provider');
      } else if (provider === 'codex-cli') {
        const result = await planWithCodexCli({
          systemPrompt: system,
          userPrompt,
          timeoutMs: config.plannerTimeoutMs,
          config,
        });
        assistantText = result.assistantText;
        providerMeta = { model: result.model };
        providerUsage = normalizeTokenUsage(result.usage, 'provider');
      } else if (provider === 'openrouter') {
        const result = await planWithOpenRouter({
          systemPrompt: system,
          userPrompt,
          timeoutMs: config.plannerTimeoutMs,
          config,
        });
        assistantText = result.assistantText;
        providerMeta = { model: result.model };
        providerUsage = normalizeTokenUsage(result.usage || result.raw, 'provider');
      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }

      const raw = parseFirstJsonObject(assistantText);
      let plan = validatePlan(raw);

      if (plan.action === 'run') {
        if (!plan.runner_kind) plan = { ...plan, runner_kind: defaultRunnerKind };
      }

      const finalUsage = providerUsage || estimateUsage({
        inputText: `${system}\n\n${userPrompt}`,
        outputText: assistantText,
      });

      if (!providerUsage) {
        logUsageFallbackEstimate({
          task_id: task.task_id,
          stage: 'planner',
          provider,
          model: providerMeta.model || null,
        });
      }

      const budgetAfter = Math.max(0, taskBudgetRemaining - Number(finalUsage.totalTokens || 0));
      taskStore.insertTokenUsageEvent({
        phone,
        taskId: task.task_id,
        runId: null,
        stage: 'planner',
        provider,
        model: providerMeta.model || null,
        inputTokens: finalUsage.inputTokens,
        outputTokens: finalUsage.outputTokens,
        totalTokens: finalUsage.totalTokens,
        source: finalUsage.source || 'estimated',
        budgetBefore,
        budgetAfter,
        compacted: Boolean(compactionMeta),
        metaJson: JSON.stringify({ providersTried: providersToTry, providerErrors: errors, compactionMeta }),
      });

      const taskTokenTotals = taskStore.sumTokensByTask(task.task_id);
      taskStore.updateTaskTokenTotals(task.task_id, taskTokenTotals);

      logTokenUsage({
        task_id: task.task_id,
        run_id: null,
        phone,
        provider,
        model: providerMeta.model || null,
        stage: 'planner',
        input_tokens: finalUsage.inputTokens,
        output_tokens: finalUsage.outputTokens,
        total_tokens: finalUsage.totalTokens,
        source: finalUsage.source || 'estimated',
        budget_before: budgetBefore,
        budget_after: budgetAfter,
        compacted: Boolean(compactionMeta),
      });

      const firstProvider = providersToTry[0];
      try {
        taskStore.insertTaskAuditLog({
          taskId: task.task_id,
          stage: 'planner',
          level: 'info',
          event: 'provider_success',
          content: JSON.stringify({
            provider,
            model: providerMeta.model || null,
            usedFallback: provider !== firstProvider,
            action: plan?.action || null,
            runner_kind: plan?.runner_kind || null,
          }),
          metaJson: JSON.stringify({
            usage: finalUsage,
            compactionMeta,
          }),
        });
      } catch {}

      return {
        plan,
        providerUsed: provider,
        providerMeta,
        usedFallback: provider !== firstProvider,
        previousErrors: provider !== firstProvider ? errors : [],
        circuitBreaker: (provider === 'openrouter' && geminiInCooldown)
          ? { geminiSkipUntilMs: geminiCircuit.untilMs, geminiSkipReason: geminiCircuit.reason }
          : null,
        tokenUsagePlanner: finalUsage,
        taskTokenTotals,
      };
    } catch (err) {
      try {
        taskStore.insertTaskAuditLog({
          taskId: task.task_id,
          stage: 'planner',
          level: 'warn',
          event: 'provider_failed',
          content: err?.message || String(err),
          metaJson: JSON.stringify({ provider }),
        });
      } catch {}
      if (provider === 'gemini-cli') {
        const cls = classifyGeminiFailure(err?.message || String(err));
        if (cls) {
          geminiCircuit.untilMs = Date.now() + cls.cooldownMs;
          geminiCircuit.reason = cls.kind;
          geminiCircuit.lastError = err?.message || String(err);
        }
      }
      errors.push({ provider, error: err?.message || String(err) });
      logger.warn({ provider, error: err?.message }, 'Planner provider failed');
    }
  }

  const msg = errors.map((e) => `${e.provider}: ${e.error}`).join(' | ');
  throw new Error(`Planner failed: ${msg}`);
}

export default { orchestrateTaskMessage };
