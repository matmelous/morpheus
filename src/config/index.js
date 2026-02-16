import dotenv from 'dotenv';
import { z } from 'zod';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseBool, parseCsvList } from '../utils/text.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '../..');

const RunnerKindSchema = z.enum(['codex-cli', 'cursor-cli', 'gemini-cli', 'claude-cli', 'desktop-agent', 'auto']);
const OrchestratorProviderSchema = z.enum(['gemini-cli', 'openrouter', 'auto']);
const TokenEstimatorModeSchema = z.enum(['provider_fallback_estimate']);
const TokenNotificationLevelSchema = z.enum(['summary']);

const EnvSchema = z.object({
  APP_PORT: z.coerce.number().int().positive().default(3200),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),

  DEVELOPMENT_ROOT: z.string().optional().default('/Users/matheus/development/development'),

  WHATSAPP_INSTANCE_ID: z.string().optional().default('morpheus-standalone'),
  WHATSAPP_AUTH_DIR: z.string().optional().default('./data/whatsapp-auth'),

  ALLOWED_PHONE_NUMBERS: z.string().min(1),
  ADMIN_PHONE_NUMBERS: z.string().optional().default(''),

  DEFAULT_PROJECT_ID: z.string().optional().default(''),

  ORCHESTRATOR_PROVIDER: OrchestratorProviderSchema.optional().default('gemini-cli'),

  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODEL: z.string().optional().default('google/gemini-3-pro-preview'),
  OPENROUTER_BASE_URL: z.string().optional().default('https://openrouter.ai/api/v1'),

  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_TRANSCRIBE_MODEL: z.string().optional().default('whisper-1'),

  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  GEMINI_CLI_COMMAND: z.string().optional().default(''),
  GEMINI_MODEL: z.string().optional().default('gemini-3-pro-preview'),
  GEMINI_OUTPUT_FORMAT: z.string().optional().default('stream-json'),
  GEMINI_APPROVAL_MODE: z.string().optional().default('auto_edit'),

  RUNNER_DEFAULT: RunnerKindSchema.optional().default('codex-cli'),

  CODEX_CLI_COMMAND: z.string().optional().default(''),
  CLAUDE_CLI_COMMAND: z.string().optional().default(''),
  CURSOR_AGENT_COMMAND: z.string().optional().default(''),

  CLAUDE_MODEL: z.string().optional().default('sonnet'),
  CLAUDE_PERMISSION_MODE: z.string().optional().default('bypassPermissions'),
  CLAUDE_OUTPUT_FORMAT: z.string().optional().default('stream-json'),
  CLAUDE_VERBOSE: z.string().optional().default('true'),

  CODEX_SANDBOX_MODE: z.string().optional().default('danger-full-access'),
  CODEX_SKIP_GIT_REPO_CHECK: z.string().optional().default('true'),
  CODEX_USE_DANGEROUSLY_BYPASS_APPROVALS: z.string().optional().default('false'),

  CURSOR_OUTPUT_FORMAT: z.string().optional().default('stream-json'),
  CURSOR_MODEL: z.string().optional().default('auto'),
  CURSOR_FORCE: z.string().optional().default('true'),

  MAX_PARALLEL_TASKS: z.coerce.number().int().positive().default(10),
  MAX_PARALLEL_GUI_TASKS: z.coerce.number().int().positive().default(1),
  TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
  PENDING_SELECTION_TTL_MS: z.coerce.number().int().positive().default(120000),

  REPORT_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60000),

  PLANNER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  PLANNER_MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(12),
  TOKEN_BUDGET_PLANNER_PER_CALL: z.coerce.number().int().positive().default(12000),
  TOKEN_BUDGET_TASK_TOTAL: z.coerce.number().int().positive().default(120000),
  TOKEN_BUDGET_SHARED_MEMORY_MAX: z.coerce.number().int().positive().default(3000),
  TOKEN_ESTIMATOR_MODE: TokenEstimatorModeSchema.optional().default('provider_fallback_estimate'),
  TOKEN_NOTIFICATION_LEVEL: TokenNotificationLevelSchema.optional().default('summary'),

  SQLITE_DB_PATH: z.string().optional().default('./data/pmi.sqlite'),
  RUNS_DIR: z.string().optional().default('./runs'),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
});

