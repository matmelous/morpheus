# morpheus

Morpheus e uma versao standalone do personal-mac-interface:

WhatsApp (Baileys local) -> Orchestrator -> Local AI CLIs (Codex/Cursor/Gemini/Claude)

## Requisitos

- Node >= 20
- `npm i`
- `npx playwright install`

Opcional para automacao GUI no macOS:
- `brew install cliclick`
- `brew install tesseract`

Permissoes do macOS:
- Screen Recording
- Accessibility

## Setup rapido

1. Copie `.env.example` para `.env`.
2. Configure pelo menos:
- `ALLOWED_PHONE_NUMBERS`
- `ADMIN_PHONE_NUMBERS`
- `DEFAULT_PROJECT_ID`
3. Rode `npm run dev`.
4. No primeiro start, o Baileys vai logar um QR no terminal (`connection.update.qr`). Escaneie em WhatsApp > Linked Devices.

Os arquivos de sessao do WhatsApp ficam em `WHATSAPP_AUTH_DIR` (default: `./data/whatsapp-auth`).

## Desktop Agent (web + macOS GUI)

Este app inclui o runner `desktop-agent` para automacao no macOS (web-first com Playwright + GUI via ferramentas do sistema).

Confirmacao de compra:
- O agente pede confirmacao apenas para checkout/compra.
- Responda com `CONFIRMO COMPRA` ou use `/confirm` (expira em 10 min).

## Projetos

Projetos sao definidos em `projects.json` como um array com:
- `id` (obrigatorio)
- `cwd` (obrigatorio)
- `name` (opcional)
- `type` (opcional)

Comandos no WhatsApp:
- `/projects`
- `/project <id>`
- `/project-add <id> <cwd> [type] [name...]` (admin)
- `/project-base` (admin)
- `/project-scan` (admin)
- `/project-mkdir <id> <dir> [--type t] [--name ...]` (admin)
- `/project-clone <id> <gitUrl> [--dir d] [--depth 1] [--type t] [--name ...]` (admin)
- `/project-rm <id>` (admin)

## Midia recebida (audio/imagem)

Fluxo:
1. Baixa a midia diretamente pelo socket Baileys.
2. Salva em `RUNS_DIR/<taskId>/inbox/<messageId>/`.
3. Audio: transcreve via OpenAI Whisper (`OPENAI_API_KEY`).
4. Imagem: descreve via OpenRouter multimodal (`OPENROUTER_API_KEY`).
5. Converte para texto canonico e executa no orquestrador.

## Memoria compartilhada

Comandos:
- `/memory`
- `/remember <texto>`
- `/forget-memory`
