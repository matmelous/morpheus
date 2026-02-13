import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, normalize, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_FILE = resolve(__dirname, '../../projects.json');

class ProjectManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.projects = new Map();
  }

  _slugifyId(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  _inferNameFromRepoUrl(repoUrl) {
    const s = String(repoUrl || '').trim();
    if (!s) return '';
    const withoutQuery = s.split('?')[0];
    const last = withoutQuery.replace(/\/+$/, '').split('/').pop() || '';
    return last.endsWith('.git') ? last.slice(0, -4) : last;
  }

  _resolveUnderDevelopmentRoot(relPath) {
    const devRoot = resolve(config.developmentRoot);
    const rel = String(relPath || '').trim();
    if (!rel) throw new Error('Missing path');
    if (isAbsolute(rel)) throw new Error('Absolute paths are not allowed here; provide a relative folder under DEVELOPMENT_ROOT');

    const norm = normalize(rel);
    if (norm === '..' || norm.startsWith(`..${sep}`)) {
      throw new Error('Path traversal is not allowed');
    }

    const full = resolve(devRoot, norm);
    if (!(full === devRoot || full.startsWith(devRoot + sep))) {
      throw new Error('Resolved path is outside DEVELOPMENT_ROOT');
    }
    return full;
  }

  _readProjectsFile() {
    const raw = readFileSync(PROJECTS_FILE, 'utf-8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('projects.json must be a non-empty array');
    }
    return list;
  }

  _writeProjectsFile(list) {
    writeFileSync(PROJECTS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf-8');
  }

  bulkUpsertProjects(projects) {
    const list = this._readProjectsFile();
    const byId = new Map(list.map((p) => [p?.id, p]));

    let changed = false;
    for (const proj of projects || []) {
      const projectId = String(proj?.id || '').trim();
      const projectCwd = String(proj?.cwd || '').trim();
      if (!projectId || !projectCwd) continue;

      const next = {
        id: projectId,
        cwd: projectCwd,
      };
      if (proj?.name) next.name = String(proj.name);
      if (proj?.type) next.type = String(proj.type);

      const existing = byId.get(projectId);
      if (existing) {
        byId.set(projectId, { ...existing, ...next });
      } else {
        byId.set(projectId, next);
      }
      changed = true;
    }

    if (!changed) return { changed: false, count: 0 };

    const nextList = Array.from(byId.values());
    this._writeProjectsFile(nextList);
    this.loadProjects();
    return { changed: true, count: projects?.length || 0 };
  }

  loadProjects() {
    const list = this._readProjectsFile();

    this.projects.clear();

    for (const project of list) {
      if (!project.id || !project.cwd) {
        throw new Error(`Project missing required fields (id, cwd): ${JSON.stringify(project)}`);
      }

      this.projects.set(project.id, {
        id: project.id,
        name: project.name || project.id,
        cwd: project.cwd,
        type: project.type || 'generic',
      });
    }

    logger.info(
      { count: this.projects.size, ids: Array.from(this.projects.keys()) },
      'Projects loaded'
    );
  }

  /**
   * Create a new local project directory under DEVELOPMENT_ROOT and register it in projects.json.
   */
  createProject(name, type = 'local') {
    // Backward-compatible signature: createProject({ name, type, repoUrl })
    if (name && typeof name === 'object') {
      const { name: n, type: t = 'local' } = name;
      return this.createProject(n, t);
    }

    const projectName = String(name || '').trim();
    if (!projectName) throw new Error('Missing project name');

    const projectCwd = this._resolveUnderDevelopmentRoot(projectName);
    const projectId = this._slugifyId(projectName);
    if (!projectId) throw new Error('Invalid project name');

    if (existsSync(projectCwd)) {
      throw new Error(`Project directory already exists: ${projectCwd}`);
    }

    logger.info({ projectCwd }, 'Creating project directory...');
    mkdirSync(projectCwd, { recursive: true });

    return this.upsertProject({ id: projectId, cwd: projectCwd, name: projectName, type });
  }

  /**
   * Register an existing folder under DEVELOPMENT_ROOT as a project.
   */
  registerDevFolder({ id, folder, name = null, type = 'local' }) {
    const projectId = String(id || '').trim();
    const folderName = String(folder || '').trim();
    if (!projectId) throw new Error('Missing project id');
    if (!folderName) throw new Error('Missing folder');

    const projectCwd = this._resolveUnderDevelopmentRoot(folderName);
    if (!existsSync(projectCwd)) throw new Error(`Folder does not exist: ${projectCwd}`);
    const st = statSync(projectCwd);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${projectCwd}`);

    const projectName = String(name || folderName).trim();
    return this.upsertProject({ id: projectId, cwd: projectCwd, name: projectName, type });
  }

  scanDevelopmentRoot({ type = 'local' } = {}) {
    const devRoot = resolve(config.developmentRoot);
    const st = statSync(devRoot);
    if (!st.isDirectory()) throw new Error(`DEVELOPMENT_ROOT is not a directory: ${devRoot}`);

    const existing = this._readProjectsFile();
    const usedIds = new Set(existing.map((p) => p?.id).filter(Boolean));
    const usedCwds = new Set(existing.map((p) => p?.cwd).filter(Boolean));

    const entries = readdirSync(devRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => name && !name.startsWith('.'));

    const added = [];
    for (const name of entries) {
      const cwd = resolve(devRoot, name);
      if (usedCwds.has(cwd)) continue;

      let id = this._slugifyId(name);
      if (!id) continue;
      if (usedIds.has(id)) {
        let n = 2;
        while (usedIds.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }

      added.push({ id, name, cwd, type });
      usedIds.add(id);
      usedCwds.add(cwd);
    }

    if (added.length === 0) return { added: 0, projects: [] };

    this.bulkUpsertProjects(added);
    return { added: added.length, projects: added };
  }

  /**
   * Upsert a project in projects.json and refresh the in-memory map.
   * Intended to be called from admin commands.
   */
  upsertProject({ id, cwd, name = null, type = null }) {
    const projectId = String(id || '').trim();
    const projectCwd = String(cwd || '').trim();
    if (!projectId) throw new Error('Missing project id');
    if (!projectCwd) throw new Error('Missing project cwd');

    const list = this._readProjectsFile();
    const idx = list.findIndex((p) => p?.id === projectId);

    const next = {
      id: projectId,
      cwd: projectCwd,
    };
    if (name) next.name = String(name);
    if (type) next.type = String(type);

    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.push(next);

    this._writeProjectsFile(list);
    this.loadProjects();

    return this.getProject(projectId);
  }

  /**
   * Remove a project from projects.json and refresh the in-memory map.
   */
  removeProject(id) {
    const projectId = String(id || '').trim();
    if (!projectId) throw new Error('Missing project id');

    const list = this._readProjectsFile();
    const next = list.filter((p) => p?.id !== projectId);
    if (next.length === 0) {
      throw new Error('Cannot remove the last remaining project');
    }
    if (next.length === list.length) return false;

    this._writeProjectsFile(next);
    this.loadProjects();
    return true;
  }

  getProject(id) {
    return this.projects.get(id) || null;
  }

  getDefaultProject() {
    const defaultId = config.defaultProjectId;
    const project = defaultId ? this.projects.get(defaultId) : null;

    if (project) return project;

    const first = this.projects.values().next().value;
    if (first) {
      if (defaultId) logger.warn({ defaultId, fallbackId: first.id }, 'Default project not found, using fallback');
      return first;
    }

    throw new Error('No projects configured');
  }

  listProjects() {
    return Array.from(this.projects.values());
  }
}

export const projectManager = new ProjectManager();
export default projectManager;
