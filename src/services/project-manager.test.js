import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { projectManager } from './project-manager.js';

test('projectManager infers repo names from POSIX and Windows paths', () => {
  assert.equal(projectManager._inferNameFromRepoUrl('https://github.com/org/repo.git'), 'repo');
  assert.equal(projectManager._inferNameFromRepoUrl('C:\\dev\\repo.git'), 'repo');
  assert.equal(projectManager._inferNameFromRepoUrl('C:\\dev\\repo'), 'repo');
});

test('projectManager discovers git repos in nested directories and top-level local projects', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'morpheus-project-scan-'));

  mkdirSync(join(root, 'mood', 'api', '.git'), { recursive: true });
  mkdirSync(join(root, 'argo', 'mobile', '.git'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'package.json'), '{}\n', 'utf-8');
  mkdirSync(join(root, 'mood', 'files'), { recursive: true });

  const discovered = projectManager._discoverDevelopmentProjects(root);

  assert.deepEqual(discovered, [
    join(root, 'argo', 'mobile'),
    join(root, 'mood', 'api'),
    join(root, 'notes'),
  ]);
});
