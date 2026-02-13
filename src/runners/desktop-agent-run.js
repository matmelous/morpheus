import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import os from 'node:os';

// Optional dependency: Playwright. The package is added by this change-set.
import { chromium } from 'playwright';
import { detectPurchaseIntent, parseFirstJsonObject } from './desktop-agent-utils.js';

function nowIso() {
  return new Date().toISOString();
}

function logEvent(obj) {
  process.stdout.write(JSON.stringify({ ts: nowIso(), ...obj }) + '\n');
}

function parseArgs(argv) {
  const out = { prompt: '', cwd: process.cwd(), artifacts: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--prompt') { out.prompt = next || ''; i++; continue; }
    if (a === '--cwd') { out.cwd = next || process.cwd(); i++; continue; }
    if (a === '--artifacts') { out.artifacts = next || ''; i++; continue; }
  }
  return out;
}

function which(cmd) {
  const r = spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' });
  return r.status === 0;
}

function execText(command, args, opts = {}) {
  const r = spawnSync(command, args, { ...opts, encoding: 'utf-8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim()}`);
  return String(r.stdout || '').trim();
}

function safeJsonRead(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function safeWriteJson(path, value) {
  try { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8'); } catch {}
}

const ActionSchema = z.object({
  thought: z.string().optional().default(''),
  tool: z.string(),
  // zod v4 record signature is (keySchema, valueSchema). Using the v3-style overload can throw at runtime.
  args: z.record(z.string(), z.any()).optional().default({}),
  need_confirmation: z.coerce.boolean().optional().default(false),
  final_text: z.string().optional(),
});

function loadChromeProfiles() {
  // macOS Chrome profiles are described in "Local State" (JSON).
  const localStatePath = resolve(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Local State');
  const json = safeJsonRead(localStatePath);
  const infoCache = json?.profile?.info_cache && typeof json.profile.info_cache === 'object'
    ? json.profile.info_cache
    : {};

  /** @type {Array<{ directory: string, name: string }>} */
  const profiles = [];
  for (const [directory, meta] of Object.entries(infoCache)) {
    const name = String(meta?.name || meta?.shortcut_name || directory).trim();
    if (!directory) continue;
    profiles.push({ directory: String(directory), name: name || String(directory) });
  }

  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return { localStatePath, profiles };
}

function parseTesseractTsv(tsvText) {
  const lines = String(tsvText || '').split('\n').filter(Boolean);
  if (lines.length <= 1) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;
    const left = parseInt(cols[6], 10);
    const top = parseInt(cols[7], 10);
    const width = parseInt(cols[8], 10);
    const height = parseInt(cols[9], 10);
    const conf = parseFloat(cols[10]);
    const text = String(cols[11] || '').trim();
    if (!text) continue;
    if (![left, top, width, height].every(Number.isFinite)) continue;
    out.push({ text, conf: Number.isFinite(conf) ? conf : null, left, top, width, height });
  }
  return out;
}

function findOcrHit(boxes, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  // Prefer exact-ish match first.
  const exact = boxes.find((b) => String(b.text).toLowerCase() === q);
  if (exact) return exact;
  // Then substring.
  const sub = boxes.find((b) => String(b.text).toLowerCase().includes(q));
  if (sub) return sub;
  return null;
}

async function openRouterChat({ systemPrompt, userPrompt, model, apiKey, baseUrl, timeoutMs }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const url = `${String(baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 120000).unref?.();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    }
    const text = json?.choices?.[0]?.message?.content || '';
    const usedModel = json?.model || model;
    return { text: String(text), model: String(usedModel) };
  } finally {
    clearTimeout(t);
  }
}

function buildSystemPrompt() {
  return [
    'Voce e um agente de automacao no macOS.',
    'Voce pode controlar um browser isolado (Playwright) e tambem o Chrome real do sistema (com perfis logados) via GUI.',
    'Para tarefas que dependem de contas ja logadas (ex.: Google Chat no perfil "ogi"), prefira usar o Chrome real com o perfil correto.',
    'Sua resposta DEVE ser APENAS um JSON valido (sem markdown, sem texto extra).',
    '',
    'Formato esperado:',
    '{',
    '  "thought": "curto",',
    '  "tool": "web_open|web_click|web_type|web_press|web_extract_text|web_screenshot|chrome_list_profiles|chrome_open_profile|mac_screenshot|mac_ocr|mac_open_app|mac_focus_app|mac_click|mac_type|mac_key|shell|final",',
    '  "args": { ... },',
    '  "need_confirmation": false,',
    '  "final_text": "quando tool=final"',
    '}',
    '',
    'Regras:',
    '- Seja web-first: use Playwright sempre que possivel.',
    '- Se o pedido mencionar um perfil do Chrome (ex.: "perfil da ogi"), use chrome_open_profile e entao navegue no Chrome real via GUI (screenshots + OCR + cliques).',
    '- chrome_open_profile args: {"name": "<nome do perfil>"} (ex.: {"name":"ogi"}).',
    '- Evite usar tool "shell" para navegar no Chrome; prefira mac_screenshot + mac_ocr + mac_click/mac_type/mac_key.',
    '- Use mac_* apenas quando for necessario (apps nativos, browser real do sistema, etc.).',
    '- Se perceber que a proxima acao pode finalizar compra/pagamento/checkout, coloque need_confirmation=true e NAO execute a compra.',
    '- Quando tool="final", preencha final_text com a resposta ao usuario (PT-BR) e inclua onde estao as evidencias (prints).',
  ].join('\n');
}

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + '...';
}

function safeShellAllowed(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return false;
  if (s.includes('rm -rf') || s.includes('sudo') || s.includes('shutdown') || s.includes('reboot')) return false;
  // Keep this list tight. Prefer adding specific tools over opening up a general shell.
  const allow = ['rg', 'jq', 'curl', 'python', 'python3', 'node', 'open', 'osascript'];
  const first = s.split(/\s+/)[0];
  return allow.includes(first);
}

async function main() {
  const { prompt, cwd, artifacts } = parseArgs(process.argv);
  if (!prompt || !artifacts) {
    process.stderr.write('Usage: node desktop-agent-run.js --prompt <text> --cwd <path> --artifacts <path>\\n');
    process.exit(2);
  }

  mkdirSync(artifacts, { recursive: true });
  const evidenceDir = resolve(artifacts, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const resultPath = resolve(artifacts, 'result.json');

  const env = process.env;
  const apiKey = env.OPENROUTER_API_KEY || '';
  const baseUrl = env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = env.OPENROUTER_MODEL || 'google/gemini-3-pro-preview';

  const hasCliclick = which('cliclick');
  const hasTesseract = which('tesseract');
  const chromeProfiles = loadChromeProfiles();

  logEvent({ type: 'model', model });
  logEvent({
    type: 'update',
    text: `desktop-agent: start (cliclick=${hasCliclick ? 'yes' : 'no'}, tesseract=${hasTesseract ? 'yes' : 'no'}, chromeProfiles=${chromeProfiles.profiles.length})`,
  });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const state = {
    step: 0,
    last: null,
    evidence: [],
    pageUrl: '',
    pageText: '',
    desktopOcr: '',
    chromeProfiles,
  };

  function addEvidence(path, caption) {
    state.evidence.push({ path, caption: caption || '' });
  }

  async function web_screenshot(name, caption) {
    const p = resolve(evidenceDir, name);
    await page.screenshot({ path: p, fullPage: true });
    addEvidence(p, caption);
    return p;
  }

  async function mac_screenshot(name, caption) {
    const p = resolve(evidenceDir, name);
    execText('screencapture', ['-x', p]);
    addEvidence(p, caption);
    return p;
  }

  async function maybeOcrDesktop(latestShotPath) {
    if (!hasTesseract) return '';
    try {
      const txt = execText('tesseract', [latestShotPath, 'stdout', '-l', 'eng+por', '--psm', '6'], { maxBuffer: 10 * 1024 * 1024 });
      return truncate(txt, 4000);
    } catch {
      return '';
    }
  }

  async function tesseractTsv(imagePath) {
    if (!hasTesseract) throw new Error('tesseract not installed (mac_ocr)');
    const tsv = execText('tesseract', [imagePath, 'stdout', '-l', 'eng+por', '--psm', '6', 'tsv'], { maxBuffer: 20 * 1024 * 1024 });
    const boxes = parseTesseractTsv(tsv);
    const text = boxes.map((b) => b.text).join(' ').trim();
    return { text: truncate(text, 6000), boxes: boxes.slice(0, 2000) };
  }

  async function observe() {
    state.pageUrl = page.url() || '';
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      state.pageText = truncate(bodyText, 6000);
    } catch {
      state.pageText = '';
    }

    // Always keep a desktop screenshot at the start and after major changes.
    if (state.step === 0) {
      const p = await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, 'Desktop (inicio)');
      state.desktopOcr = await maybeOcrDesktop(p);
    }
  }

  async function runTool(tool, args) {
    if (tool === 'web_open') {
      const url = String(args?.url || args?.href || '').trim();
      if (!url) throw new Error('web_open: missing url');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await web_screenshot(`step-${String(state.step).padStart(4, '0')}-web.png`, `Web: ${url}`);
      return { ok: true };
    }

    if (tool === 'web_click') {
      const selector = args?.selector ? String(args.selector) : null;
      const text = args?.text ? String(args.text) : null;
      if (selector) {
        await page.click(selector, { timeout: 15000 });
      } else if (text) {
        await page.getByText(text, { exact: false }).first().click({ timeout: 15000 });
      } else {
        throw new Error('web_click: missing selector or text');
      }
      await web_screenshot(`step-${String(state.step).padStart(4, '0')}-web.png`, 'Web: apos click');
      return { ok: true };
    }

    if (tool === 'web_type') {
      const selector = String(args?.selector || '').trim();
      const text = String(args?.text ?? '');
      if (!selector) throw new Error('web_type: missing selector');
      await page.fill(selector, text, { timeout: 15000 });
      await web_screenshot(`step-${String(state.step).padStart(4, '0')}-web.png`, 'Web: apos type');
      return { ok: true };
    }

    if (tool === 'web_press') {
      const key = String(args?.key || '').trim();
      if (!key) throw new Error('web_press: missing key');
      await page.keyboard.press(key);
      await web_screenshot(`step-${String(state.step).padStart(4, '0')}-web.png`, `Web: key ${key}`);
      return { ok: true };
    }

    if (tool === 'web_extract_text') {
      const selector = args?.selector ? String(args.selector) : null;
      let txt = '';
      if (selector) {
        txt = await page.locator(selector).innerText({ timeout: 15000 });
      } else {
        txt = await page.evaluate(() => document.body?.innerText || '');
      }
      state.pageText = truncate(txt, 6000);
      return { ok: true, text: state.pageText };
    }

    if (tool === 'web_screenshot') {
      const name = String(args?.name || `step-${String(state.step).padStart(4, '0')}-web.png`);
      await web_screenshot(name, String(args?.caption || 'Web screenshot'));
      return { ok: true };
    }

    if (tool === 'mac_screenshot') {
      const name = String(args?.name || `step-${String(state.step).padStart(4, '0')}-desktop.png`);
      const p = await mac_screenshot(name, String(args?.caption || 'Desktop screenshot'));
      state.desktopOcr = await maybeOcrDesktop(p);
      return { ok: true };
    }

    if (tool === 'mac_ocr') {
      const imagePath = String(args?.imagePath || '').trim();
      if (!imagePath) throw new Error('mac_ocr: missing imagePath');
      const r = await tesseractTsv(imagePath);
      return { ok: true, ...r };
    }

    if (tool === 'mac_open_app') {
      const appName = String(args?.app || args?.appName || '').trim();
      if (!appName) throw new Error('mac_open_app: missing app');
      execText('osascript', ['-e', `tell application "${appName}" to activate`]);
      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, `App: ${appName}`);
      return { ok: true };
    }

    if (tool === 'mac_focus_app') {
      const appName = String(args?.app || args?.appName || '').trim();
      if (!appName) throw new Error('mac_focus_app: missing app');
      execText('osascript', ['-e', `tell application "${appName}" to activate`]);
      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, `Focus: ${appName}`);
      return { ok: true };
    }

    if (tool === 'mac_click') {
      if (!hasCliclick) throw new Error('cliclick not installed (mac_click)');
      const x = Number(args?.x);
      const y = Number(args?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('mac_click: missing x,y');
      execText('cliclick', [`c:${Math.round(x)},${Math.round(y)}`]);
      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, `Click: ${x},${y}`);
      return { ok: true };
    }

    if (tool === 'mac_type') {
      if (!hasCliclick) throw new Error('cliclick not installed (mac_type)');
      const text = String(args?.text ?? '');
      execText('cliclick', [`t:${text}`]);
      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, 'Type');
      return { ok: true };
    }

    if (tool === 'mac_key') {
      if (!hasCliclick) throw new Error('cliclick not installed (mac_key)');
      const combo = String(args?.key || args?.combo || '').trim();
      if (!combo) throw new Error('mac_key: missing key');
      execText('cliclick', [`kp:${combo}`]);
      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-desktop.png`, `Key: ${combo}`);
      return { ok: true };
    }

    if (tool === 'shell') {
      const command = String(args?.command || '').trim();
      if (!safeShellAllowed(command)) throw new Error('shell: command not allowed');
      const child = spawn('bash', ['-lc', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      await new Promise((resolveP, rejectP) => {
        child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
        child.on('error', rejectP);
        child.on('close', (code) => {
          if (code === 0) return resolveP();
          rejectP(new Error(`shell exit ${code}: ${stderr || stdout}`));
        });
      });
      return { ok: true, stdout: truncate(stdout, 6000), stderr: truncate(stderr, 2000) };
    }

    if (tool === 'chrome_list_profiles') {
      return { ok: true, profiles: chromeProfiles.profiles, localStatePath: chromeProfiles.localStatePath };
    }

    if (tool === 'chrome_open_profile') {
      if (!hasCliclick) throw new Error('cliclick not installed (chrome_open_profile)');
      const profileName = String(args?.name || args?.profile || '').trim();
      if (!profileName) throw new Error('chrome_open_profile: missing name');

      // Open (or reuse) profile picker and click the profile by visible name.
      // Important: avoid piling up dozens of duplicate tabs by reusing an existing profile picker tab/window.
      execText('osascript', ['-e', `
        tell application "Google Chrome"
          activate
          set found to false
          repeat with w in windows
            repeat with t in tabs of w
              try
                if (URL of t) starts with "chrome://profile-picker" then
                  set active tab index of w to (index of t)
                  set found to true
                  exit repeat
                end if
              end try
            end repeat
            if found then exit repeat
          end repeat
          if not found then
            make new window
            set URL of active tab of front window to "chrome://profile-picker/"
          end if
        end tell
      `.trim()]);

      // Give the UI a moment to render.
      await new Promise((r) => setTimeout(r, 1200));

      const shotPath = await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-chrome-profiles.png`, 'Chrome profile picker');
      const ocr = await tesseractTsv(shotPath);
      const hit = findOcrHit(ocr.boxes, profileName);
      if (!hit) {
        return {
          ok: false,
          error: `Profile name not found on screen: "${profileName}"`,
          screenshot: shotPath,
          ocrText: ocr.text,
          knownProfiles: chromeProfiles.profiles,
        };
      }

      const cx = hit.left + Math.round(hit.width / 2);
      const cy = hit.top + Math.round(hit.height / 2);
      execText('cliclick', [`c:${cx},${cy}`]);
      await new Promise((r) => setTimeout(r, 1500));

      // Close remaining profile picker tabs to avoid leaving dozens of duplicates around.
      execText('osascript', ['-e', `
        tell application "Google Chrome"
          repeat with w in windows
            set keepOne to true
            repeat with t in (tabs of w)
              try
                if (URL of t) starts with "chrome://profile-picker" then
                  if keepOne then
                    set keepOne to false
                  else
                    close t
                  end if
                end if
              end try
            end repeat
          end repeat
        end tell
      `.trim()]);

      await mac_screenshot(`step-${String(state.step).padStart(4, '0')}-chrome-opened.png`, `Chrome profile opened: ${profileName}`);
      return { ok: true, profileName, click: { x: cx, y: cy }, screenshot: shotPath };
    }

    throw new Error(`Unknown tool: ${tool}`);
  }

  const maxSteps = 30;
  let finalText = '';

  try {
    for (state.step = 0; state.step < maxSteps; state.step++) {
      await observe();

      const userPrompt = [
        'Tarefa do usuario:',
        prompt,
        '',
        'Observacao atual:',
        `- pageUrl: ${state.pageUrl || '(none)'}`,
        `- pageText: ${state.pageText ? JSON.stringify(state.pageText) : '(empty)'}`,
        state.desktopOcr ? `- desktopOcr: ${JSON.stringify(state.desktopOcr)}` : '- desktopOcr: (unavailable)',
        `- chromeProfiles: ${JSON.stringify(state.chromeProfiles?.profiles || []).slice(0, 2000)}`,
        state.last ? `- lastResult: ${JSON.stringify(state.last).slice(0, 2000)}` : '- lastResult: (none)',
        '',
        'Escolha a proxima acao como JSON.',
      ].join('\n');

      const { text: assistant, model: usedModel } = await openRouterChat({
        systemPrompt: buildSystemPrompt(),
        userPrompt,
        model,
        apiKey,
        baseUrl,
        timeoutMs: 120000,
      });

      logEvent({ type: 'model', model: usedModel });

      const raw = parseFirstJsonObject(assistant);
      if (!raw) throw new Error(`Model did not return JSON. Got: ${truncate(assistant, 800)}`);
      const action = ActionSchema.parse(raw);

      // Purchase gate: allow the model to signal confirmation requirement, but also enforce heuristics.
      const wantsConfirm = Boolean(action.need_confirmation) || detectPurchaseIntent(`${action.tool} ${JSON.stringify(action.args)} ${state.pageUrl} ${state.pageText}`);
      if (wantsConfirm) {
        const shot = await web_screenshot('checkout.png', 'Possivel checkout/compra detectado');
        safeWriteJson(resultPath, {
          status: 'blocked',
          blocked_reason: 'purchase_confirmation',
          message: 'Bloqueado aguardando confirmacao de compra.',
          evidence: state.evidence.slice(-3),
          purchase_context: {
            original_prompt: prompt,
            page_url: state.pageUrl,
            screenshot: shot,
            suggested_next: { tool: action.tool, args: action.args },
          },
        });
        logEvent({ type: 'blocked', reason: 'purchase_confirmation', message: 'needs confirmation', summary: 'Aguardando confirmacao de compra' });
        await browser.close();
        process.exit(0);
      }

      if (action.tool === 'final') {
        finalText = String(action.final_text || '').trim() || 'Concluido.';
        await web_screenshot('final.png', 'Estado final (web)');
        safeWriteJson(resultPath, { status: 'done', final_text: finalText, evidence: state.evidence.slice(-3) });
        logEvent({ type: 'final', text: finalText });
        await browser.close();
        process.exit(0);
      }

      logEvent({ type: 'update', text: `step ${state.step + 1}/${maxSteps}: ${action.tool}` });
      state.last = await runTool(action.tool, action.args);
    }

    finalText = 'Limite de passos atingido. Nao foi possivel concluir com confianca.';
    safeWriteJson(resultPath, { status: 'error', final_text: finalText, evidence: state.evidence.slice(-3) });
    logEvent({ type: 'final', text: finalText });
    await browser.close();
    process.exit(1);
  } catch (err) {
    const msg = err?.message || String(err);
    finalText = `Erro no desktop-agent: ${msg}`;
    safeWriteJson(resultPath, { status: 'error', final_text: finalText, evidence: state.evidence.slice(-3) });
    logEvent({ type: 'final', text: finalText });
    try { await browser.close(); } catch {}
    process.exit(1);
  }
}

main();
