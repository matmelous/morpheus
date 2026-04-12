import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLongrunDocumentationSpec } from './longrun-doc-quality.js';

function makeLines(prefix, count = 15) {
  const vocab = {
    feature: ['estrategia', 'mercado', 'persona', 'objetivo', 'roadmap', 'governanca', 'risco'],
    wave: ['pipeline', 'orquestracao', 'sequenciamento', 'handoff', 'dependencia', 'batch', 'cadencia'],
    'epic-group': ['dominio', 'fronteira', 'agregado', 'cohesao', 'ownership', 'contexto', 'protocolo'],
    epic: ['endpoint', 'contrato', 'persistencia', 'cache', 'idempotencia', 'rollback', 'telemetria'],
    validation: ['assert', 'mock', 'fixture', 'coverage', 'regressao', 'confiabilidade', 'observacao'],
    task: ['script', 'arquivo', 'comando', 'parametro', 'execucao', 'checagem', 'resultado'],
  }[prefix] || ['topico', 'detalhe', 'contexto', 'decisao', 'evidencia', 'teste', 'criterio'];

  const lines = [];
  for (let i = 1; i <= count; i += 1) {
    const a = vocab[i % vocab.length];
    const b = vocab[(i + 2) % vocab.length];
    const c = vocab[(i + 4) % vocab.length];
    lines.push(
      `${prefix}-${a}-${i} ${prefix}-${b}-${i} ${prefix}-${c}-${i} ` +
      `${prefix}-especificidade-${i} ${prefix}-criterio-${i}`
    );
  }
  return lines.join('\n');
}

test('validateLongrunDocumentationSpec accepts dense and non-repetitive spec', () => {
  const spec = {
    feature: {
      description: makeLines('feature'),
    },
    waves: [{
      description: makeLines('wave'),
      epic_groups: [{
        description: makeLines('epic-group'),
        epics: [{
          description: makeLines('epic'),
          validation_instructions: makeLines('validation'),
          tasks: [{
            description: makeLines('task'),
          }],
        }],
      }],
    }],
  };

  const out = validateLongrunDocumentationSpec(spec, { minLinesPerSection: 15 });
  assert.equal(out.ok, true);
  assert.equal(out.issues.length, 0);
});

test('validateLongrunDocumentationSpec rejects short and repetitive descriptions', () => {
  const weak = 'texto fraco repetido\ntexto fraco repetido\ntexto fraco repetido';
  const spec = {
    feature: { description: weak },
    waves: [{
      description: weak,
      epic_groups: [{
        description: weak,
        epics: [{
          description: weak,
          validation_instructions: weak,
          tasks: [{ description: weak }],
        }],
      }],
    }],
  };

  const out = validateLongrunDocumentationSpec(spec, { minLinesPerSection: 15 });
  assert.equal(out.ok, false);
  assert.ok(out.issues.length >= 6);
  assert.ok(out.issues.some((issue) => issue.path === 'feature.description'));
  assert.ok(out.issues.some((issue) => issue.path.includes('validation_instructions')));
});
