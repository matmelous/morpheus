import test from 'node:test';
import assert from 'node:assert/strict';
import { projectManager } from './project-manager.js';

test('projectManager infers repo names from POSIX and Windows paths', () => {
  assert.equal(projectManager._inferNameFromRepoUrl('https://github.com/org/repo.git'), 'repo');
  assert.equal(projectManager._inferNameFromRepoUrl('C:\\dev\\repo.git'), 'repo');
  assert.equal(projectManager._inferNameFromRepoUrl('C:\\dev\\repo'), 'repo');
});
