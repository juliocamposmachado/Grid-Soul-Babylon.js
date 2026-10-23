import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { AutomationStore } from './store.js';
import { createPinnedHttpsProxy } from './network-proxy.js';
import {
  CATEGORIES, MAX_FILE_BYTES, MAX_OUTPUT_BYTES, isPublicAddress,
  isSensitivePath, isWithinRoots, parseSafeCommand, validateHttpsOrigin
} from './policy.js';

const APPROVAL_TTL_MS = 120_000;
const TASK_OUTPUT_LIMIT = MAX_OUTPUT_BYTES;
const SENSITIVE_COMMAND_OUTPUT = /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|senha|secret|client[_ -]?secret|authorization)\s*[:=]\s*[^\s,;]+/gi;
const BEARER_OUTPUT = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const COMMON_KEY_OUTPUT = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gi;
const APP_COMMANDS = Object.freeze({
  calculator: {
    linux: ['gnome-calculator'], darwin: ['open', '-a', 'Calculator'], win32: ['calc.exe']
  },
  textEditor: {
    linux: ['gedit'], darwin: ['open', '-a', 'TextEdit'], win32: ['notepad.exe']
  }
});

function redactForDisplay(text) {
  return String(text ?? '')
    .replace(SENSITIVE_COMMAND_OUTPUT, '$1=[REDACTED]')
    .replace(BEARER_OUTPUT, 'Bearer [REDACTED]')
    .replace(COMMON_KEY_OUTPUT, '[REDACTED_KEY]')
    .slice(0, TASK_OUTPUT_LIMIT);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function escapeHtmlText(value) { return String(value ?? '').slice(0, 1000); }

async function assertPublicHost(hostname, cache) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Destino local ou privado bloqueado.');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Endereço IP privado bloqueado.');
    return;
  }
  const cached = cache.get(host);
  if (cached && cached.until > Date.now()) {
    if (!cached.public) throw new Error('O domínio resolve para uma rede privada e foi bloqueado.');
    return;
  }
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('Não foi possível validar o DNS do domínio; acesso bloqueado por segurança.'); }
  const publicHost = addresses.length > 0 && addresses.every(item => isPublicAddress(item.address));
  cache.set(host, { public: publicHost, until: Date.now() + 60_000 });
  if (!publicHost) throw new Error('O domínio resolve para uma rede privada e foi bloqueado.');
}

async function resolveScopedPath(input, roots, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input || input.length > 1024 || input.includes('\0')) throw new Error('Caminho inválido.');
  if (!roots.length) throw new Error('Conceda uma pasta em Permissões antes de acessar arquivos.');
  const expanded = expandHome(input);
  const candidates = path.isAbsolute(expanded)
    ? [path.resolve(expanded)]
    : roots.map(root => path.resolve(root, expanded));

  for (const candidate of candidates) {
    const storedRoot = roots.find(root => isWithinRoots(candidate, [root]));
    if (!storedRoot) continue;
    const root = await fs.realpath(storedRoot).catch(() => null);
    if (!root) continue;
    const relative = path.relative(root, candidate);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
    if (isSensitivePath(relative)) throw new Error('Acesso a arquivos de credenciais, perfis ou dados protegidos foi bloqueado.');

    if (mustExist) {
      const real = await fs.realpath(candidate).catch(() => null);
      if (!real || !isWithinRoots(real, [root])) continue;
      if (isSensitivePath(path.relative(root, real))) throw new Error('Acesso a arquivos protegidos foi bloqueado.');
      return real;
    }
    const parent = await fs.realpath(path.dirname(candidate)).catch(() => null);
    if (!parent || !isWithinRoots(parent, [root])) continue;
    const finalPath = path.join(parent, path.basename(candidate));
    if (isSensitivePath(path.relative(root, finalPath))) throw new Error('Acesso a arquivos protegidos foi bloqueado.');
    const existing = await fs.lstat(finalPath).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Caminhos de destino simbólicos são bloqueados.');
    if (existing) {
      const real = await fs.realpath(finalPath);
      if (!isWithinRoots(real, [root])) throw new Error('Caminho fora da pasta autorizada.');
      return real;
    }
    return finalPath;
  }
  throw new Error('Caminho fora das pastas autorizadas ou inexistente.');
}

function getTerminalCwd(roots) { return roots[0] || process.cwd(); }

async function listDirectory(directory) {
  const names = await fs.readdir(directory, { withFileTypes: true });
  return names.slice(0, 200).map(item => `${item.isDirectory() ? '[pasta]' : '[arquivo]'} ${item.name}`).join('\n') || '(pasta vazia)';
}

async function readTextFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('A leitura aceita arquivos de texto de até 256 KiB.');
  const data = await fs.readFile(file);
  if (data.includes(0)) throw new Error('Arquivo binário não pode ser exibido no terminal integrado.');
  return data.toString('utf8');
}

