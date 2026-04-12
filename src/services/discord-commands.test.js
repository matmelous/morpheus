import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscordCommandRegistrationRequests,
  buildDiscordSlashCommandJson,
  getDiscordAutocompleteChoices,
  slashInteractionToLegacyText,
} from './discord-commands.js';

function makeInteraction({ commandName, strings = {}, focused = null } = {}) {
  return {
    commandName,
    options: {
      getString(name) {
        return Object.prototype.hasOwnProperty.call(strings, name) ? strings[name] : null;
      },
      getFocused(withMeta = false) {
        if (!withMeta) return focused?.value || '';
        return focused || { name: '', value: '' };
      },
    },
  };
}

test('buildDiscordSlashCommandJson includes core Discord commands', () => {
  const commands = buildDiscordSlashCommandJson();
  const names = commands.map((command) => command.name).sort();

  assert.deepEqual(names, [
    'cancel',
    'channel-disable',
    'channel-enable',
    'channel-info',
    'help',
    'loglevel',
    'model',
    'new',
    'project',
    'projects',
    'runner',
    'status',
    'task',
  ]);
});

test('slashInteractionToLegacyText maps slash commands to current core text format', () => {
  assert.equal(
    slashInteractionToLegacyText(makeInteraction({
      commandName: 'channel-enable',
      strings: { project: 'morpheus', runner: 'codex-cli' },
    })),
    '/channel-enable morpheus codex-cli'
  );
  assert.equal(
    slashInteractionToLegacyText(makeInteraction({
      commandName: 'model',
      strings: { value: 'gemma4:e4b' },
    })),
    '/model gemma4:e4b'
  );
  assert.equal(
    slashInteractionToLegacyText(makeInteraction({
      commandName: 'loglevel',
      strings: { level: 'silent' },
    })),
    '/loglevel silent'
  );
  assert.equal(
    slashInteractionToLegacyText(makeInteraction({
      commandName: 'new',
      strings: { text: 'corrige o bug do discord' },
    })),
    '/new corrige o bug do discord'
  );
  assert.equal(
    slashInteractionToLegacyText(makeInteraction({
      commandName: 'project',
      strings: { id: 'argo-argonav-web' },
    })),
    '/project argo-argonav-web'
  );
});

test('getDiscordAutocompleteChoices filters project and runner suggestions', () => {
  const projects = [
    { id: 'morpheus', name: 'morpheus', type: 'git' },
    { id: 'argo-argonav-web', name: 'argonav-web', type: 'git' },
    { id: 'paysight-platform', name: 'Paysight Platform', type: 'local' },
  ];

  const projectChoices = getDiscordAutocompleteChoices(
    makeInteraction({
      commandName: 'channel-enable',
      focused: { name: 'project', value: 'argo' },
    }),
    { projects, runnerKinds: ['codex-cli', 'claude-cli', 'auto'] }
  );

  assert.equal(projectChoices[0]?.value, 'argo-argonav-web');

  const runnerChoices = getDiscordAutocompleteChoices(
    makeInteraction({
      commandName: 'runner',
      focused: { name: 'kind', value: 'co' },
    }),
    { projects, runnerKinds: ['codex-cli', 'claude-cli', 'auto'] }
  );

  assert.equal(runnerChoices[0]?.value, 'codex-cli');

  const modelChoices = getDiscordAutocompleteChoices(
    makeInteraction({
      commandName: 'model',
      focused: { name: 'value', value: 'gem' },
    }),
    { modelValues: ['gemma4:e4b', 'gemma4:26b', 'clear'] }
  );

  assert.equal(modelChoices[0]?.value, 'gemma4:26b');
});

test('buildDiscordCommandRegistrationRequests builds one route per guild', () => {
  const requests = buildDiscordCommandRegistrationRequests({
    applicationId: 'app-123',
    guildIds: ['guild-1', 'guild-2'],
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0].route, /applications\/app-123\/guilds\/guild-1\/commands/);
  assert.match(requests[1].route, /applications\/app-123\/guilds\/guild-2\/commands/);
  assert.ok(Array.isArray(requests[0].body));
  assert.ok(requests[0].body.length > 0);
});
