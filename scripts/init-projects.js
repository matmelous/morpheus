import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const projectsPath = resolve(appRoot, 'projects.json');
const envPath = resolve(appRoot, '.env');
const envExamplePath = resolve(appRoot, '.env.example');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateDirectory(pathValue) {
  const full = resolve(pathValue);
  if (!existsSync(full)) {
    throw new Error(`Path does not exist: ${full}`);
  }
  const st = statSync(full);
  if (!st.isDirectory()) {
    throw new Error(`Path is not a directory: ${full}`);
  }
  return full;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) throw new Error('Phone number is required');
  return digits;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function upsertEnvVar(content, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  const base = content.endsWith('\n') ? content : `${content}\n`;
  return `${base}${line}\n`;
}

function ensureEnvExists() {
  if (existsSync(envPath)) return;
  if (!existsSync(envExamplePath)) {
    throw new Error(`Missing .env and .env.example at ${appRoot}`);
  }
  copyFileSync(envExamplePath, envPath);
}

function updateEnvWithPhoneAndDefaultProject(phone, projectId) {
  ensureEnvExists();
  let envContent = readFileSync(envPath, 'utf-8');

  const allowedMatch = envContent.match(/^ALLOWED_PHONE_NUMBERS=(.*)$/m);
  const currentAllowed = parseCsv(allowedMatch?.[1] || '');
  if (!currentAllowed.includes(phone)) currentAllowed.push(phone);

  envContent = upsertEnvVar(envContent, 'ALLOWED_PHONE_NUMBERS', currentAllowed.join(','));

  const defaultProjectMatch = envContent.match(/^DEFAULT_PROJECT_ID=(.*)$/m);
  const currentDefault = String(defaultProjectMatch?.[1] || '').trim();
  if (!currentDefault || currentDefault === 'INSERT_DEFAULT_PROJECT_ID' || currentDefault === 'sharp-bohr') {
    envContent = upsertEnvVar(envContent, 'DEFAULT_PROJECT_ID', projectId);
  }

  writeFileSync(envPath, envContent, 'utf-8');
}

function startDevServer() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: appRoot,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const rl = readline.createInterface({ input, output });
  let projectId = '';

  try {
    if (!existsSync(projectsPath)) {
      console.log('First-time setup: creating projects.json');
      const rawPath = (await rl.question('Path of your first project: ')).trim();
      if (!rawPath) throw new Error('Project path is required');

      const cwd = validateDirectory(rawPath);
      const guessedName = basename(cwd);
      const rawName = (await rl.question(`Project name [${guessedName}]: `)).trim();
      const projectName = rawName || guessedName;
      const rawType = (await rl.question('Project type [local] (ex: local, git, generic): ')).trim();
      const projectType = rawType || 'local';

      projectId = slugify(projectName);
      if (!projectId) throw new Error('Could not infer a valid project id from the project name');

      const payload = [{ id: projectId, name: projectName, cwd, type: projectType }];
      writeFileSync(projectsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      console.log(`Created ${projectsPath}`);
    } else {
      console.log(`projects.json already exists at ${projectsPath}`);
      const current = JSON.parse(readFileSync(projectsPath, 'utf-8'));
      projectId = String(current?.[0]?.id || '').trim();
    }

    if (!projectId) {
      throw new Error('Could not determine a project id to set as default');
    }

    const rawPhone = (await rl.question('Allowed phone number (country code, no +): ')).trim();
    const allowedPhone = normalizePhone(rawPhone);
    updateEnvWithPhoneAndDefaultProject(allowedPhone, projectId);
    console.log(`Updated ${envPath} (ALLOWED_PHONE_NUMBERS + DEFAULT_PROJECT_ID when empty)`);
  } finally {
    rl.close();
  }

  console.log('Starting server with npm run dev...');
  startDevServer();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