function runProcess(program, args, { cwd, signal, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Execução cancelada.'));
    const env = {
      PATH: process.env.PATH || '',
      HOME: os.homedir(),
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
      SystemRoot: process.env.SystemRoot || '',
      LANG: process.env.LANG || 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat',
      PAGER: 'cat', npm_config_update_notifier: 'false'
    };
    const child = spawn(program, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    let forceTimer = null;
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-TASK_OUTPUT_LIMIT);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (!settled) process.platform === 'win32' ? child.kill() : child.kill('SIGKILL');
      }, 750);
      forceTimer.unref?.();
    };
    const timer = setTimeout(terminate, timeoutMs);
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Não foi possível iniciar o processo permitido (${error.code || 'erro'}).`));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Execução cancelada.'));
      const output = redactForDisplay([stdout, stderr].filter(Boolean).join('\n'));
      if (code !== 0) return reject(new Error(output || `Processo encerrado com código ${code}.`));
      resolve(output || '(sem saída)');
    });
  });
}

async function executeTerminal(command, roots, signal) {
  const parsed = parseSafeCommand(command);
  const cwd = getTerminalCwd(roots);
  if (parsed.op === 'pwd') return cwd;
  if (parsed.op === 'date') return new Date().toString();
  if (parsed.op === 'whoami') return os.userInfo().username;
  if (parsed.op === 'uname') return `${os.type()} ${os.release()} ${os.arch()}`;
  if (parsed.op === 'version') {
    if (parsed.program === 'node') return runProcess(process.execPath, ['--version'], { cwd, signal });
    if (parsed.program === 'npm' && process.platform !== 'win32') return runProcess('npm', ['--version'], { cwd, signal });
    if (parsed.program === 'python3' && process.platform !== 'win32') return runProcess('python3', ['--version'], { cwd, signal });
    throw new Error(`A consulta de versão de ${parsed.program} não está disponível neste sistema.`);
  }
  if (parsed.op === 'git') {
    const gitArgs = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', ...parsed.args];
    return runProcess('git', gitArgs, { cwd, signal });
  }
  const file = await resolveScopedPath(parsed.operand, roots);
  if (parsed.op === 'list') return listDirectory(file);
  const text = await readTextFile(file);
  if (parsed.op === 'read') return text;
  const lines = text.split(/\r?\n/);
  if (parsed.op === 'head') return lines.slice(0, parsed.count).join('\n');
  if (parsed.op === 'tail') return lines.slice(-parsed.count).join('\n');
  if (parsed.op === 'grep') {
    const matched = lines.map((line, index) => ({ line, index })).filter(row => row.line.includes(parsed.pattern)).slice(0, 100);
    return matched.map(row => parsed.numbered ? `${row.index + 1}:${row.line}` : row.line).join('\n') || '(nenhuma ocorrência)';
  }
  throw new Error('Operação não implementada.');
}

function openDetachedProcess(program, args, { cwd, signal, onStarted = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Execução cancelada.'));
    const child = spawn(program, args, {
      cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      env: { PATH: process.env.PATH || '', HOME: os.homedir(), USERPROFILE: process.env.USERPROFILE || os.homedir(), SystemRoot: process.env.SystemRoot || '' },
      stdio: 'ignore'
    });
    const onAbort = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Não foi possível abrir o aplicativo (${error.code || 'erro'}).`));
    });
    child.once('spawn', () => {
      signal?.removeEventListener('abort', onAbort);
      onStarted();
      child.unref();
      resolve('Aplicativo nativo iniciado.');
    });
  });
}

function classifyInput(element, accessibleLabel = '') {
  const type = String(element?.type || '').toLowerCase();
  if (['password', 'hidden', 'file', 'button', 'submit', 'reset', 'image'].includes(type) || element?.disabled || element?.readOnly) {
    throw new Error('Esse tipo de campo não pode ser preenchido pela automação. Campos de senha/arquivo são sempre bloqueados.');
  }
  const label = `${accessibleLabel} ${element?.labelText || ''} ${element?.placeholder || ''} ${element?.name || ''} ${element?.id || ''} ${element?.autocomplete || ''} ${element?.ariaLabel || ''}`;
  const sensitive = /password|senha|passcode|one[-_ ]?time[-_ ]?code|otp|cvv|cvc|credit.?card|cart[aã]o|bank|banco|iban|swift|routing|transfer|payment|pagamento|cpf|ssn|social.?security|token|secret|email|e-mail|phone|telefone|mobile|address|endereco|postal|zipcode|birth|nascimento|username|user.?name|login|account|conta|tax.?id/i.test(label);
  if (sensitive) throw new Error('Campo identificado como credencial, dado financeiro ou identificador sensível; preenchimento automatizado bloqueado.');
}

