# Runner Modules (padrao MCP-like)

Este projeto suporta modulos locais de runner com interface direta no executor.
A ideia e similar a MCP (modulos desacoplados), mas o contrato e direto com os runners do Morpheus.

## Objetivo

Permitir que usuarios criem novos runners sem alterar o core, usando arquivos JavaScript locais carregados em runtime.

## Onde colocar

Por padrao, os modulos sao lidos de:

- `RUNNER_MODULES_DIR=./runner-modules`

Esse diretorio e ignorado no git (`.gitignore`), entao os modulos ficam locais por ambiente.

## Contrato do modulo

Cada arquivo `.js`, `.mjs` ou `.cjs` dentro do diretorio deve exportar um modulo com este formato:

```js
// default export (preferido)
export default {
  // identificador do runner (usado em /runner e no planner)
  kind: 'meu-runner',

  // opcional: metadados para orientar o planner (MCP-like)
  planner: {
    purpose: 'O que este runner faz de forma especializada.',
    whenToUse: [
      'Quando usar este runner.',
      'Sinais/tipos de pedido em que ele e preferivel.',
    ],
    promptRules: [
      'Formato esperado para plan.prompt.',
      'Ex.: "marcar <uuid> como lida".',
    ],
    promptExamples: [
      'listar mensagens abertas',
      '{"action":"mark_read","id":"<uuid>"}',
    ],
  },

  // obrigatorio: monta o comando executado pelo executor
  build({ prompt, cwd, artifactsDir, config }) {
    const command = '/usr/local/bin/minha-cli';
    const args = ['--cwd', cwd, '--prompt', prompt];
    const commandJson = JSON.stringify({ command, args: ['--cwd', cwd, '--prompt', '<prompt>'] });
    return { command, args, commandJson };
  },

  // opcional: parse streaming JSONL/text do stdout
  parseLine({ obj, rawLine, state }) {
    if (obj?.type === 'init') {
      return { model: obj.model, sessionId: obj.session_id, updateText: 'init' };
    }
    if (obj?.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
      const text = obj.content.trim();
      if (!text) return null;
      return {
        updateText: `assistant: ${text.slice(0, 160)}`,
        assistantDelta: `${text}\n`,
      };
    }
    if (rawLine && rawLine.includes('usage limit')) {
      return { blockedReason: 'quota', updateText: 'blocked:quota' };
    }
    return null;
  },
};
```

Tambem e aceito `export const runnerModule = { ... }`.

### Metadados `planner` (recomendado)

Se presentes, esses campos entram no prompt do orchestrator para melhorar escolha de `runner_kind` e formato de `plan.prompt`:

- `purpose`: resumo curto da especialidade do runner.
- `whenToUse`: lista de gatilhos/situacoes em que esse runner deve ser preferido.
- `promptRules`: contrato de entrada esperado pelo runner.
- `promptExamples`: exemplos de prompts validos.

## Regras de carregamento

- O loader ignora `kind` vazio, `kind="auto"` ou modulo sem `build()`.
- `kind` conflitando com runner nativo (`codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`, `desktop-agent`) e ignorado.
- Se dois modulos usarem o mesmo `kind`, o segundo e ignorado.
- Falhas de import/execucao sao logadas e nao derrubam o servidor.

## Como usar no WhatsApp

Depois de iniciar o servidor com o modulo presente:

1. Verifique os runners disponiveis com `/runner`.
2. Defina o modulo para usuario atual: `/runner meu-runner`.
3. (Admin) Defina global: `/runner global meu-runner`.

## Observacoes

- `build()` recebe o `config` completo do app para reutilizar variaveis de ambiente.
- `parseLine()` e opcional, mas recomendado para atualizar progresso (`updateText`) e capturar `assistantDelta`/`finalResult`.
- Evite incluir segredos no `commandJson`; use placeholders (`<prompt>`) quando necessario.
