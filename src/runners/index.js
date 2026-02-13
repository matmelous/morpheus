import { buildCodexRun, codexParseLine } from './codex-cli.js';
import { buildClaudeRun, claudeParseLine } from './claude-cli.js';
import { buildCursorRun, cursorParseLine } from './cursor-cli.js';
import { buildGeminiRun, geminiParseLine } from './gemini-cli.js';
import { buildDesktopAgentRun, desktopAgentParseLine } from './desktop-agent.js';

export function getRunner(kind) {
  switch (kind) {
    case 'codex-cli':
      return {
        kind,
        build: buildCodexRun,
        parseLine: (ctx) => codexParseLine(ctx),
      };
    case 'claude-cli':
      return {
        kind,
        build: buildClaudeRun,
        parseLine: (ctx) => claudeParseLine(ctx),
      };
    case 'cursor-cli':
      return {
        kind,
        build: buildCursorRun,
        parseLine: (ctx) => cursorParseLine(ctx),
      };
    case 'gemini-cli':
      return {
        kind,
        build: buildGeminiRun,
        parseLine: (ctx) => geminiParseLine(ctx),
      };
    case 'desktop-agent':
      return {
        kind,
        build: buildDesktopAgentRun,
        parseLine: (ctx) => desktopAgentParseLine(ctx),
      };
    default:
      return null;
  }
}
