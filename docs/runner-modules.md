# Runner Modules (MCP-like pattern)

Language: **English** | [Português (pt-BR)](runner-modules.pt-BR.md)

This project supports local runner modules with direct integration into the executor.
The approach is similar to MCP (decoupled modules), but the contract is native to Morpheus runners.

## Goal

Allow users to add new runners without changing core code, using local JavaScript files loaded at runtime.

## Where to place modules

By default, modules are loaded from:

- `RUNNER_MODULES_DIR=./runner-modules`

This directory is ignored by git (`.gitignore`), so modules stay local per environment.

## Module contract

Each `.js`, `.mjs`, or `.cjs` file in the directory must export a module with this shape:

```js
// preferred default export
export default {
  // runner identifier (used by /runner and planner)
  kind: 'my-runner',

  // optional metadata to guide planner choice (MCP-like)
  planner: {
    purpose: 'What this runner specializes in.',
    whenToUse: [
      'When this runner should be chosen.',
      'Signals/request types where it is preferred.',
    ],
    promptRules: [
      'Expected input format for plan.prompt.',
      'Example: "mark <uuid> as read".',
    ],
    promptExamples: [
      'list open messages',
      '{"action":"mark_read","id":"<uuid>"}',
    ],
  },

  // required: build the command executed by executor
  build({ prompt, cwd, artifactsDir, config }) {
    const command = '/usr/local/bin/my-cli';
    const args = ['--cwd', cwd, '--prompt', prompt];
    const commandJson = JSON.stringify({ command, args: ['--cwd', cwd, '--prompt', '<prompt>'] });
    return { command, args, commandJson };
  },

  // optional: parse JSONL/text streaming stdout
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

`export const runnerModule = { ... }` is also accepted.

### `planner` metadata (recommended)

When present, these fields are injected into orchestrator prompt to improve `runner_kind` selection and `plan.prompt` formatting:

- `purpose`: short summary of runner specialty.
- `whenToUse`: list of triggers/situations where this runner should be preferred.
- `promptRules`: input contract expected by this runner.
- `promptExamples`: valid prompt examples.

## Loading rules

- Loader ignores empty `kind`, `kind="auto"`, or modules without `build()`.
- `kind` conflicting with built-ins (`codex-cli`, `claude-cli`, `cursor-cli`, `gemini-cli`, `desktop-agent`) is ignored.
- If two modules use the same `kind`, the second one is ignored.
- Import/runtime failures are logged and do not crash the server.

## Usage from WhatsApp/Discord

After starting server with module present:

1. Check available runners with `/runner`.
2. Set module for current user/task: `/runner my-runner`.
3. (Admin) set global default: `/runner global my-runner`.

## Notes

- `build()` receives full app `config` for environment variable reuse.
- `parseLine()` is optional but recommended for progress (`updateText`) and `assistantDelta`/`finalResult` extraction.
- Avoid placing secrets inside `commandJson`; use placeholders (`<prompt>`) when needed.