const env = EnvSchema.parse(process.env);

const allowedPhoneNumbers = parseCsvList(env.ALLOWED_PHONE_NUMBERS);
if (allowedPhoneNumbers.length === 0) {
  throw new Error('ALLOWED_PHONE_NUMBERS must contain at least one phone number');
}

export const config = {
  appRoot,

  nodeEnv: env.NODE_ENV,
  port: env.APP_PORT,
  logLevel: env.LOG_LEVEL,

  developmentRoot: resolve(env.DEVELOPMENT_ROOT),

  whatsappInstanceId: env.WHATSAPP_INSTANCE_ID,
  whatsappAuthDir: resolve(appRoot, env.WHATSAPP_AUTH_DIR),

  allowedPhoneNumbers,
  adminPhoneNumbers: parseCsvList(env.ADMIN_PHONE_NUMBERS),

  defaultProjectId: env.DEFAULT_PROJECT_ID,

  orchestratorProvider: env.ORCHESTRATOR_PROVIDER,
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL,
  },

  openai: {
    apiKey: env.OPENAI_API_KEY,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
  },

  media: {
    maxBytes: env.MEDIA_MAX_BYTES,
  },

  gemini: {
    command: env.GEMINI_CLI_COMMAND || 'gemini',
    model: env.GEMINI_MODEL,
    outputFormat: env.GEMINI_OUTPUT_FORMAT,
    approvalMode: env.GEMINI_APPROVAL_MODE,
  },

  runnerDefault: env.RUNNER_DEFAULT,

  claude: {
    command: env.CLAUDE_CLI_COMMAND || 'claude',
    model: env.CLAUDE_MODEL,
    permissionMode: env.CLAUDE_PERMISSION_MODE,
    outputFormat: env.CLAUDE_OUTPUT_FORMAT,
    verbose: parseBool(env.CLAUDE_VERBOSE, true),
  },

  codex: {
    command: env.CODEX_CLI_COMMAND || 'codex',
    sandboxMode: env.CODEX_SANDBOX_MODE,
    skipGitRepoCheck: parseBool(env.CODEX_SKIP_GIT_REPO_CHECK, true),
    useDangerouslyBypassApprovals: parseBool(env.CODEX_USE_DANGEROUSLY_BYPASS_APPROVALS, false),
  },

  cursor: {
    command: env.CURSOR_AGENT_COMMAND || 'cursor-agent',
    outputFormat: env.CURSOR_OUTPUT_FORMAT,
    model: env.CURSOR_MODEL,
    force: parseBool(env.CURSOR_FORCE, true),
  },

  maxParallelTasks: env.MAX_PARALLEL_TASKS,
  maxParallelGuiTasks: env.MAX_PARALLEL_GUI_TASKS,
  taskTimeoutMs: env.TASK_TIMEOUT_MS,
  pendingSelectionTtlMs: env.PENDING_SELECTION_TTL_MS,

  reportIntervalMs: env.REPORT_INTERVAL_MS,

  plannerTimeoutMs: env.PLANNER_TIMEOUT_MS,
  plannerMaxContextMessages: env.PLANNER_MAX_CONTEXT_MESSAGES,
  token: {
    budgetPlannerPerCall: env.TOKEN_BUDGET_PLANNER_PER_CALL,
    budgetTaskTotal: env.TOKEN_BUDGET_TASK_TOTAL,
    budgetSharedMemoryMax: env.TOKEN_BUDGET_SHARED_MEMORY_MAX,
    estimatorMode: env.TOKEN_ESTIMATOR_MODE,
    notificationLevel: env.TOKEN_NOTIFICATION_LEVEL,
  },

  sqliteDbPath: resolve(appRoot, env.SQLITE_DB_PATH),
  runsDir: resolve(appRoot, env.RUNS_DIR),
  artifactRetentionDays: env.ARTIFACT_RETENTION_DAYS,
};

export function validateConfig() {
  return true;
}

export default config;
