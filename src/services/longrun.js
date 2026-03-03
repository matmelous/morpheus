/**
 * LongRun File I/O Service
 *
 * Pure file system operations for the LongRun feature.
 * Manages the .morpheus/longrun/<feature-uuid>/ directory structure.
 *
 * Directory layout:
 *   <project_cwd>/.morpheus/longrun/<feature-uuid>/
 *     feature.md
 *     waves/<wave-uuid>.md
 *     epic-groups/<epic-group-uuid>.md
 *     epics/<epic-uuid>.md
 *     tasks/<task-uuid>.md
 *     tasks.txt        # <task-uuid> pending|done  — one per line, execution order
 *     validations.txt  # <epic-uuid> pending|validated|failed — one per line
 *
 * No DB access, no process spawning — those are handled by task-store.js and longrun-executor.js.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import crypto from 'node:crypto';

// --- UUID ---

export function generateUUID() {
  return crypto.randomUUID();
}

// --- Path helpers ---

/**
 * Returns the root directory for a given longrun feature.
 * @param {string} projectCwd - Absolute path to the project root
 * @param {string} featureUuid - UUID v4 of the feature
 * @returns {string} Absolute path to .morpheus/longrun/<featureUuid>/
 */
export function getLongrunRoot(projectCwd, featureUuid) {
  return resolve(projectCwd, '.morpheus', 'longrun', featureUuid);
}

/**
 * Creates all required subdirectories under the longrun root.
 * Safe to call multiple times (uses recursive: true).
 * @param {string} longrunRoot
 */
export function ensureLongrunDirs(longrunRoot) {
  mkdirSync(join(longrunRoot, 'waves'), { recursive: true });
  mkdirSync(join(longrunRoot, 'epic-groups'), { recursive: true });
  mkdirSync(join(longrunRoot, 'epics'), { recursive: true });
  mkdirSync(join(longrunRoot, 'tasks'), { recursive: true });
}

// --- Markdown content builders ---

function buildFeatureMd(feature, waves) {
  const waveList = Array.isArray(waves) && waves.length > 0
    ? waves.map((w, i) => `- Wave ${i + 1} (${w.parallel ? 'paralela' : 'sequencial'}): ${w.title || w.uuid} — uuid: ${w.uuid}`).join('\n')
    : '(nenhuma wave definida ainda)';

  return [
    `# Feature: ${feature.title || '(sem titulo)'}`,
    `uuid: ${feature.uuid}`,
    '',
    feature.description || '(descricao pendente)',
    '',
    '## Development Waves',
    waveList,
  ].join('\n');
}

function buildWaveMd(wave, featureUuid) {
  const egList = Array.isArray(wave.epic_groups) && wave.epic_groups.length > 0
    ? wave.epic_groups.map((eg) => `- ${eg.title || eg.uuid} — uuid: ${eg.uuid}`).join('\n')
    : '(nenhum epic group definido ainda)';

  return [
    `# Wave: ${wave.title || '(sem titulo)'}`,
    `uuid: ${wave.uuid}`,
    `feature_uuid: ${featureUuid}`,
    `order: ${wave.order ?? '(indefinido)'}`,
    `parallel: ${wave.parallel ? 'sim' : 'nao'}`,
    '',
    wave.description || '',
    '',
    '## Epic Groups',
    egList,
  ].join('\n');
}

function buildEpicGroupMd(epicGroup, waveUuid) {
  const epicList = Array.isArray(epicGroup.epics) && epicGroup.epics.length > 0
    ? epicGroup.epics.map((e) => `- ${e.title || e.uuid} — uuid: ${e.uuid}`).join('\n')
    : '(nenhum epic definido ainda)';

  return [
    `# Epic Group: ${epicGroup.title || '(sem titulo)'}`,
    `uuid: ${epicGroup.uuid}`,
    `wave_uuid: ${waveUuid}`,
    '',
    epicGroup.description || '(descricao pendente)',
    '',
    '## Epics',
    epicList,
  ].join('\n');
}

