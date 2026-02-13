const PLAN_SCHEMA = `{
  "version": 1,
  "action": "run" | "reply" | "set_project" | "set_runner" | "set_orchestrator" | "memory_append" | "memory_set" | "memory_clear" | "memory_show" | "project_add" | "project_mkdir" | "project_clone" | "project_scan",

  // when action = "reply"
  "reply_text": string,

  // when action = "run"
  "runner_kind": "codex-cli" | "gemini-cli" | "claude-cli" | "cursor-cli" | "desktop-agent",
  "prompt": string,

  // when action = "set_project"
  "project_id": string,
  "create_new_task"?: boolean,

  // when action = "set_runner"
  "runner_kind": "codex-cli" | "gemini-cli" | "claude-cli" | "cursor-cli" | "desktop-agent" | "auto",
  "scope"?: "task" | "user" | "global",

  // when action = "set_orchestrator"
  "provider": "gemini-cli" | "openrouter" | "auto",
  "scope"?: "user" | "global",

  // when action = "project_add"
  "id": string,
  "cwd": string,
  "type"?: string,
  "name"?: string,

  // when action = "project_mkdir"
  "id": string,
  "dir": string,
  "type"?: string,
  "name"?: string,

  // when action = "project_clone"
  "id": string,
  "git_url": string,
  "dir"?: string,
  "depth"?: number,
  "type"?: string,
  "name"?: string,

  // when action = "memory_append" | "memory_set"
  "memory_text": string,

  // optional
  "title"?: string
}`;

function formatContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '(sem contexto anterior)';

  const lines = [];
  for (const m of messages) {
    const role = m.role || 'user';
    const content = String(m.content || '').trim();
    if (!content) continue;
    lines.push(`[${role}] ${content}`);
  }

  return lines.length > 0 ? lines.join('\n') : '(sem contexto anterior)';
}

function formatProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return '(nenhum projeto carregado)';
  const max = 25;
  const lines = [];
  for (const p of projects.slice(0, max)) {
    const id = p?.id || '';
    const name = p?.name || '';
    if (!id) continue;
    lines.push(`- ${id}${name && name !== id ? ` (${name})` : ''}`);
  }
  const extra = projects.length > max ? `\n(+${projects.length - max} outros)` : '';
  return lines.join('\n') + extra;
}

export function buildPlannerMessages({
  userMessage,
  contextMessages,
  taskId,
  projectId,
  forcedRunnerKind,
  defaultRunnerKind,
  projects,
  sharedMemory,
}) {
  const system = [
    'Voce e o orquestrador principal do "morpheus".',
    'Sua saida DEVE ser APENAS um unico JSON valido (sem markdown, sem texto extra).',
    'Nao execute ferramentas, nao rode comandos, nao leia arquivos. Apenas planeje.',
    '',
    'Quando a mensagem do usuario for apenas um cumprimento (ex.: "oi", "ola", "bom dia") ou estiver vaga, use action="reply" e responda curto com instrucoes (/help, /status, /projects, /runner, /orchestrator).',
    'Quando for um pedido de trabalho, use action="run" e gere um prompt claro e completo (em PT-BR) para o runner executar com o workspace do projeto como contexto.',
    '',
    'Escolha do runner_kind (muito importante):',
    '- Use runner_kind="desktop-agent" quando o pedido exigir acoes na interface do computador: abrir apps, navegar em sites, clicar, preencher campos, ler conteudo visual, tirar prints/screenshot, verificar algo "na tela".',
    '- Use runner_kind="desktop-agent" tambem quando o usuario pedir explicitamente imagens/prints como evidencia.',
    '- Caso contrario, prefira o runner default (codex/claude/cursor/gemini) para tarefas de codigo e shell.',
    'Importante: o runner pode usar caminhos fora do projeto (ex.: criar/alterar coisas em DEVELOPMENT_ROOT) quando isso for necessario para cumprir o pedido. Seja explicito com paths absolutos e passos de validacao.',
    '',
    'Quando o usuario pedir algo de configuracao em linguagem natural (sem comandos /...):',
    '- Trocar de projeto: use action="set_project" (nao use action="run").',
    '- Trocar runner: use action="set_runner" (scope "task" quando for so para esta task; "user" para preferencia do usuario; "global" apenas se o usuario for admin).',
    '- Trocar orchestrator/planner: use action="set_orchestrator" (scope "user" ou "global").',
    '- Memoria compartilhada: use action="memory_append" para adicionar uma preferencia/definicao; use action="memory_set" para substituir toda memoria; use action="memory_clear" para limpar; use action="memory_show" para mostrar.',
    '- Criar/registrar projetos (admin): use action="project_mkdir" / "project_clone" / "project_add" / "project_scan".',
    '- Para project_mkdir/project_clone: prefira `dir` relativo ao DEVELOPMENT_ROOT, mas path absoluto tambem e permitido se o usuario pediu.',
    'Regras:',
    '- Se action="reply": reply_text e obrigatorio.',
    '- Se action="run": prompt e runner_kind sao obrigatorios e runner_kind deve ser um dos runners suportados.',
    '',
    'Schema do JSON:',
    PLAN_SCHEMA,
    '',
    `Runner preferido (nao obrigatorio): "${defaultRunnerKind}". Se action="run", escolha explicitamente um runner_kind (nao omita).`,
  ].join('\n');

  const user = [
    `task_id: ${taskId}`,
    `project_id: ${projectId}`,
    '',
    'Memoria compartilhada (entre tasks/projetos/runners):',
    sharedMemory && String(sharedMemory).trim() ? String(sharedMemory).trim() : '(vazia)',
    '',
    'Projetos disponiveis (parcial):',
    formatProjects(projects),
    '',
    'Contexto recente (task-scoped):',
    formatContext(contextMessages),
    '',
    'Mensagem atual do usuario:',
    userMessage,
  ].join('\n');

  return { system, user };
}
