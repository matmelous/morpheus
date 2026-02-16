import { z } from 'zod';

export const RunnerKindSchema = z.string().trim().min(1);
export const OrchestratorProviderSchema = z.enum(['gemini-cli', 'openrouter', 'auto']);
export const PlanActionSchema = z.enum([
  'run',
  'reply',

  // natural-language "commands" handled locally by the orchestrator
  'set_project',
  'set_runner',
  'set_orchestrator',
  'set_task_policy',
  'memory_append',
  'memory_set',
  'memory_clear',
  'memory_show',

  // admin project management
  'project_add',
  'project_mkdir',
  'project_clone',
  'project_scan',
]);

export const PlanSchema = z.object({
  version: z.coerce.number().int().optional().default(1),
  action: PlanActionSchema,

  // action=reply
  reply_text: z.string().optional(),

  // action=run
  runner_kind: RunnerKindSchema.optional(),
  prompt: z.string().optional(),

  // action=set_project
  project_id: z.string().optional(),
  create_new_task: z.coerce.boolean().optional(),

  // action=set_runner
  scope: z.enum(['task', 'user', 'global']).optional(),

  // action=set_orchestrator
  provider: OrchestratorProviderSchema.optional(),

  // action=set_task_policy
  task_id_length: z.coerce.number().int().positive().optional(),
  project_task_history_limit: z.coerce.number().int().positive().optional(),

  // action=project_add
  id: z.string().optional(),
  cwd: z.string().optional(),

  // action=project_mkdir
  dir: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),

  // action=project_clone
  git_url: z.string().optional(),
  depth: z.coerce.number().int().positive().optional(),

  // optional metadata
  title: z.string().optional(),

  // action=memory_*
  memory_text: z.string().optional(),
});

export function validatePlan(raw) {
  const plan = PlanSchema.parse(raw);

  if (plan.action === 'reply') {
    if (!plan.reply_text || !plan.reply_text.trim()) {
      throw new Error('Invalid plan: reply_text is required for action=reply');
    }
  } else if (plan.action === 'run') {
    if (!plan.prompt || !plan.prompt.trim()) throw new Error('Invalid plan: prompt is required for action=run');
  } else if (plan.action === 'set_project') {
    if (!plan.project_id || !String(plan.project_id).trim()) throw new Error('Invalid plan: project_id is required for action=set_project');
  } else if (plan.action === 'set_runner') {
    if (!plan.runner_kind) throw new Error('Invalid plan: runner_kind is required for action=set_runner');
  } else if (plan.action === 'set_orchestrator') {
    if (!plan.provider) throw new Error('Invalid plan: provider is required for action=set_orchestrator');
  } else if (plan.action === 'set_task_policy') {
    if (plan.task_id_length == null && plan.project_task_history_limit == null) {
      throw new Error('Invalid plan: task_id_length or project_task_history_limit is required for action=set_task_policy');
    }
  } else if (plan.action === 'project_add') {
    if (!plan.id || !String(plan.id).trim()) throw new Error('Invalid plan: id is required for action=project_add');
    if (!plan.cwd || !String(plan.cwd).trim()) throw new Error('Invalid plan: cwd is required for action=project_add');
  } else if (plan.action === 'project_mkdir') {
    if (!plan.id || !String(plan.id).trim()) throw new Error('Invalid plan: id is required for action=project_mkdir');
    if (!plan.dir || !String(plan.dir).trim()) throw new Error('Invalid plan: dir is required for action=project_mkdir');
  } else if (plan.action === 'project_clone') {
    if (!plan.id || !String(plan.id).trim()) throw new Error('Invalid plan: id is required for action=project_clone');
    if (!plan.git_url || !String(plan.git_url).trim()) throw new Error('Invalid plan: git_url is required for action=project_clone');
  } else if (plan.action === 'project_scan') {
    // no required fields
  } else if (plan.action === 'memory_append') {
    if (!plan.memory_text || !String(plan.memory_text).trim()) throw new Error('Invalid plan: memory_text is required for action=memory_append');
  } else if (plan.action === 'memory_set') {
    if (!plan.memory_text || !String(plan.memory_text).trim()) throw new Error('Invalid plan: memory_text is required for action=memory_set');
  } else if (plan.action === 'memory_clear') {
    // no required fields
  } else if (plan.action === 'memory_show') {
    // no required fields
  }

  return plan;
}
