# Morpheus

Idioma: [English](README.md) | **Português (pt-BR)**

Morpheus é um **orquestrador de IA open source** acessível por **WhatsApp e Discord**.

Fluxo principal:

```text
WhatsApp/Discord -> Planner (orchestrator) -> Executor -> Runners locais -> Resposta + artefatos
```

Runners nativos atuais: `codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`, `desktop-agent`.

Índice de documentação:

- English: `docs/README.md`;
- Português: `docs/README.pt-BR.md`.

## O que o projeto entrega

- Entrada por chat (WhatsApp e Discord) para operar projetos locais.
- Múltiplas tasks por usuário/canal, com fila e cancelamento.
- Planejamento automático de ação (`run`, `reply`, troca de projeto/runner, memória etc.).
- Execução local de CLIs de IA com logs e artefatos em `runs/`.
- Extensibilidade por módulos pessoais de runner (MCP-like), sem alterar o core.

## Como funciona: Planner

O planner é o cérebro do Morpheus. Ele recebe:

- mensagem atual do usuário;
- contexto recente da task;
- projeto ativo;
- memória compartilhada do usuário;
- catálogo de runners disponíveis (nativos + módulos externos).

Com isso, devolve um JSON de plano com uma ação. Exemplos:

- `run` (executar em um runner);
- `reply` (responder sem executar);
- `set_project`, `set_runner`, `set_orchestrator`;
- `memory_append`, `memory_set`, `memory_clear`, `memory_show`;
- `project_add`, `project_mkdir`, `project_clone`, `project_scan`.

Resumo prático:

- Se o pedido é trabalho técnico, normalmente gera `action="run"` e escolhe `runner_kind`.
- Se for ajuste de configuração em linguagem natural, pode gerar `set_*`.
- Se a mensagem for vaga (`oi`, `bom dia`), tende a responder com orientações curtas.

Providers de planner suportados:

- `gemini-cli` (default);
- `openrouter` (fallback/alternativa).

## Como funciona: Runners

Runners são os executores. Cada runner:

- recebe `plan.prompt` e contexto (`cwd`, `artifactsDir`, `config`);
- monta o comando real de execução (`build`);
- interpreta a saída da CLI para atualizar progresso (`parseLine`, opcional).

Runners nativos:

- `codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`: foco em código/shell;
- `desktop-agent`: foco em automação de UI web/desktop com evidência visual.

O executor controla fila, concorrência, timeout, cancelamento e persistência dos artefatos.

## Módulos pessoais (runner modules)

Você pode criar runners próprios sem alterar o código principal.

- Diretório padrão: `RUNNER_MODULES_DIR=./runner-modules`;
- cada arquivo `.js`, `.mjs` ou `.cjs` exporta um módulo com `kind` + `build()`;
- `parseLine()` e metadados `planner` são opcionais, mas recomendados;
- módulos válidos aparecem no comando `/runner`.

Importante:

- `runner-modules/` está no `.gitignore`;
- isso significa que módulos pessoais **não entram no git do projeto principal**.

Contrato completo, exemplo e regras:

- English: `docs/runner-modules.md`;
- Português: `docs/runner-modules.pt-BR.md`.

## Sugestão de versionamento para módulos pessoais

Recomendado: manter os módulos em **repositório separado** e apontar `RUNNER_MODULES_DIR` para fora deste repo.

Exemplo:

1. Criar repositório próprio, ex.: `morpheus-runner-modules` (público ou privado).
2. Clonar em outro caminho local, ex.: `/Users/seu-usuario/dev/morpheus-runner-modules`.
3. No Morpheus, definir no `.env.local`: `RUNNER_MODULES_DIR=/Users/seu-usuario/dev/morpheus-runner-modules`.
4. Versionar os módulos nesse repositório dedicado (branches, tags e releases), sem poluir o `morpheus`.

Vantagens:

- histórico limpo no core;
- permissão separada por time/cliente;
- possibilidade de publicar módulos reutilizáveis.

## Requisitos

- Node.js >= 20;
- `npm i`;
- `npx playwright install`.

Opcional para automação GUI no macOS:

- `brew install cliclick`;
- `brew install tesseract`.

Permissões do macOS:

- Screen Recording;
- Accessibility.

## Setup rápido

1. Rode `npm run init:projects` e informe path, nome, type e um número permitido.
2. O script cria `projects.json`, cria/atualiza `.env` e inicia `npm run dev`.
3. Ajuste no `.env` o que faltar (ex.: `ADMIN_PHONE_NUMBERS`).
4. No primeiro start, o Baileys mostra um QR no terminal; escaneie em WhatsApp > Linked Devices.

Sessão do WhatsApp:

- `WHATSAPP_AUTH_DIR` (default: `./data/whatsapp-auth`).

## Discord (task fixa por canal)

Guia completo:

- English: `docs/discord.md`;
- Português: `docs/discord.pt-BR.md`.

Resumo:

- Um bot pode atender vários servidores (`DISCORD_ALLOWED_GUILD_IDS`);
- cada canal precisa ser habilitado com `/channel-enable`;
- cada canal habilitado opera com task fixa própria;
- canais não habilitados ficam em silêncio.

## Projetos

Projetos vivem em `projects.json`:

- `id` (obrigatório);
- `cwd` (obrigatório);
- `name` (opcional);
- `type` (opcional).

Comandos úteis:

- `/projects`;
- `/project <id>`;
- `/project-add <id> <cwd> [type] [name...]` (admin);
- `/project-base` (admin);
- `/project-scan` (admin);
- `/project-mkdir <id> <dir> [--type t] [--name ...]` (admin);
- `/project-clone <id> <gitUrl> [--dir d] [--depth 1] [--type t] [--name ...]` (admin);
- `/project-rm <id>` (admin).

## Mídia recebida (áudio/imagem)

Fluxo:

1. Baixa a mídia recebida.
2. Salva em `RUNS_DIR/<taskId>/inbox/<messageId>/`.
3. Áudio: transcreve via OpenAI Whisper (`OPENAI_API_KEY`).
4. Imagem: descreve via provider multimodal (`OPENROUTER_API_KEY`).
5. Converte para texto canônico e envia ao orquestrador.

Documentação de mídia:

- English: `docs/whatsapp-media.md`;
- Português: `docs/whatsapp-media.pt-BR.md`.

## Memória compartilhada

Comandos:

- `/memory`;
- `/remember <texto>`;
- `/forget-memory`.

## Open source e contribuição

Morpheus é open source e aceita melhorias da comunidade.

- Abra uma issue para bugs, ideias e discussões de arquitetura.
- Envie PR com mudança objetiva e contexto de validação.
- Priorize alterar docs quando adicionar ou mudar comportamento.

Licença:

- `LICENSE` (MIT).