function buildEpicMd(epic, epicGroupUuid) {
  const taskList = Array.isArray(epic.tasks) && epic.tasks.length > 0
    ? epic.tasks.map((t, i) => `- Task ${i + 1}: ${t.title || t.uuid} — uuid: ${t.uuid}`).join('\n')
    : '(nenhuma task definida ainda)';

  return [
    `# Epic: ${epic.title || '(sem titulo)'}`,
    `uuid: ${epic.uuid}`,
    `epic_group_uuid: ${epicGroupUuid}`,
    '',
    epic.description || '(descricao pendente)',
    '',
    '## Validation Instructions',
    epic.validation_instructions || '(instrucoes de validacao pendentes)',
    '',
    '## Tasks',
    taskList,
  ].join('\n');
}

function buildTaskMd(task, epicUuid) {
  return [
    `# Task: ${task.title || '(sem titulo)'}`,
    `uuid: ${task.uuid}`,
    `epic_uuid: ${epicUuid}`,
    '',
    task.description || '(descricao pendente)',
  ].join('\n');
}

// --- Incremental spec writing ---

/**
 * Writes/overwrites markdown files for whatever data is present in partialSpec.
 * Safe to call on every `longrun_gather` turn — UUID-named files are idempotent.
 *
 * @param {string} longrunRoot
 * @param {object} partialSpec - Partial spec object (may be incomplete)
 */
export function writePartialSpec(longrunRoot, partialSpec) {
  if (!partialSpec || typeof partialSpec !== 'object') return;

  const feature = partialSpec.feature;
  const waves = Array.isArray(partialSpec.waves) ? partialSpec.waves : [];

  // feature.md
  if (feature && feature.uuid) {
    writeFileSync(
      join(longrunRoot, 'feature.md'),
      buildFeatureMd(feature, waves),
      'utf-8'
    );
  }

  // waves/<uuid>.md, epic-groups/<uuid>.md, epics/<uuid>.md, tasks/<uuid>.md
  for (const wave of waves) {
    if (!wave || !wave.uuid) continue;

    writeFileSync(
      join(longrunRoot, 'waves', `${wave.uuid}.md`),
      buildWaveMd(wave, feature?.uuid || ''),
      'utf-8'
    );

    const epicGroups = Array.isArray(wave.epic_groups) ? wave.epic_groups : [];
    for (const eg of epicGroups) {
      if (!eg || !eg.uuid) continue;

      writeFileSync(
        join(longrunRoot, 'epic-groups', `${eg.uuid}.md`),
        buildEpicGroupMd(eg, wave.uuid),
        'utf-8'
      );

      const epics = Array.isArray(eg.epics) ? eg.epics : [];
      for (const epic of epics) {
        if (!epic || !epic.uuid) continue;

        writeFileSync(
          join(longrunRoot, 'epics', `${epic.uuid}.md`),
          buildEpicMd(epic, eg.uuid),
          'utf-8'
        );

        const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
        for (const task of tasks) {
          if (!task || !task.uuid) continue;

          writeFileSync(
            join(longrunRoot, 'tasks', `${task.uuid}.md`),
            buildTaskMd(task, epic.uuid),
            'utf-8'
          );
        }
      }
    }
  }
}

// --- Final write (called on longrun_confirm) ---

/**
 * Writes all markdown files from the complete spec, then writes tasks.txt and validations.txt.
 * Should be called once when the full spec is confirmed.
 *
 * @param {string} longrunRoot
 * @param {object} spec - Complete spec object
 * @returns {{ allTaskUuids: string[], allEpicUuids: string[] }}
 */
export function writeFinalSpec(longrunRoot, spec) {
  writePartialSpec(longrunRoot, spec);

  const allTaskUuids = getAllTasksInOrder(spec).map((t) => t.uuid);
  const allEpicUuids = getAllEpicsInOrder(spec).map((e) => e.uuid);

  writeTasksTxt(longrunRoot, allTaskUuids);
  writeValidationsTxt(longrunRoot, allEpicUuids);

  return { allTaskUuids, allEpicUuids };
}

/**
 * Writes tasks.txt with all task UUIDs in execution order, status=pending.
 */
