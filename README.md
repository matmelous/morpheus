# Morpheus

Language: **English** | [Português (pt-BR)](README.pt-BR.md)

Morpheus is an **open-source AI orchestrator** accessible through **WhatsApp and Discord**.

Main flow:

```text
WhatsApp/Discord -> Planner (orchestrator) -> Executor -> Local runners -> Reply + artifacts
```

Current built-in runners: `codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`, `desktop-agent`.

Documentation index:

- English: `docs/README.md`;
- Portuguese: `docs/README.pt-BR.md`.

## What Morpheus provides

- Chat entrypoint (WhatsApp and Discord) to operate local projects.
- Multiple tasks per user/channel, with queue and cancellation support.
- Automatic action planning (`run`, `reply`, project/runner switching, memory operations, etc.).
- Local AI CLI execution with logs and artifacts in `runs/`.
- Extensibility via personal runner modules (MCP-like) without changing core code.

## How it works: Planner

The planner is Morpheus' decision layer. It receives:

- current user message;
- recent task context;
- active project;
- user shared memory;
- available runner catalog (built-in + external modules).

It returns a JSON plan action. Examples:

- `run` (execute with a runner);
- `reply` (answer without execution);
- `set_project`, `set_runner`, `set_orchestrator`;
- `memory_append`, `memory_set`, `memory_clear`, `memory_show`;
- `project_add`, `project_mkdir`, `project_clone`, `project_scan`.

Practical behavior:

- Technical requests usually become `action="run"` plus a selected `runner_kind`.
- Natural-language configuration requests can become `set_*` actions.
- Vague greetings (`hi`, `hello`) usually return short guidance.

Supported planner providers:

- `gemini-cli` (default);
- `openrouter` (fallback/alternative).

## How it works: Runners

Runners execute work. Each runner:

- receives `plan.prompt` and context (`cwd`, `artifactsDir`, `config`);
- builds the real command (`build`);
- optionally parses CLI output for progress updates (`parseLine`).

Built-in runners:

- `codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`: code/shell focused;
- `desktop-agent`: web/desktop UI automation with visual evidence.

The executor handles queueing, concurrency, timeout, cancellation, and artifact persistence.

## Personal modules (runner modules)

You can create custom runners without changing main repository code.

- Default directory: `RUNNER_MODULES_DIR=./runner-modules`;
- each `.js`, `.mjs`, or `.cjs` file exports a module with `kind` + `build()`;
- `parseLine()` and `planner` metadata are optional but recommended;
- valid modules appear in `/runner`.

Important:

- `runner-modules/` is in `.gitignore`;
- personal modules are **not added to the main Morpheus git history**.

Full contract, examples, and rules:

- English: `docs/runner-modules.md`;
- Portuguese: `docs/runner-modules.pt-BR.md`.

## Recommended versioning strategy for personal modules

Recommended approach: keep modules in a **separate repository** and point `RUNNER_MODULES_DIR` outside this repo.

Example:

1. Create a dedicated repository, e.g. `morpheus-runner-modules`.
2. Clone it somewhere else, e.g. `/Users/your-user/dev/morpheus-runner-modules`.
3. In Morpheus, set `.env.local`: `RUNNER_MODULES_DIR=/Users/your-user/dev/morpheus-runner-modules`.
4. Version modules in the dedicated repo (branches/tags/releases), without polluting Morpheus core history.

Benefits:

- cleaner core history;
- separate access control per team/client;
- reusable module publishing.

## Requirements

- Node.js >= 20;
- `npm i`;
- `npx playwright install`.

Optional for GUI automation on macOS:

- `brew install cliclick`;
- `brew install tesseract`.

macOS permissions:

- Screen Recording;
- Accessibility.

## Quick setup

1. Run `npm run init:projects` and provide path, name, type, and one allowed number.
2. The script creates `projects.json`, updates `.env`, and starts `npm run dev`.
3. Adjust missing values in `.env` (e.g. `ADMIN_PHONE_NUMBERS`).
4. On first startup, Baileys prints a QR code in terminal; scan it in WhatsApp > Linked Devices.

WhatsApp session location:

- `WHATSAPP_AUTH_DIR` (default: `./data/whatsapp-auth`).

## Discord (fixed task per channel)

Full guide:

- English: `docs/discord.md`;
- Portuguese: `docs/discord.pt-BR.md`.

Summary:

- One bot can serve multiple guilds (`DISCORD_ALLOWED_GUILD_IDS`);
- each channel must be enabled with `/channel-enable`;
- each enabled channel uses its own fixed task context;
- non-enabled channels stay silent.

## Projects

Projects are defined in `projects.json`:

- `id` (required);
- `cwd` (required);
- `name` (optional);
- `type` (optional).

Useful commands:

- `/projects`;
- `/project <id>`;
- `/project-add <id> <cwd> [type] [name...]` (admin);
- `/project-base` (admin);
- `/project-scan` (admin);
- `/project-mkdir <id> <dir> [--type t] [--name ...]` (admin);
- `/project-clone <id> <gitUrl> [--dir d] [--depth 1] [--type t] [--name ...]` (admin);
- `/project-rm <id>` (admin).

## Incoming media (audio/image)

Flow:

1. Download incoming media.
2. Save in `RUNS_DIR/<taskId>/inbox/<messageId>/`.
3. Audio: transcribe with OpenAI Whisper (`OPENAI_API_KEY`).
4. Image: describe with multimodal provider (`OPENROUTER_API_KEY`).
5. Convert to canonical text and pass to the orchestrator.

Media docs:

- English: `docs/whatsapp-media.md`;
- Portuguese: `docs/whatsapp-media.pt-BR.md`.

## Shared memory

Commands:

- `/memory`;
- `/remember <text>`;
- `/forget-memory`.

## Open source and contributions

Morpheus is open source and community improvements are welcome.

- Open issues for bugs, ideas, and architecture discussions.
- Send PRs with clear scope and validation context.
- Update docs when behavior is added or changed.

License:

- `LICENSE` (MIT).
