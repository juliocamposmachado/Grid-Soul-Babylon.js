import path from 'node:path';
import net from 'node:net';

export const CATEGORIES = Object.freeze(['terminal', 'files', 'apps', 'browser']);
export const MAX_COMMAND_LENGTH = 500;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 20 * 1024;

const BLOCKED_SEGMENTS = new Set([
  '.git', '.ssh', '.aws', '.gnupg', '.chatgpt-profile', '.mozilla', '.config',
  '.docker', '.kube', '.azure', '.npm', '.pki', 'keyrings', 'keychains', '.password-store',
  'login data', 'cookies', 'cookies.sqlite', 'local state', 'credentials',
  'credentials.json', 'secrets', 'tokens', '.npmrc', '.pypirc', '.netrc',
  'application_default_credentials.json', 'authorized_keys', 'known_hosts',
  'token.json', 'auth.json', 'login.keychain-db', 'keychain'
]);
const BLOCKED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.ppk', '.p8', '.keyring']);

export function isSensitivePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean).map(s => s.toLowerCase());
  const joined = segments.join('/');
  if (segments.some(segment => BLOCKED_SEGMENTS.has(segment) || /^\.env(?:\.|$)/i.test(segment))) return true;
  if (/(?:^|\/)(?:appdata\/local\/(?:google\/chrome|microsoft\/edge)|appdata\/roaming\/mozilla\/firefox|library\/application support\/(?:google\/chrome|microsoft edge)|\.config\/(?:google-chrome|chromium|microsoft-edge)|\.mozilla\/firefox)(?:\/|$)/i.test(joined)) return true;
  const base = segments.at(-1) || '';
  return BLOCKED_EXTENSIONS.has(path.posix.extname(base)) || /(^|[._-])(id_rsa|id_ed25519|private_key|secret|passwords?|credentials?)([._-]|$)/i.test(base);
}

export function isWithinRoots(candidate, roots) {
  const absolute = path.resolve(candidate);
  return roots.some(root => {
    const relative = path.relative(path.resolve(root), absolute);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
}

export function tokenizeCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
    throw new Error('Informe um comando de até 500 caracteres.');
  }
  if (/[\0\r\n;|&<>`$]/.test(command)) {
    throw new Error('Comandos compostos, redirecionamentos, variáveis e operadores de shell são bloqueados.');
  }

  const tokens = [];
  let token = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && command[i + 1] === quote) token += command[++i];
      else token += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error('Aspas não fechadas no comando.');
  if (started) tokens.push(token);
  if (!tokens.length || tokens.some(token => token.includes('\0'))) throw new Error('Comando inválido.');
  return tokens;
}

export function parseSafeCommand(command) {
  const tokens = tokenizeCommand(command);
  const [name, ...args] = tokens;
  const onlyNoArgs = op => {
    if (args.length) throw new Error(`O comando ${name} não aceita argumentos.`);
    return { op };
  };

  if (name === 'pwd') return onlyNoArgs('pwd');
  if (name === 'date') return onlyNoArgs('date');
  if (name === 'whoami') return onlyNoArgs('whoami');
  if (name === 'uname' && (args.length === 0 || (args.length === 1 && args[0] === '-a'))) return { op: 'uname' };
  if (name === 'node' && args.length === 1 && ['--version', '-v'].includes(args[0])) return { op: 'version', program: 'node' };
  if (name === 'npm' && args.length === 1 && args[0] === '--version') return { op: 'version', program: 'npm' };
  if ((name === 'python' || name === 'python3') && args.length === 1 && ['--version', '-V'].includes(args[0])) return { op: 'version', program: 'python3' };

  if (name === 'ls') {
    let option = '';
    let operand = '.';
    for (const arg of args) {
      if (['-a', '-l', '-la', '-al'].includes(arg) && !option) option = arg;
      else if (!arg.startsWith('-') && operand === '.') operand = arg;
      else throw new Error('Uso permitido: ls [-a|-l|-la] [caminho].');
    }
    return { op: 'list', operand, option };
  }
  if (name === 'cat' && args.length === 1) return { op: 'read', operand: args[0] };
  if ((name === 'head' || name === 'tail') && (args.length === 1 || (args.length === 3 && args[0] === '-n' && /^\d{1,3}$/.test(args[1])))) {
    const count = args.length === 3 ? Number(args[1]) : 20;
    if (count < 1 || count > 200) throw new Error('head/tail aceita entre 1 e 200 linhas.');
    return { op: name, operand: args.at(-1), count };
  }
  if (name === 'grep') {
    const values = args[0] === '-n' ? args.slice(1) : args;
    if (values.length !== 2) throw new Error('Uso permitido: grep [-n] "texto literal" arquivo. Regex e busca recursiva são bloqueadas.');
    return { op: 'grep', pattern: values[0], operand: values[1], numbered: args[0] === '-n' };
  }
  if (name === 'git') {
    if (args.length === 1 && args[0] === 'status') return { op: 'git', args: ['status', '--short'] };
    if (args.length === 2 && args[0] === 'status' && args[1] === '--short') return { op: 'git', args: ['status', '--short'] };
    if (args.length === 2 && args[0] === 'log' && /^-\d{1,2}$/.test(args[1])) return { op: 'git', args: ['log', '-n', String(Math.min(20, Number(args[1].slice(1)))), '--oneline'] };
    if (args.length === 2 && args[0] === 'diff' && args[1] === '--stat') return { op: 'git', args: ['diff', '--stat'] };
    throw new Error('Git está limitado a: git status [--short], git log -N e git diff --stat.');
  }
  throw new Error('Comando fora da lista segura. Permitidos: pwd, date, whoami, uname, ls, cat, head, tail, grep, git status/log/diff --stat e versões de node/npm/python.');
}

export function validateHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 255) throw new Error('Informe uma origem HTTPS válida.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Origem inválida. Exemplo: https://gemini.google.com'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Conceda uma origem HTTPS exata, sem credenciais, caminho, consulta ou fragmento.');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost') || net.isIP(hostname)) {
    throw new Error('Somente domínios públicos HTTPS são aceitos; IPs e hosts locais são bloqueados.');
  }
  return url.origin;
}

export function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 192 && b === 88 && octets[2] === 99) return false;
    if (a === 192 && b === 0 && octets[2] === 2) return false;
    if (a === 198 && b === 51 && octets[2] === 100) return false;
    if (a === 203 && b === 0 && octets[2] === 113) return false;
    return true;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice(7));
    const groups = lower.split(':');
    const first = Number.parseInt(groups[0] || '0', 16);
    const second = Number.parseInt(groups[1] || '0', 16);
    if (lower.startsWith('2001:db8:') || lower.startsWith('2002:')) return false;
    if (first === 0x2001 && second <= 0x01ff) return false;
    if (first === 0x3fff && second <= 0x0fff) return false;
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}