export function createAutomationRouter({ rootDirectory, port }) {
  const router = express.Router();
  const storageDir = process.env.GRID_SOUL_AUTOMATION_DIR
    ? path.resolve(process.env.GRID_SOUL_AUTOMATION_DIR)
    : path.join(rootDirectory, 'data', 'automation');
  const store = new AutomationStore(storageDir);
  const tasks = new Map();
  const subscribers = new Set();
  const dnsCache = new Map();
  let browser = null;
  let browserContext = null;
  let browserPage = null;
  let pinnedProxy = null;
  let browserQueue = Promise.resolve();
  let browserClosePromise = Promise.resolve();

  function publish(event, data) {
    const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of subscribers) response.write(packet);
  }
  function publicTask(task) {
    return {
      id: task.id, category: task.category, action: task.action, summary: task.summary,
      status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      output: task.output, result: task.result, error: task.error,
      requiresConfirmation: task.status === 'awaiting_confirmation',
      confirmation: task.confirmation
    };
  }
  function recordAudit(entry) {
    const saved = store.audit(entry);
    if (saved) publish('audit', store.recentAudit(100));
    return saved;
  }
  function audit(task, status) {
    return recordAudit({ taskId: task?.id, category: task?.category, action: task?.action, status });
  }
  function emitTask(task) {
    task.updatedAt = new Date().toISOString();
    publish('task', publicTask(task));
  }
  function activeTasks(category = null) {
    return [...tasks.values()].filter(task => (!category || task.category === category) && ['awaiting_confirmation', 'running'].includes(task.status));
  }
  function clearBrowserResults() {
    for (const task of tasks.values()) {
      if (task.category !== 'browser' || task.action !== 'read') continue;
      clearTimeout(task.contentExpiry);
      task.contentExpiry = null;
      task.output = '';
      task.result = '';
    }
  }
  async function closeBrowser() {
    clearBrowserResults();
    const old = browser;
    const oldProxy = pinnedProxy;
    browser = null; browserContext = null; browserPage = null;
    pinnedProxy = null;
    if (old || oldProxy) browserClosePromise = (async () => {
      if (old) await old.close().catch(() => {});
      if (oldProxy) await oldProxy.close().catch(() => {});
    })();
    await browserClosePromise;
  }
  function cancelTask(task, reason = 'cancelled') {
    if (!task || !['awaiting_confirmation', 'running'].includes(task.status)) return false;
    task.cancelReason = reason;
    clearTimeout(task.expiry);
    if (task.status === 'awaiting_confirmation') {
      task.status = 'cancelled'; task.output = 'Aguardando execução: aprovação cancelada.';
      task.confirmation = null; task.execute = null;
      if (!audit(task, 'cancelled')) task.error = 'Cancelada, mas a auditoria não pôde registrar a recusa/interrupção.';
      emitTask(task);
    } else {
      task.controller.abort();
      if (task.effectStarted) {
        task.status = 'interrupted_after_effect';
        task.error = 'Interrompida após o efeito começar; o resultado pode ser irreversível ou incerto.';
        if (!audit(task, 'interrupted_after_effect')) task.error += ' A auditoria também está indisponível.';
        emitTask(task);
      }
      if (task.category === 'browser') void closeBrowser();
    }
    return true;
  }
  async function startTask(task) {
    if (task.status !== 'queued') return;
    if (!store.permissions.enabled[task.category]) {
      task.status = 'cancelled'; task.error = 'Permissão revogada antes da execução.';
      audit(task, 'permission_revoked'); emitTask(task); return;
    }
    task.status = 'running';
    task.controller = new AbortController();
    emitTask(task);
    try {
      if (!audit(task, 'started')) {
        task.status = 'failed';
        task.error = 'Execução bloqueada: gravação de auditoria indisponível.';
        return;
      }
      const execute = task.execute;
      task.execute = null;
      const result = await execute(task.controller.signal, text => {
        task.output = redactForDisplay(text);
        emitTask(task);
      }, () => { task.effectStarted = true; });
      if (task.controller.signal.aborted && !task.effectStarted) throw new Error('Execução cancelada.');
      task.result = redactForDisplay(result);
      task.output = task.result;
      if (task.status !== 'interrupted_after_effect') {
        task.status = 'completed';
        if (task.controller.signal.aborted && task.effectStarted) task.result += '\nO efeito concluiu antes de a interrupção ser processada.';
        task.output = task.result;
        if (!audit(task, 'completed')) task.error = 'Concluída, mas a auditoria não pôde registrar o resultado.';
      }
    } catch (error) {
      if (task.status === 'interrupted_after_effect') {
        // O estado já registra que não é possível garantir rollback.
      } else if (task.effectStarted) {
        task.status = 'interrupted_after_effect';
        task.error = `A operação já havia iniciado; o resultado pode ser parcial ou incerto. ${String(error?.message || '').slice(0, 300)}`;
        if (!audit(task, 'interrupted_after_effect')) task.error += ' A auditoria também está indisponível.';
      } else if (task.controller.signal.aborted || task.cancelReason) {
        task.status = 'cancelled';
        task.error = 'Execução interrompida pelo usuário ou por revogação de permissão.';
        if (!audit(task, 'cancelled')) task.error = 'Cancelada, mas a auditoria também está indisponível.';
      } else {
        task.status = 'failed';
        task.error = String(error?.message || 'Falha na execução.').slice(0, 1000);
        if (!audit(task, 'failed')) task.error += ' A auditoria também está indisponível.';
      }
    } finally {
      task.confirmation = null;
      task.execute = null;
      if (task.category === 'browser' && task.action === 'read' && task.output) {
        task.contentExpiry = setTimeout(() => { task.output = ''; task.result = ''; task.contentExpiry = null; }, 60_000);
        task.contentExpiry.unref?.();
      }
      emitTask(task);
    }
  }
  function createTask({ category, action, summary, confirmation = null, execute }) {
    const task = {
      id: randomUUID(), category, action, summary: String(summary).slice(0, 500),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: confirmation ? 'awaiting_confirmation' : 'queued',
      confirmation, execute, controller: null, output: '', result: '', error: '', cancelReason: '', effectStarted: false,
      done: null, contentExpiry: null
    };
    tasks.set(task.id, task);
    if (tasks.size > 200) {
      for (const [id, old] of tasks) {
        if (!['running', 'awaiting_confirmation', 'queued'].includes(old.status)) tasks.delete(id);
        if (tasks.size <= 150) break;
      }
    }
    if (!audit(task, confirmation ? 'awaiting_confirmation' : 'requested')) {
      tasks.delete(task.id);
      task.confirmation = null; task.execute = null;
      throw new Error('Auditoria indisponível; nenhuma tarefa foi iniciada.');
    }
    emitTask(task);
    if (confirmation) {
      task.expiry = setTimeout(() => cancelTask(task, 'expired'), APPROVAL_TTL_MS);
      task.expiry.unref?.();
    } else {
      task.done = startTask(task);
    }
    return task;
  }
  function requirePermission(category) {
    if (!store.permissions.enabled[category]) throw Object.assign(new Error(`Permissão ${category} está desativada.`), { status: 403 });
  }
  function jsonError(res, error, fallback = 'Falha na solicitação.') {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    res.status(status).json({ error: String(error?.message || fallback).slice(0, 1000) });
  }
  async function revalidateTaskPath(input, expected, mustExist) {
    requirePermission('files');
    const actual = await resolveScopedPath(input, store.permissions.fileRoots, { mustExist });
    if (path.resolve(actual) !== path.resolve(expected)) throw new Error('O caminho autorizado mudou desde a solicitação.');
    const root = store.permissions.fileRoots.find(candidate => isWithinRoots(actual, [candidate]));
    if (!root) throw new Error('A pasta autorizada foi revogada.');
    const rootInfo = await fs.lstat(root);
    if (rootInfo.isSymbolicLink()) throw new Error('A raiz de arquivos tornou-se um link simbólico.');
    const relative = path.relative(root, actual);
    let cursor = root;
    const parts = relative.split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]);
      const info = await fs.lstat(cursor).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error('Link simbólico em pasta-pai bloqueado.');
      if (index < parts.length - 1 && info && !info.isDirectory()) throw new Error('Componente de caminho não é uma pasta.');
    }
    return actual;
  }
  const sameFileIdentity = (first, second) => Boolean(first && second && first.dev === second.dev && first.ino === second.ino);
  function verifyLocalRequest(req, res, next) {
    try {
      const host = req.get('host') || '';
      const hostUrl = new URL(`http://${host}`);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname.toLowerCase()) || Number(hostUrl.port || 80) !== Number(port)) {
        return res.status(403).json({ error: 'A API de automação só aceita conexões locais no endereço configurado.' });
      }
      const origin = req.get('origin');
      if (origin) {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || parsed.host !== hostUrl.host || parsed.origin !== `http://${hostUrl.host}`) {
          return res.status(403).json({ error: 'Origem cruzada bloqueada para a API de automação.' });
        }
      }
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Solicitação de outro site bloqueada.' });
      next();
    } catch { res.status(403).json({ error: 'Cabeçalho local inválido.' }); }
  }
  router.use(verifyLocalRequest);
  router.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Envie application/json.' });
    next();
  });

  router.get('/permissions', (_req, res) => res.json({ permissions: store.snapshot(), browserHeadless: process.env.GRID_SOUL_AUTOMATION_HEADLESS !== '0' }));
  router.patch('/permissions/:category', async (req, res) => {
    try {
      const category = req.params.category;
      const enabled = req.body?.enabled === true;
      if (typeof req.body?.enabled !== 'boolean') throw new Error('Informe enabled true/false.');
      if (enabled && req.body?.confirmed !== true) throw new Error('Ativação exige confirmação explícita do usuário.');
      if (!CATEGORIES.includes(category)) throw new Error('Categoria de permissão desconhecida.');
      store.setEnabled(category, enabled);
      if (!enabled) {
        const affected = activeTasks(category);
        for (const task of affected) cancelTask(task, 'permission_revoked');
        await Promise.allSettled(affected.map(task => task.done).filter(Boolean));
        if (category === 'browser') await closeBrowser();
      }
      const auditSaved = recordAudit({ category, action: 'permission', status: enabled ? 'granted' : 'revoked' });
      publish('permissions', store.snapshot());
      res.json({ ok: true, permissions: store.snapshot(), auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });

  router.post('/scopes/files', async (req, res) => {
    try {
      requirePermission('files');
      if (req.body?.confirmed !== true) throw new Error('A concessão de uma pasta exige confirmação explícita.');
      if (typeof req.body?.path !== 'string') throw new Error('Informe a pasta a autorizar.');
      const requested = path.resolve(expandHome(req.body.path));
      const real = await fs.realpath(requested);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('A pasta precisa existir e ser um diretório.');
      if (path.resolve(real) === path.resolve(path.parse(real).root)) throw new Error('A raiz inteira do sistema não pode ser concedida; escolha uma pasta específica.');
      if (isSensitivePath(real)) throw new Error('Pastas de credenciais e perfis não podem ser autorizadas.');
      store.addFileRoot(real);
      const auditSaved = recordAudit({ category: 'files', action: 'scope', status: 'granted' });
      publish('permissions', store.snapshot());
      res.json({ ok: true, permissions: store.snapshot(), auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });
  router.delete('/scopes/files', async (req, res) => {
    try {
      if (typeof req.body?.path !== 'string') throw new Error('Informe a pasta a revogar.');
      const root = store.permissions.fileRoots.find(item => path.resolve(item) === path.resolve(expandHome(req.body.path)));
      if (!root) return res.status(404).json({ error: 'Pasta autorizada não encontrada.' });
      store.removeFileRoot(root);
      const affected = activeTasks('files');
      for (const task of affected) cancelTask(task, 'scope_revoked');
      await Promise.allSettled(affected.map(task => task.done).filter(Boolean));
      const auditSaved = recordAudit({ category: 'files', action: 'scope', status: 'revoked' });
      publish('permissions', store.snapshot());
      res.json({ ok: true, permissions: store.snapshot(), auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });
  router.post('/scopes/browser', async (req, res) => {
    try {
      requirePermission('browser');
      if (req.body?.confirmed !== true) throw new Error('Conceder um domínio exige confirmação explícita.');
      const origin = validateHttpsOrigin(req.body?.origin);
      await assertPublicHost(new URL(origin).hostname, dnsCache);
      store.addBrowserOrigin(origin);
      const auditSaved = recordAudit({ category: 'browser', action: 'scope', status: 'granted' });
      publish('permissions', store.snapshot());
      res.json({ ok: true, permissions: store.snapshot(), auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });
  router.delete('/scopes/browser', async (req, res) => {
    try {
      const origin = validateHttpsOrigin(req.body?.origin);
      if (!store.permissions.browserOrigins.includes(origin)) return res.status(404).json({ error: 'Origem autorizada não encontrada.' });
      store.removeBrowserOrigin(origin);
      const affected = activeTasks('browser');
      for (const task of affected) cancelTask(task, 'scope_revoked');
      await Promise.allSettled(affected.map(task => task.done).filter(Boolean));
      await closeBrowser();
      const auditSaved = recordAudit({ category: 'browser', action: 'scope', status: 'revoked' });
      publish('permissions', store.snapshot());
      res.json({ ok: true, permissions: store.snapshot(), auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });

  router.post('/terminal/run', async (req, res) => {
    try {
      requirePermission('terminal');
      const command = req.body?.command;
      const parsed = parseSafeCommand(command);
      const task = createTask({ category: 'terminal', action: 'command', summary: `CLI ${parsed.op}: comando validado`, execute: signal => executeTerminal(command, store.permissions.fileRoots, signal) });
      res.status(202).json({ task: publicTask(task) });
    } catch (error) { jsonError(res, error); }
  });
  router.post('/terminal/open', (req, res) => {
    try {
      requirePermission('terminal');
      if (req.body?.confirmed !== true) throw new Error('Abrir o terminal nativo exige confirmação explícita.');
      const cwd = getTerminalCwd(store.permissions.fileRoots);
      let program, args;
      if (process.platform === 'darwin') { program = 'open'; args = ['-a', 'Terminal']; }
      else if (process.platform === 'win32') { program = 'cmd.exe'; args = []; }
      else { program = process.env.GRID_SOUL_TERMINAL || 'x-terminal-emulator'; args = []; }
      const task = createTask({ category: 'terminal', action: 'native-terminal', summary: 'Abrir o terminal nativo do sistema', confirmation: { prompt: 'Abrir um terminal nativo fora dos controles do terminal integrado?', details: { cwd } }, execute: (signal, _emit, markEffectStarted) => openDetachedProcess(program, args, { cwd, signal, onStarted: markEffectStarted }) });
      res.status(202).json({ task: publicTask(task) });
    } catch (error) { jsonError(res, error); }
  });

  router.post('/apps/open', (req, res) => {
    try {
      requirePermission('apps');
      const appId = req.body?.app;
      if (appId !== 'browser' && !Object.hasOwn(APP_COMMANDS, appId)) throw new Error('Programa fora da lista permitida (navegador, calculadora, editor de texto).');
      const localAppUrl = `http://127.0.0.1:${port}`;
      const browserCommands = { linux: ['xdg-open', localAppUrl], darwin: ['open', localAppUrl], win32: ['rundll32.exe', 'url.dll,FileProtocolHandler', localAppUrl] };
      const spec = appId === 'browser' ? browserCommands[process.platform] : APP_COMMANDS[appId][process.platform];
      if (!spec) throw new Error('Programa não mapeado para este sistema operacional.');
      const task = createTask({
        category: 'apps', action: 'open-app', summary: `Abrir programa: ${appId}`,
        confirmation: { prompt: 'Confirme a abertura do programa solicitado.', details: { app: appId } },
        execute: (signal, _emit, markEffectStarted) => new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new Error('Execução cancelada.'));
          const [program, ...args] = spec;
          const child = spawn(program, args, { cwd: getTerminalCwd(store.permissions.fileRoots), env: { PATH: process.env.PATH || '', HOME: os.homedir(), SystemRoot: process.env.SystemRoot || '' }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
          const onAbort = () => { try { child.kill(); } catch {} reject(new Error('Execução cancelada.')); };
          signal.addEventListener('abort', onAbort, { once: true });
          child.once('error', error => { signal.removeEventListener('abort', onAbort); reject(new Error(`Não foi possível abrir ${appId} (${error.code || 'erro'}).`)); });
          child.once('spawn', () => { signal.removeEventListener('abort', onAbort); markEffectStarted(); child.unref(); resolve(`Solicitação de abertura enviada: ${appId}.`); });
        })
      });
      res.status(202).json({ task: publicTask(task) });
    } catch (error) { jsonError(res, error); }
  });

  router.post('/files', async (req, res) => {
    try {
      requirePermission('files');
      const { action, path: requestedPath, destination, content } = req.body || {};
      if (!['list', 'read', 'write', 'create', 'mkdir', 'rename', 'delete'].includes(action)) throw new Error('Operação de arquivos inválida.');
      const roots = store.permissions.fileRoots;
      if (!roots.length) throw new Error('Conceda uma pasta em Permissões antes de acessar arquivos.');
      if (action === 'list' || action === 'read') {
        const file = await resolveScopedPath(requestedPath, roots);
        const info = await fs.stat(file);
        const output = action === 'list'
          ? (!info.isDirectory() ? Promise.reject(new Error('O caminho informado não é uma pasta.')) : listDirectory(file))
          : (!info.isFile() ? Promise.reject(new Error('O caminho informado não é um arquivo.')) : readTextFile(file));
        const task = createTask({ category: 'files', action, summary: `Arquivos: ${action}`, execute: () => output });
        return res.status(202).json({ task: publicTask(task) });
      }
      if (req.body?.confirmed !== true) throw new Error('A operação altera arquivos e exige aprovação específica.');
      if (action === 'mkdir') {
        const target = await resolveScopedPath(requestedPath, roots, { mustExist: false });
        if (await fs.lstat(target).catch(() => null)) throw new Error('O caminho já existe.');
        const task = createTask({ category: 'files', action, summary: 'Arquivos: criar pasta', confirmation: { prompt: 'Criar esta pasta dentro do escopo autorizado?', details: { path: target } }, execute: async (signal, _emit, markEffectStarted) => {
          await revalidateTaskPath(requestedPath, target, false);
          if (await fs.lstat(target).catch(() => null)) throw new Error('O destino passou a existir; nada foi criado.');
          if (signal.aborted) throw new Error('Execução cancelada antes da criação.');
          markEffectStarted();
          await fs.mkdir(target, { mode: 0o700 });
          return `Pasta criada: ${target}`;
        } });
        return res.status(202).json({ task: publicTask(task) });
      }
      if (action === 'write' || action === 'create') {
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Conteúdo inválido ou acima de 256 KiB.');
        const target = await resolveScopedPath(requestedPath, roots, { mustExist: false });
        const existing = await fs.lstat(target).catch(() => null);
        if (action === 'create' && existing) throw new Error('O arquivo já existe; criação não sobrescreve arquivos.');
        if (action === 'write' && !existing) throw new Error('O arquivo a atualizar precisa existir; use criar para um novo arquivo.');
        if (existing?.isDirectory()) throw new Error('O destino é uma pasta.');
        if (existing && !existing.isFile()) throw new Error('Somente arquivos regulares podem ser atualizados.');
        const confirmation = {
          prompt: action === 'create' ? 'Criar este arquivo com o conteúdo revisado?' : 'Sobrescrever este arquivo com o conteúdo revisado?',
          details: { action, path: target, preview: content, byteLength: Buffer.byteLength(content, 'utf8') }
        };
        const originalIdentity = existing && { dev: existing.dev, ino: existing.ino };
        const task = createTask({ category: 'files', action, summary: `Arquivos: ${action}`, confirmation, execute: async (signal, _emit, markEffectStarted) => {
          await revalidateTaskPath(requestedPath, target, false);
          const current = await fs.lstat(target).catch(() => null);
          if (action === 'create' && current) throw new Error('O arquivo passou a existir; nada foi sobrescrito.');
          if (action === 'write' && !sameFileIdentity(current, originalIdentity)) throw new Error('O arquivo mudou desde a revisão; nada foi sobrescrito.');
          if (current?.isSymbolicLink() || current?.isDirectory()) throw new Error('Destino não regular/simbólico bloqueado.');
          const temp = path.join(path.dirname(target), `.gridsoul-${randomUUID()}.tmp`);
          try {
            await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            if (signal.aborted) throw new Error('Execução cancelada antes do commit.');
            await revalidateTaskPath(requestedPath, target, false);
            const latest = await fs.lstat(target).catch(() => null);
            if (action === 'create' && latest) throw new Error('O arquivo passou a existir; nada foi sobrescrito.');
            if (action === 'write' && !sameFileIdentity(latest, originalIdentity)) throw new Error('O arquivo mudou antes do commit; nada foi sobrescrito.');
            if (latest?.isSymbolicLink() || latest?.isDirectory()) throw new Error('Destino não regular/simbólico bloqueado.');
            markEffectStarted();
            if (action === 'create') {
              await fs.link(temp, target);
              await fs.unlink(temp);
            } else await fs.rename(temp, target);
          } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
          return `${action === 'create' ? 'Arquivo criado' : 'Arquivo atualizado'}: ${target}`;
        } });
        return res.status(202).json({ task: publicTask(task) });
      }
      if (action === 'rename') {
        const source = await resolveScopedPath(requestedPath, roots);
        const target = await resolveScopedPath(destination, roots, { mustExist: false });
        if (isWithinRoots(target, [source])) throw new Error('Não é possível mover uma pasta para dentro dela mesma.');
        if (await fs.lstat(target).catch(() => null)) throw new Error('Destino já existe; sobrescrita por renomeação é bloqueada.');
        const sourceIdentity = await fs.lstat(source);
        if (!sourceIdentity.isFile() || sourceIdentity.isSymbolicLink()) throw new Error('Movimentação só aceita arquivos regulares, não pastas ou links simbólicos.');
        const expectedIdentity = { dev: sourceIdentity.dev, ino: sourceIdentity.ino };
        const task = createTask({ category: 'files', action, summary: 'Arquivos: renomear/mover', confirmation: { prompt: 'Confirmar movimentação do arquivo? O destino será criado sem sobrescrever.', details: { source, destination: target } }, execute: async (signal, _emit, markEffectStarted) => {
          const currentSource = await revalidateTaskPath(requestedPath, source, true);
          const currentTarget = await revalidateTaskPath(destination, target, false);
          if (!sameFileIdentity(await fs.lstat(currentSource), expectedIdentity)) throw new Error('O arquivo de origem mudou desde a aprovação.');
          if ((await fs.lstat(currentSource)).isDirectory()) throw new Error('Movimentação de pastas não disponível.');
          if (await fs.lstat(currentTarget).catch(() => null)) throw new Error('Destino passou a existir; nada foi sobrescrito.');
          if (signal.aborted) throw new Error('Execução cancelada antes da movimentação.');
          markEffectStarted();
          await fs.link(currentSource, currentTarget);
          await fs.unlink(currentSource);
          return `Movido: ${currentSource} → ${currentTarget}`;
        } });
        return res.status(202).json({ task: publicTask(task) });
      }
      const target = await resolveScopedPath(requestedPath, roots);
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) throw new Error('Exclusão de pastas inteiras não está disponível.');
      const expectedIdentity = { dev: stat.dev, ino: stat.ino };
      const task = createTask({ category: 'files', action: 'delete', summary: 'Arquivos: excluir arquivo', confirmation: { prompt: 'Excluir permanentemente este arquivo? Essa operação não pode ser desfeita.', details: { path: target, irreversible: true } }, execute: async (signal, _emit, markEffectStarted) => {
        const current = await revalidateTaskPath(requestedPath, target, true);
        const identity = await fs.lstat(current);
        if (!sameFileIdentity(identity, expectedIdentity)) throw new Error('O arquivo mudou desde a aprovação.');
        if (identity.isDirectory()) throw new Error('Exclusão de pastas inteiras não está disponível.');
        if (signal.aborted) throw new Error('Execução cancelada antes da exclusão.');
        markEffectStarted();
        await fs.unlink(current);
        return `Arquivo excluído: ${current}`;
      } });
      return res.status(202).json({ task: publicTask(task) });
    } catch (error) { jsonError(res, error); }
  });

  async function withBrowserLock(operation, signal) {
    const previous = browserQueue;
    let release;
    browserQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) throw new Error('Execução cancelada.');
      return await operation();
    } finally { release(); }
  }
  async function ensureBrowser() {
    if (browser && browser.isConnected() && browserPage && !browserPage.isClosed()) return browserPage;
    await closeBrowser();
    pinnedProxy = await createPinnedHttpsProxy(() => store.permissions.browserOrigins);
    try {
      browser = await chromium.launch({
        headless: process.env.GRID_SOUL_AUTOMATION_HEADLESS !== '0',
        proxy: { server: pinnedProxy.url },
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
      });
    } catch (error) {
      await closeBrowser();
      throw error;
    }
    try {
    browserContext = await browser.newContext({ acceptDownloads: false, permissions: [], serviceWorkers: 'block' });
    browserPage = await browserContext.newPage();
    browserPage.setDefaultTimeout(8000);
    await browserContext.route('**/*', async route => {
      const request = route.request();
      const value = request.url();
      let isTopNavigation = false;
      let requestFrame = null;
      try {
        requestFrame = request.frame();
        isTopNavigation = request.isNavigationRequest() && requestFrame.parentFrame() === null;
      } catch {}
      if (value === 'about:blank' && browserPage && requestFrame === browserPage.mainFrame()) return route.continue().catch(() => {});
      if (value.startsWith('about:') || value.startsWith('data:') || value.startsWith('blob:')) {
        if (isTopNavigation) return route.abort('blockedbyclient').catch(() => {});
        return route.continue().catch(() => {});
      }
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('Somente tráfego HTTPS é permitido.');
        await assertPublicHost(url.hostname, dnsCache);
        if (!store.permissions.browserOrigins.includes(url.origin)) throw new Error('Origem ainda não autorizada.');
        await route.continue();
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    await browserContext.routeWebSocket('**/*', async socketRoute => {
      try {
        const url = new URL(socketRoute.url());
        const origin = url.protocol === 'wss:' ? `https://${url.host}` : '';
        if (url.protocol !== 'wss:' || !store.permissions.browserOrigins.includes(origin)) {
          return socketRoute.close({ code: 1008, reason: 'Origem WebSocket não autorizada.' });
        }
        await assertPublicHost(url.hostname, dnsCache);
        socketRoute.connectToServer();
      } catch {
        socketRoute.close({ code: 1008, reason: 'Destino WebSocket bloqueado.' });
      }
    });
    return browserPage;
    } catch (error) {
      await closeBrowser();
      throw error;
    }
  }
  function currentAuthorizedOrigin(page) {
    if (!page || page.isClosed()) throw new Error('A sessão do navegador foi encerrada.');
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !store.permissions.browserOrigins.includes(url.origin)) {
      throw new Error('A página atual não está em uma origem HTTPS autorizada.');
    }
    return url.origin;
  }
  router.post('/browser/navigate', async (req, res) => {
    try {
      requirePermission('browser');
      if (typeof req.body?.url !== 'string' || req.body.url.length > 2048) throw new Error('Informe uma URL HTTPS válida.');
      const url = new URL(req.body.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.origin === 'null') throw new Error('Somente URL HTTPS sem credenciais é permitida.');
      if (!store.permissions.browserOrigins.includes(url.origin)) throw new Error('Conceda primeiro essa origem HTTPS exata em Permissões.');
      await assertPublicHost(url.hostname, dnsCache);
      const task = createTask({ category: 'browser', action: 'navigate', summary: `Navegador: abrir ${url.origin}`, confirmation: {
        prompt: 'Autorizar a navegação para esta URL? Mesmo uma requisição GET pode iniciar ações ou alterar estado no serviço remoto.',
        details: { method: 'GET', origin: url.origin, url: url.href }
      }, execute: (signal, _emit, markEffectStarted) => withBrowserLock(async () => {
        const page = await ensureBrowser();
        signal.addEventListener('abort', () => { void closeBrowser(); }, { once: true });
        markEffectStarted();
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return `Página aberta: ${page.url()}\nTítulo: ${escapeHtmlText(await page.title().catch(() => ''))}`;
      }, signal) });
      res.status(202).json({ task: publicTask(task) });
    } catch (error) { jsonError(res, error); }
  });
  router.post('/browser/action', (req, res) => {
    try {
      requirePermission('browser');
      const { action, field, value, target, role } = req.body || {};
      if (!browserPage || browserPage.isClosed()) throw new Error('Abra primeiro um site autorizado no navegador isolado.');
      const taskPage = browserPage;
      const boundOrigin = currentAuthorizedOrigin(taskPage);
      if (action === 'read') {
        const task = createTask({ category: 'browser', action, summary: 'Navegador: ler texto visível da página', confirmation: {
          prompt: 'Autorizar leitura do texto visível? A página pode conter dados pessoais ou credenciais já exibidos; o resultado fica na interface/API local por até 60 segundos e não entra na auditoria.',
          details: { action: 'read-visible-text', origin: boundOrigin, maximumCharacters: 5000 }
        }, execute: signal => withBrowserLock(async () => {
          if (currentAuthorizedOrigin(taskPage) !== boundOrigin) throw new Error('A página mudou de origem desde a solicitação.');
          const title = await taskPage.title().catch(() => '');
          const bodyText = await taskPage.locator('body').innerText({ timeout: 8000 });
          return `Título: ${title}\nURL: ${taskPage.url()}\n\n${bodyText.slice(0, 5000)}${bodyText.length > 5000 ? '\n… (conteúdo truncado)' : ''}`;
        }, signal) });
        return res.status(202).json({ task: publicTask(task) });
      }
      if (action === 'fill') {
        if (typeof field !== 'string' || !field.trim() || field.length > 120 || typeof value !== 'string' || value.length > 5000) throw new Error('Informe o rótulo do campo e um valor de até 5.000 caracteres.');
        const confirmation = { prompt: 'Revisar e confirmar o preenchimento deste campo. O site poderá receber o valor se você enviar o formulário.', details: { action, field: field.slice(0, 120), origin: boundOrigin, preview: value, characterLength: value.length } };
        const task = createTask({ category: 'browser', action, summary: 'Navegador: preencher campo após confirmação', confirmation, execute: (signal, _emit, markEffectStarted) => withBrowserLock(async () => {
          if (currentAuthorizedOrigin(taskPage) !== boundOrigin) throw new Error('A página mudou de origem desde a solicitação.');
          let locator = taskPage.getByLabel(field, { exact: true });
          if (await locator.count().catch(() => 0) !== 1) locator = taskPage.getByPlaceholder(field, { exact: true });
          if (await locator.count().catch(() => 0) !== 1) throw new Error('O rótulo/placeholder precisa identificar exatamente um campo.');
          const element = await locator.evaluate(el => ({ tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id, autocomplete: el.getAttribute('autocomplete'), ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), labelText: Array.from(el.labels || []).map(label => label.innerText).join(' '), disabled: el.disabled, readOnly: el.readOnly, isContentEditable: el.isContentEditable }));
          classifyInput(element, field);
          if (!['INPUT', 'TEXTAREA'].includes(element.tag) && !element.isContentEditable) throw new Error('Somente campos de texto editáveis podem ser preenchidos.');
          markEffectStarted();
          await locator.fill(value);
          return `Campo preenchido no domínio autorizado: ${boundOrigin}. O valor não foi gravado na auditoria.`;
        }, signal) });
        return res.status(202).json({ task: publicTask(task) });
      }
      if (action === 'click') {
        if (!['button', 'link'].includes(role) || typeof target !== 'string' || !target.trim() || target.length > 120) throw new Error('Selecione um botão ou link por nome acessível exato.');
        const task = createTask({ category: 'browser', action, summary: `Navegador: clicar em ${role} autorizado`, confirmation: { prompt: 'Confirmar o clique? Ele pode enviar dados, publicar conteúdo, alterar uma conta ou iniciar uma operação financeira.', details: { action, role, target: target.slice(0, 120), origin: boundOrigin } }, execute: (signal, _emit, markEffectStarted) => withBrowserLock(async () => {
          if (currentAuthorizedOrigin(taskPage) !== boundOrigin) throw new Error('A página mudou de origem desde a solicitação.');
          const locator = taskPage.getByRole(role, { name: target, exact: true });
          if (await locator.count().catch(() => 0) !== 1) throw new Error('O nome acessível precisa identificar exatamente um botão ou link.');
          if (await locator.isDisabled().catch(() => true)) throw new Error('O controle está desabilitado.');
          if (role === 'link') {
            const href = await locator.getAttribute('href');
            if (href && /^(?:javascript|data|file):/i.test(href.trim())) throw new Error('Links executáveis ou locais são bloqueados.');
          }
          markEffectStarted();
          await locator.click({ timeout: 8000 });
          return `Clique executado em ${role} no domínio autorizado ${boundOrigin}. Revise o resultado antes de outra ação.`;
        }, signal) });
        return res.status(202).json({ task: publicTask(task) });
      }
      throw new Error('Ações permitidas: read, fill e click; código JavaScript arbitrário não é aceito.');
    } catch (error) { jsonError(res, error); }
  });
  router.post('/browser/close', async (req, res) => {
    try {
      requirePermission('browser');
      for (const task of activeTasks('browser')) cancelTask(task, 'browser_closed');
      await Promise.allSettled([...tasks.values()].filter(task => task.category === 'browser' && task.done).map(task => task.done));
      await closeBrowser();
      const auditSaved = recordAudit({ category: 'browser', action: 'close', status: 'requested' });
      res.json({ ok: true, auditWarning: !auditSaved });
    } catch (error) { jsonError(res, error); }
  });

  router.post('/tasks/:id/decision', (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task || task.status !== 'awaiting_confirmation') return res.status(404).json({ error: 'Aprovação pendente não encontrada ou expirada.' });
    if (req.body?.approved === true) {
      if (!store.permissions.enabled[task.category]) { cancelTask(task, 'permission_revoked'); return res.status(403).json({ error: 'Permissão revogada.' }); }
      clearTimeout(task.expiry);
      if (!audit(task, 'approved')) {
        task.status = 'cancelled'; task.confirmation = null; task.execute = null;
        task.error = 'Aprovação não executada porque a auditoria está indisponível.';
        emitTask(task);
        return res.status(503).json({ error: task.error, task: publicTask(task) });
      }
      task.status = 'queued';
      task.confirmation = null;
      emitTask(task);
      task.done = startTask(task);
      return res.status(202).json({ task: publicTask(task) });
    }
    if (req.body?.approved !== false) return res.status(400).json({ error: 'Informe approved true/false.' });
    cancelTask(task, 'denied');
    res.json({ task: publicTask(task) });
  });
  router.post('/tasks/:id/cancel', async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada.' });
    if (!cancelTask(task)) return res.status(409).json({ error: 'A tarefa já terminou.' });
    if (task.done) await Promise.allSettled([task.done]);
    res.json({ ok: true, task: publicTask(task) });
  });
  router.post('/stop', async (_req, res) => {
    const affected = activeTasks();
    for (const task of affected) cancelTask(task, 'stop_all');
    await Promise.allSettled(affected.map(task => task.done).filter(Boolean));
    await closeBrowser();
    const auditSaved = recordAudit({ category: 'system', action: 'stop_all', status: 'requested' });
    publish('stopped', { timestamp: new Date().toISOString() });
    res.json({ ok: true, stopped: true, auditWarning: !auditSaved });
  });
  router.get('/tasks', (_req, res) => res.json({ tasks: [...tasks.values()].slice(-50).reverse().map(publicTask) }));
  router.get('/audit', (_req, res) => res.json({ entries: store.recentAudit(100) }));
  router.get('/events', (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    subscribers.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ tasks: [...tasks.values()].slice(-50).reverse().map(publicTask), permissions: store.snapshot(), audit: store.recentAudit(50) })}\n\n`);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
  });
  return router;
}
