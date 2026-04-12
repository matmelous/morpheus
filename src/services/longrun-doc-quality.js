const DIACRITICS_REGEX = /[\u0300-\u036f]/g;
const TOKEN_REGEX = /[a-z0-9]{3,}/g;

export const MIN_LONGRUN_DOC_LINES = 15;

function normalizeLine(line) {
  return String(line || '')
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNonEmptyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tokenize(text) {
  const normalized = normalizeLine(text);
  return normalized.match(TOKEN_REGEX) || [];
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function jaccardSimilarity(aText, bText) {
  const a = tokenSet(aText);
  const b = tokenSet(bText);
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function pushIssue(issues, path, reason) {
  issues.push({ path, reason });
}

function validateDocumentationBlock({ path, text, minLinesPerSection, references, issues }) {
  const lines = toNonEmptyLines(text);
  if (lines.length < minLinesPerSection) {
    pushIssue(
      issues,
      path,
      `deve ter pelo menos ${minLinesPerSection} linhas nao vazias (atual: ${lines.length})`
    );
    return;
  }

  const normalizedLines = lines.map((line) => normalizeLine(line)).filter(Boolean);
  const uniqueLineCount = new Set(normalizedLines).size;
  const minUniqueLines = Math.max(10, Math.ceil(lines.length * 0.65));
  if (uniqueLineCount < minUniqueLines) {
    pushIssue(
      issues,
      path,
      `tem repeticao interna excessiva (${uniqueLineCount}/${lines.length} linhas unicas)`
    );
  }

  const tokens = tokenize(text);
  const minTokenCount = minLinesPerSection * 7;
  if (tokens.length < minTokenCount) {
    pushIssue(
      issues,
      path,
      `descricao superficial: poucos detalhes (${tokens.length} tokens, minimo recomendado ${minTokenCount})`
    );
  }

  const currentText = String(text || '').trim();
  for (const ref of references || []) {
    const referenceText = String(ref?.text || '').trim();
    if (!referenceText) continue;
    const similarity = jaccardSimilarity(currentText, referenceText);
    if (similarity >= 0.86) {
      pushIssue(
        issues,
        path,
        `muito parecida com ${ref.label} (similaridade ${similarity.toFixed(2)})`
      );
      break;
    }
  }
}

function collectSpecReferences({
  featureDescription,
  waveDescription,
  epicGroupDescription,
  epicDescription,
  validationInstructions,
  previousTaskDescriptions,
}) {
  const refs = [];
  if (featureDescription) refs.push({ label: 'feature.description', text: featureDescription });
  if (waveDescription) refs.push({ label: 'wave.description', text: waveDescription });
  if (epicGroupDescription) refs.push({ label: 'epic_group.description', text: epicGroupDescription });
  if (epicDescription) refs.push({ label: 'epic.description', text: epicDescription });
  if (validationInstructions) refs.push({ label: 'epic.validation_instructions', text: validationInstructions });
  for (let i = 0; i < (previousTaskDescriptions || []).length; i += 1) {
    refs.push({ label: `task[${i}].description`, text: previousTaskDescriptions[i] });
  }
  return refs;
}

export function validateLongrunDocumentationSpec(spec, { minLinesPerSection = MIN_LONGRUN_DOC_LINES } = {}) {
  const issues = [];
  const featureDescription = String(spec?.feature?.description || '').trim();

  if (!spec || typeof spec !== 'object') {
    return {
      ok: false,
      issues: [{ path: 'spec', reason: 'spec_json deve ser um objeto JSON valido' }],
    };
  }

  validateDocumentationBlock({
    path: 'feature.description',
    text: featureDescription,
    minLinesPerSection,
    references: [],
    issues,
  });

  const waves = Array.isArray(spec.waves) ? spec.waves : [];
  for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
    const wave = waves[waveIndex] || {};
    const waveDescription = String(wave.description || '').trim();

    validateDocumentationBlock({
      path: `waves[${waveIndex}].description`,
      text: waveDescription,
      minLinesPerSection,
      references: [{ label: 'feature.description', text: featureDescription }],
      issues,
    });

    const epicGroups = Array.isArray(wave.epic_groups) ? wave.epic_groups : [];
    for (let groupIndex = 0; groupIndex < epicGroups.length; groupIndex += 1) {
      const epicGroup = epicGroups[groupIndex] || {};
      const epicGroupDescription = String(epicGroup.description || '').trim();

      validateDocumentationBlock({
        path: `waves[${waveIndex}].epic_groups[${groupIndex}].description`,
        text: epicGroupDescription,
        minLinesPerSection,
        references: collectSpecReferences({
          featureDescription,
          waveDescription,
        }),
        issues,
      });

      const epics = Array.isArray(epicGroup.epics) ? epicGroup.epics : [];
      for (let epicIndex = 0; epicIndex < epics.length; epicIndex += 1) {
        const epic = epics[epicIndex] || {};
        const epicDescription = String(epic.description || '').trim();
        const validationInstructions = String(epic.validation_instructions || '').trim();

        validateDocumentationBlock({
          path: `waves[${waveIndex}].epic_groups[${groupIndex}].epics[${epicIndex}].description`,
          text: epicDescription,
          minLinesPerSection,
          references: collectSpecReferences({
            featureDescription,
            waveDescription,
            epicGroupDescription,
          }),
          issues,
        });

        validateDocumentationBlock({
          path: `waves[${waveIndex}].epic_groups[${groupIndex}].epics[${epicIndex}].validation_instructions`,
          text: validationInstructions,
          minLinesPerSection,
          references: collectSpecReferences({
            featureDescription,
            waveDescription,
            epicGroupDescription,
            epicDescription,
          }),
          issues,
        });

        const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
        const previousTaskDescriptions = [];
        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
          const task = tasks[taskIndex] || {};
          const taskDescription = String(task.description || '').trim();

          validateDocumentationBlock({
            path: `waves[${waveIndex}].epic_groups[${groupIndex}].epics[${epicIndex}].tasks[${taskIndex}].description`,
            text: taskDescription,
            minLinesPerSection,
            references: collectSpecReferences({
              featureDescription,
              waveDescription,
              epicGroupDescription,
              epicDescription,
              validationInstructions,
              previousTaskDescriptions,
            }),
            issues,
          });

          previousTaskDescriptions.push(taskDescription);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function formatLongrunDocumentationIssues(issues, { maxItems = 18 } = {}) {
  const list = Array.isArray(issues) ? issues.slice(0, Math.max(1, maxItems)) : [];
  if (list.length === 0) return '';

  const lines = list.map((issue) => `- ${issue.path}: ${issue.reason}`);
  return lines.join('\n');
}

