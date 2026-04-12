function clipLine(value, maxLen = 160) {
  const text = normalizeSpaces(value);
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function compactDisplayPath(path) {
  const normalized = normalizeSpaces(path).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) return '';

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return parts.slice(-3).join('/');
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isNoiseStatus(text) {
  const normalized = normalizeSpaces(text).toLowerCase();
  return [
    'na fila',
    'em execucao',
    'concluido',
    'cancelado',
    'erro',
    'preparando runner',
    'preparando execucao',
    'finalizando resposta',
    'resposta enviada',
  ].includes(normalized);
}

function pushUnique(list, value, maxItems = 4) {
  const clean = normalizeSpaces(value);
  if (!clean || list.includes(clean) || list.length >= maxItems) return;
  list.push(clean);
}

function classifyProgressUpdate(update) {
  const text = normalizeSpaces(update);
  const lower = text.toLowerCase();
  if (!text) return { kind: 'empty' };

  if (lower === 'listando arquivos do projeto') return { kind: 'list' };
  if (lower === 'buscando no codigo do projeto') return { kind: 'search' };
  if (lower === 'lendo arquivos do projeto') return { kind: 'read' };
  if (lower.startsWith('lendo arquivo:')) return { kind: 'read', path: text.slice('Lendo arquivo:'.length).trim() };
  if (lower.startsWith('editando arquivo:')) return { kind: 'edit', path: text.slice('Editando arquivo:'.length).trim() };
  if (lower.startsWith('escrevendo arquivo:')) return { kind: 'write', path: text.slice('Escrevendo arquivo:'.length).trim() };
  if (lower === 'rodando testes do projeto') return { kind: 'test' };
  if (lower.startsWith('executando comando')) return { kind: 'command' };
  if (lower.startsWith('executando script auxiliar:')) return { kind: 'command' };
  if (lower.startsWith('executando git ')) return { kind: 'command' };
  if (lower.startsWith('usando ferramenta:')) return { kind: 'tool' };
  if (lower.startsWith('aviso do runner:')) return { kind: 'warning', text };
  if (lower.startsWith('bloqueado')) return { kind: 'warning', text };
  if (lower.startsWith('projeto alterado para ')) return { kind: 'project' };
  if (isNoiseStatus(text)) return { kind: 'noise' };
  return { kind: 'assistant', text };
}

function formatActivityCounts(stats) {
  const parts = [];

  const exploredCount = Number(stats.list || 0) + Number(stats.read || 0);
  if (exploredCount > 0) parts.push(`${exploredCount} leitura${exploredCount === 1 ? '' : 's'}`);

  const searchCount = Number(stats.search || 0);
  if (searchCount > 0) parts.push(`${searchCount} busca${searchCount === 1 ? '' : 's'}`);

  const touchedCount = Number(stats.edit || 0) + Number(stats.write || 0);
  if (touchedCount > 0) parts.push(`${touchedCount} arquivo${touchedCount === 1 ? '' : 's'} alterado${touchedCount === 1 ? '' : 's'}`);

  const testCount = Number(stats.test || 0);
  if (testCount > 0) parts.push(`${testCount} rodada${testCount === 1 ? '' : 's'} de teste`);

  const commandCount = Number(stats.command || 0);
  if (commandCount > 0) parts.push(`${commandCount} comando${commandCount === 1 ? '' : 's'}`);

  return parts;
}

export function getLatestMeaningfulRunUpdate(rows, { maxChars = 220 } = {}) {
  const updates = Array.isArray(rows)
    ? rows
      .map((row) => {
        if (typeof row === 'string') return row;
        if (row && typeof row === 'object') return row.content;
        return '';
      })
      .map((text) => normalizeSpaces(text))
      .filter(Boolean)
    : [];

  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const update = updates[index];
    const classified = classifyProgressUpdate(update);
    if (classified.kind === 'empty' || classified.kind === 'noise') continue;
    if (classified.kind === 'assistant' && classified.text) return clipLine(classified.text, maxChars);
    if (classified.kind === 'warning' && classified.text) return clipLine(classified.text, maxChars);
    return clipLine(update, maxChars);
  }

  return '';
}

