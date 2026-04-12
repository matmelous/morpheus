import { Routes, SlashCommandBuilder } from 'discord.js';

function nonEmpty(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function joinLegacyCommand(command, ...parts) {
  const values = [command, ...parts.map(nonEmpty).filter(Boolean)];
  return values.join(' ');
}

function truncateLabel(value, max = 100) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildProjectChoice(project) {
  const id = nonEmpty(project?.id);
  if (!id) return null;

  const name = nonEmpty(project?.name);
  const type = nonEmpty(project?.type);
  const label = [id, name && name !== id ? name : null, type ? `(${type})` : null]
    .filter(Boolean)
    .join(' - ')
    .replace(' - (', ' (');

  return {
    name: truncateLabel(label || id),
    value: id,
  };
}

function buildRunnerChoice(kind) {
  const value = nonEmpty(kind);
  if (!value) return null;
  return {
    name: truncateLabel(value),
    value,
  };
}

function buildValueChoice(value) {
  const text = nonEmpty(value);
  if (!text) return null;
  return {
    name: truncateLabel(text),
    value: text,
  };
}

function scoreAutocompleteChoice(choice, query) {
  const haystack = `${choice.name} ${choice.value}`.toLowerCase();
  if (!query) return { score: 0, haystack };

  const value = choice.value.toLowerCase();
  if (value === query) return { score: 0, haystack };
  if (value.startsWith(query)) return { score: 1, haystack };
  if (haystack.startsWith(query)) return { score: 2, haystack };

  const index = haystack.indexOf(query);
  if (index === -1) return null;
  return { score: 3 + index, haystack };
}

function filterAutocompleteChoices(choices, focusedValue) {
  const query = String(focusedValue || '').trim().toLowerCase();

  return choices
    .map((choice) => {
      const meta = scoreAutocompleteChoice(choice, query);
      if (!meta) return null;
      return { choice, ...meta };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.haystack.localeCompare(b.haystack);
    })
    .slice(0, 25)
    .map((item) => item.choice);
}

export function buildDiscordSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Mostra a ajuda do Morpheus'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Mostra tasks recentes')
      .addStringOption((option) => option
        .setName('project')
        .setDescription('Filtrar por projeto')
        .setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName('projects')
      .setDescription('Lista os projetos cadastrados'),
    new SlashCommandBuilder()
      .setName('project')
      .setDescription('Mostra ou altera o projeto default')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('Projeto para usar')
        .setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName('runner')
      .setDescription('Mostra ou altera o runner efetivo')
      .addStringOption((option) => option
        .setName('kind')
        .setDescription('Runner para usar')
        .setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Mostra ou altera o modelo da task atual')
      .addStringOption((option) => option
        .setName('value')
        .setDescription('Modelo para usar ou clear para limpar')
        .setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName('loglevel')
      .setDescription('Mostra ou altera o nivel de logs')
      .addStringOption((option) => option
        .setName('level')
        .setDescription('Nivel para usar')
        .addChoices(
          { name: 'silent', value: 'silent' },
          { name: 'normal', value: 'normal' },
          { name: 'verbose', value: 'verbose' },
        )),
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Cria uma nova task')
      .addStringOption((option) => option
        .setName('text')
        .setDescription('Prompt inicial da task')),
    new SlashCommandBuilder()
      .setName('task')
      .setDescription('Mostra ou altera a task em foco')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('Task para focar')),
    new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancela a task atual ou uma task informada')
      .addStringOption((option) => option
        .setName('task')
        .setDescription('Task para cancelar')),
    new SlashCommandBuilder()
      .setName('channel-enable')
      .setDescription('Habilita o canal atual no Morpheus')
      .addStringOption((option) => option
        .setName('project')
        .setDescription('Projeto default do canal')
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName('runner')
        .setDescription('Runner default do canal')
        .setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName('channel-disable')
      .setDescription('Desabilita o canal atual no Morpheus'),
    new SlashCommandBuilder()
      .setName('channel-info')
      .setDescription('Mostra o estado do canal atual no Morpheus'),
  ];
}

export function buildDiscordSlashCommandJson() {
  return buildDiscordSlashCommands().map((command) => command.toJSON());
}

export function buildDiscordCommandRegistrationRequests({ applicationId, guildIds } = {}) {
  const appId = nonEmpty(applicationId);
  if (!appId) throw new Error('applicationId is required');

  const commands = buildDiscordSlashCommandJson();
  return (Array.isArray(guildIds) ? guildIds : [])
    .map((guildId) => nonEmpty(guildId))
    .filter(Boolean)
    .map((guildId) => ({
      guildId,
      route: Routes.applicationGuildCommands(appId, guildId),
      body: commands,
    }));
}

export function slashInteractionToLegacyText(interaction) {
  const name = nonEmpty(interaction?.commandName);
  const options = interaction?.options;
  if (!name || !options) return null;

  switch (name) {
    case 'help':
      return '/help';
    case 'status':
      return joinLegacyCommand('/status', options.getString('project'));
    case 'projects':
      return '/projects';
    case 'project':
      return joinLegacyCommand('/project', options.getString('id'));
    case 'runner':
      return joinLegacyCommand('/runner', options.getString('kind'));
    case 'model':
      return joinLegacyCommand('/model', options.getString('value'));
    case 'loglevel':
      return joinLegacyCommand('/loglevel', options.getString('level'));
    case 'new':
      return joinLegacyCommand('/new', options.getString('text'));
    case 'task':
      return joinLegacyCommand('/task', options.getString('id'));
    case 'cancel':
      return joinLegacyCommand('/cancel', options.getString('task'));
    case 'channel-enable':
      return joinLegacyCommand(
        '/channel-enable',
        options.getString('project'),
        options.getString('runner'),
      );
    case 'channel-disable':
      return '/channel-disable';
    case 'channel-info':
      return '/channel-info';
    default:
      return null;
  }
}

export function getDiscordAutocompleteChoices(interaction, { projects = [], runnerKinds = [], modelValues = [] } = {}) {
  const focused = interaction?.options?.getFocused?.(true);
  const commandName = nonEmpty(interaction?.commandName);
  if (!commandName || !focused?.name) return [];

  if (focused.name === 'project' || (commandName === 'project' && focused.name === 'id')) {
    const choices = projects.map(buildProjectChoice).filter(Boolean);
    return filterAutocompleteChoices(choices, focused.value);
  }

  if (focused.name === 'runner' || (commandName === 'runner' && focused.name === 'kind')) {
    const choices = runnerKinds.map(buildRunnerChoice).filter(Boolean);
    return filterAutocompleteChoices(choices, focused.value);
  }

  if (focused.name === 'value' && commandName === 'model') {
    const choices = modelValues.map(buildValueChoice).filter(Boolean);
    return filterAutocompleteChoices(choices, focused.value);
  }

  return [];
}

export default {
  buildDiscordSlashCommands,
  buildDiscordSlashCommandJson,
  buildDiscordCommandRegistrationRequests,
  slashInteractionToLegacyText,
  getDiscordAutocompleteChoices,
};