export function writeTasksTxt(longrunRoot, allTaskUuids) {
  writeFileSync(
    join(longrunRoot, 'tasks.txt'),
    allTaskUuids.map((uuid) => `${uuid} pending`).join('\n') + '\n',
    'utf-8'
  );
}

/**
 * Writes validations.txt with all epic UUIDs in order, status=pending.
 */
export function writeValidationsTxt(longrunRoot, allEpicUuids) {
  writeFileSync(
    join(longrunRoot, 'validations.txt'),
    allEpicUuids.map((uuid) => `${uuid} pending`).join('\n') + '\n',
    'utf-8'
  );
}

// --- Progress tracking ---

/**
 * Reads tasks.txt and returns ordered list of { uuid, status } objects.
 * @param {string} longrunRoot
 * @returns {{ uuid: string, status: string }[]}
 */
export function readTasksList(longrunRoot) {
  const path = join(longrunRoot, 'tasks.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(' ');
      return { uuid: parts[0], status: parts[1] || 'pending' };
    });
}

/**
 * Updates a single task entry status in tasks.txt (pending|done).
 */
export function markTaskStatus(longrunRoot, taskUuid, status) {
  const tasks = readTasksList(longrunRoot);
  const updated = tasks.map((t) =>
    t.uuid === taskUuid ? `${t.uuid} ${status}` : `${t.uuid} ${t.status}`
  );
  writeFileSync(join(longrunRoot, 'tasks.txt'), updated.join('\n') + '\n', 'utf-8');
}

/**
 * Reads validations.txt and returns ordered list of { uuid, status } objects.
 * @param {string} longrunRoot
 * @returns {{ uuid: string, status: string }[]}
 */
export function readValidationsList(longrunRoot) {
  const path = join(longrunRoot, 'validations.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(' ');
      return { uuid: parts[0], status: parts[1] || 'pending' };
    });
}

/**
 * Updates a single epic validation entry status in validations.txt (pending|validated|failed).
 */
export function markEpicValidationStatus(longrunRoot, epicUuid, status) {
  const vals = readValidationsList(longrunRoot);
  const updated = vals.map((v) =>
    v.uuid === epicUuid ? `${v.uuid} ${status}` : `${v.uuid} ${v.status}`
  );
  writeFileSync(join(longrunRoot, 'validations.txt'), updated.join('\n') + '\n', 'utf-8');
}

// --- Spec reading ---

/**
 * Reads a task's markdown file content.
 * @returns {string|null}
 */
export function readTaskFile(longrunRoot, taskUuid) {
  const path = join(longrunRoot, 'tasks', `${taskUuid}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Reads an epic's markdown file content.
 * @returns {string|null}
 */
export function readEpicFile(longrunRoot, epicUuid) {
  const path = join(longrunRoot, 'epics', `${epicUuid}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// --- Spec traversal ---

/**
 * Returns the epic object that contains the given task UUID.
 * @param {object} spec
 * @param {string} taskUuid
 * @returns {object|null} epic object or null
 */
export function findEpicForTask(spec, taskUuid) {
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      for (const epic of (eg?.epics || [])) {
        if ((epic?.tasks || []).some((t) => t.uuid === taskUuid)) {
          return epic;
        }
      }
    }
  }
  return null;
}

/**
 * Returns the ordered list of tasks for a given epic UUID.
 * @param {object} spec
 * @param {string} epicUuid
 * @returns {object[]} task array
 */
export function getTasksForEpic(spec, epicUuid) {
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      for (const epic of (eg?.epics || [])) {
        if (epic.uuid === epicUuid) return epic.tasks || [];
      }
    }
  }
  return [];
}

/**
 * Returns all tasks in execution order as a flat array.
 * @param {object} spec
 * @returns {{ uuid: string, epicUuid: string, epicTitle: string, epicGroupUuid: string }[]}
 */
export function getAllTasksInOrder(spec) {
  const result = [];
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      for (const epic of (eg?.epics || [])) {
        for (const task of (epic?.tasks || [])) {
          result.push({
            uuid: task.uuid,
            epicUuid: epic.uuid,
            epicTitle: epic.title || '',
            epicGroupUuid: eg.uuid,
          });
        }
      }
    }
  }
  return result;
}