export function summarizeRecentRunActivity(rows, { maxFiles = 3, maxAssistantChars = 220 } = {}) {
  const updates = Array.isArray(rows)
    ? rows
      .map((row) => {
        if (typeof row === 'string') return row;
        if (row && typeof row === 'object') return row.content;
        return '';
      })
      .map((text) => normalizeSpaces(text))
      .filter(Boolean)
    : [];

  if (updates.length === 0) return [];

  const stats = {
    list: 0,
    search: 0,
    read: 0,
    edit: 0,
    write: 0,
    test: 0,
    command: 0,
  };
  const touchedFiles = [];
  let latestAssistant = '';
  let latestWarning = '';

  for (const update of updates) {
    const classified = classifyProgressUpdate(update);

    if (classified.kind === 'assistant' && classified.text) {
      latestAssistant = clipLine(classified.text, maxAssistantChars);
      continue;
    }

    if (classified.kind === 'warning' && classified.text) {
      latestWarning = clipLine(classified.text, maxAssistantChars);
      continue;
    }

    if (Object.hasOwn(stats, classified.kind)) {
      stats[classified.kind] += 1;
    }

    if ((classified.kind === 'edit' || classified.kind === 'write') && classified.path) {
      pushUnique(touchedFiles, compactDisplayPath(classified.path), maxFiles);
    }
  }

  const lines = [];
  if (latestAssistant) lines.push(latestAssistant);

  const activity = formatActivityCounts(stats);
  if (activity.length > 0) {
    lines.push(`Atividade recente: ${activity.join(', ')}.`);
  }

  if (touchedFiles.length > 0) {
    lines.push(`Arquivos tocados: ${touchedFiles.join(', ')}.`);
  }

  if (latestWarning) {
    lines.push(latestWarning);
  }

  return lines;
}

function unwrapShellCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';

  const shellWrapped = raw.match(/-lc\s+(['"])([\s\S]*)\1$/);
  if (shellWrapped?.[2]) return shellWrapped[2].trim();

  return raw;
}

function extractPrimaryCommand(command) {
  const inner = unwrapShellCommand(command);
  if (!inner) return '';
  const firstLine = inner.split(/\r?\n/, 1)[0] || inner;
  return normalizeSpaces(firstLine);
}

function formatPathAction(label, path, maxLen = 120) {
  const cleanPath = clipLine(path, maxLen);
  return cleanPath ? `${label}: ${cleanPath}` : label;
}

export function summarizeShellCommand(command) {
  const primary = extractPrimaryCommand(command);
  const lower = primary.toLowerCase();
  if (!primary) return 'Executando comando no projeto';

  if (
    lower.startsWith('rg --files') ||
    lower.startsWith('find ') ||
    lower.startsWith('tree ') ||
    lower === 'ls' ||
    lower.startsWith('ls ')
  ) {
    return 'Listando arquivos do projeto';
  }

  if (lower.startsWith('rg ') || lower.includes(' rg ')) {
    return 'Buscando no codigo do projeto';
  }

  if (
    lower.startsWith('sed ') ||
    lower.startsWith('cat ') ||
    lower.startsWith('head ') ||
    lower.startsWith('tail ')
  ) {
    return 'Lendo arquivos do projeto';
  }

  if (lower.startsWith('git status')) return 'Verificando status do git';
  if (lower.startsWith('git diff')) return 'Inspecionando alteracoes no git';
  if (lower.startsWith('git ')) {
    const subcommand = clipLine(primary.split(/\s+/).slice(0, 3).join(' '), 60);
    return `Executando ${subcommand}`;
  }

  if (
    lower.startsWith('npm test') ||
    lower.startsWith('pnpm test') ||
    lower.startsWith('yarn test') ||
    lower.startsWith('bun test')
  ) {
    return 'Rodando testes do projeto';
  }

  if (
    lower.startsWith('npm install') ||
    lower.startsWith('pnpm install') ||
    lower.startsWith('yarn install') ||
    lower.startsWith('bun install')
  ) {
    return 'Instalando dependencias do projeto';
  }

  if (
    lower.startsWith('python ') ||
    lower.startsWith('python3 ') ||
    lower.startsWith('node ') ||
    lower.startsWith('ruby ') ||
    lower.startsWith('bash ') ||
    lower.startsWith('sh ')
  ) {
    return `Executando script auxiliar: ${clipLine(primary, 90)}`;
  }

  return `Executando comando: ${clipLine(primary, 120)}`;
}

function humanizeBlockedReason(reason) {
  const normalized = normalizeSpaces(reason).toLowerCase();
  if (!normalized) return 'Bloqueado';
  if (normalized === 'quota') return 'Limite de uso do runner atingido';
  if (normalized === 'purchase_confirmation') return 'Aguardando confirmacao de compra';
  return `Bloqueado: ${clipLine(reason, 120)}`;
}

export function humanizeTaskUpdate(update) {
  const raw = normalizeSpaces(update);
  if (!raw) return '';
  const lower = raw.toLowerCase();

  if (lower === 'queued') return 'Na fila';
  if (lower === 'running') return 'Em execucao';
  if (lower === 'done') return 'Concluido';
  if (lower === 'cancelled') return 'Cancelado';
  if (lower === 'error') return 'Erro';
  if (lower === 'init') return 'Preparando runner';
  if (lower === 'reply') return 'Resposta enviada';
  if (lower === 'memory_show_project') return 'Mostrando memoria do projeto';
  if (lower === 'memory_show_user') return 'Mostrando memoria compartilhada';
  if (lower === 'memory_clear_project') return 'Limpando memoria do projeto';
  if (lower === 'memory_clear_user') return 'Limpando memoria compartilhada';
  if (lower === 'memory_set_project') return 'Salvando memoria do projeto';
  if (lower === 'memory_set_user') return 'Salvando memoria compartilhada';
  if (lower === 'memory_append_project') return 'Atualizando memoria do projeto';
  if (lower === 'memory_append_user') return 'Atualizando memoria compartilhada';
  if (lower === 'longrun_initiate') return 'Iniciando LongRun';
  if (lower === 'longrun_gather') return 'Coletando especificacao do LongRun';
  if (lower === 'longrun_confirm') return 'Aguardando confirmacao do LongRun';
  if (lower === 'thread.started' || lower === 'turn.started' || lower === 'turn.completed') {
    return 'Preparando execucao';
  }

  if (lower.startsWith('set_project ')) return `Projeto alterado para ${clipLine(raw.slice('set_project '.length), 80)}`;

  if (lower.startsWith('assistant:')) {
    return clipLine(raw.slice('assistant:'.length), 220);
  }

  if (lower.startsWith('bash:')) {
    return summarizeShellCommand(raw.slice('bash:'.length));
  }

  if (lower.startsWith('read:')) {
    return formatPathAction('Lendo arquivo', raw.slice('read:'.length));
  }

  if (lower.startsWith('edit:')) {
    return formatPathAction('Editando arquivo', raw.slice('edit:'.length));
  }

  if (lower.startsWith('write:')) {
    return formatPathAction('Escrevendo arquivo', raw.slice('write:'.length));
  }

  if (lower.startsWith('tool:')) {
    return `Usando ferramenta: ${clipLine(raw.slice('tool:'.length), 120)}`;
  }

  if (lower.startsWith('result:')) {
    return 'Finalizando resposta';
  }

  if (lower.startsWith('blocked:')) {
    return humanizeBlockedReason(raw.slice('blocked:'.length));
  }

  if (lower.startsWith('stderr:')) {
    return clipLine(raw.slice('stderr:'.length), 180);
  }

  return clipLine(raw, 220);
}

export function summarizeStderrLine(line) {
  const text = normalizeSpaces(line);
  if (!text) return null;

  const lower = text.toLowerCase();
  if (
    lower.includes("you've hit your usage limit") ||
    lower.includes("you've hit your limit") ||
    lower.includes('usage limit') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted')
  ) {
    return 'Limite de uso do runner atingido';
  }

  if (
    lower.startsWith('{') ||
    lower.startsWith('debug:') ||
    lower.startsWith('info:')
  ) {
    return null;
  }

  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('exception') ||
    lower.includes('fatal')
  ) {
    return `Aviso do runner: ${clipLine(text, 180)}`;
  }

  return null;
}