/**
 * Returns all epics in order as a flat array.
 * @param {object} spec
 * @returns {{ uuid: string, title: string, epicGroupUuid: string }[]}
 */
export function getAllEpicsInOrder(spec) {
  const result = [];
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      for (const epic of (eg?.epics || [])) {
        result.push({ uuid: epic.uuid, title: epic.title || '', epicGroupUuid: eg.uuid });
      }
    }
  }
  return result;
}

/**
 * Finds the epic_group_uuid that contains a given epic UUID.
 * @param {object} spec
 * @param {string} epicUuid
 * @returns {string|null}
 */
export function findEpicGroupForEpic(spec, epicUuid) {
  for (const wave of (spec?.waves || [])) {
    for (const eg of (wave?.epic_groups || [])) {
      if ((eg?.epics || []).some((e) => e.uuid === epicUuid)) {
        return eg.uuid;
      }
    }
  }
  return null;
}

// --- Auto-correct ---

/**
 * Inserts an auto-correct epic into the longrun execution plan.
 * Creates the epic .md file and task .md files, then updates tasks.txt and validations.txt.
 *
 * @param {string} longrunRoot
 * @param {object} params
 * @param {string} params.afterTaskUuid - Insert new tasks after this task UUID in tasks.txt
 * @param {string} params.parentEpicGroupUuid - epic_group_uuid for the new auto-correct epic
 * @param {object} params.autoCorrectEpic - { uuid, title, description, validationInstructions, tasks: [{uuid,title,description}] }
 */
export function insertAutoCorrectEpic(longrunRoot, { afterTaskUuid, parentEpicGroupUuid, autoCorrectEpic }) {
  // Write epic markdown file
  writeFileSync(
    join(longrunRoot, 'epics', `${autoCorrectEpic.uuid}.md`),
    [
      `# Epic: auto-correct-${autoCorrectEpic.title}`,
      `uuid: ${autoCorrectEpic.uuid}`,
      `epic_group_uuid: ${parentEpicGroupUuid || '(auto-correct)'}`,
      '',
      autoCorrectEpic.description || '',
      '',
      '## Validation Instructions',
      autoCorrectEpic.validationInstructions || '',
      '',
      '## Tasks',
      ...(autoCorrectEpic.tasks || []).map((t, i) => `- Task ${i + 1}: ${t.title || t.uuid} — uuid: ${t.uuid}`),
    ].join('\n'),
    'utf-8'
  );

  // Write task markdown files
  for (const task of (autoCorrectEpic.tasks || [])) {
    writeFileSync(
      join(longrunRoot, 'tasks', `${task.uuid}.md`),
      [
        `# Task: ${task.title || '(auto-correct task)'}`,
        `uuid: ${task.uuid}`,
        `epic_uuid: ${autoCorrectEpic.uuid}`,
        '',
        task.description || '',
      ].join('\n'),
      'utf-8'
    );
  }

  // Insert task UUIDs into tasks.txt immediately after afterTaskUuid
  const currentTasks = readTasksList(longrunRoot);
  const insertAfterIdx = currentTasks.findIndex((t) => t.uuid === afterTaskUuid);
  const newEntries = (autoCorrectEpic.tasks || []).map((t) => ({ uuid: t.uuid, status: 'pending' }));
  const spliceIdx = insertAfterIdx >= 0 ? insertAfterIdx + 1 : currentTasks.length;
  currentTasks.splice(spliceIdx, 0, ...newEntries);

  writeFileSync(
    join(longrunRoot, 'tasks.txt'),
    currentTasks.map((t) => `${t.uuid} ${t.status}`).join('\n') + '\n',
    'utf-8'
  );

  // Append epic UUID to validations.txt
  const currentVals = readValidationsList(longrunRoot);
  currentVals.push({ uuid: autoCorrectEpic.uuid, status: 'pending' });
  writeFileSync(
    join(longrunRoot, 'validations.txt'),
    currentVals.map((v) => `${v.uuid} ${v.status}`).join('\n') + '\n',
    'utf-8'
  );
}
