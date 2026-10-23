import fs from 'node:fs';
import path from 'node:path';

const CATEGORIES = ['terminal', 'files', 'apps', 'browser'];
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

function initialPermissions() {
  return { version: 1, enabled: Object.fromEntries(CATEGORIES.map(category => [category, false])), fileRoots: [], browserOrigins: [] };
}

export class AutomationStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.permissionsFile = path.join(this.directory, 'permissions.json');
    this.auditFile = path.join(this.directory, 'audit.jsonl');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.directory, 0o700); } catch {}
    this.permissions = this.#readPermissions();
  }

  #readPermissions() {
    try {
      const data = JSON.parse(fs.readFileSync(this.permissionsFile, 'utf8'));
      if (data?.version !== 1 || !data.enabled || typeof data.enabled !== 'object') return initialPermissions();
      return {
        version: 1,
        enabled: Object.fromEntries(CATEGORIES.map(category => [category, data.enabled[category] === true])),
        fileRoots: Array.isArray(data.fileRoots) ? [...new Set(data.fileRoots.filter(v => typeof v === 'string').slice(0, 20))] : [],
        browserOrigins: Array.isArray(data.browserOrigins) ? [...new Set(data.browserOrigins.filter(v => typeof v === 'string').slice(0, 50))] : []
      };
    } catch { return initialPermissions(); }
  }

  #save() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.permissionsFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.permissions, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.permissionsFile);
    try { fs.chmodSync(this.permissionsFile, 0o600); } catch {}
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.permissions));
  }

  setEnabled(category, enabled) {
    if (!CATEGORIES.includes(category)) throw new Error('Categoria de permissão desconhecida.');
    this.permissions.enabled[category] = enabled === true;
    if (!enabled && category === 'files') this.permissions.fileRoots = [];
    if (!enabled && category === 'browser') this.permissions.browserOrigins = [];
    this.#save();
    return this.snapshot();
  }

  addFileRoot(root) {
    if (!this.permissions.fileRoots.includes(root)) this.permissions.fileRoots.push(root);
    this.permissions.fileRoots = this.permissions.fileRoots.slice(-20);
    this.#save();
    return this.snapshot();
  }

  removeFileRoot(root) {
    this.permissions.fileRoots = this.permissions.fileRoots.filter(item => item !== root);
    this.#save();
    return this.snapshot();
  }

  addBrowserOrigin(origin) {
    if (!this.permissions.browserOrigins.includes(origin)) this.permissions.browserOrigins.push(origin);
    this.permissions.browserOrigins = this.permissions.browserOrigins.slice(-50);
    this.#save();
    return this.snapshot();
  }

  removeBrowserOrigin(origin) {
    this.permissions.browserOrigins = this.permissions.browserOrigins.filter(item => item !== origin);
    this.#save();
    return this.snapshot();
  }

  audit(entry) {
    const safe = {
      timestamp: new Date().toISOString(),
      taskId: String(entry.taskId || '').slice(0, 64),
      category: CATEGORIES.includes(entry.category) ? entry.category : 'system',
      action: String(entry.action || '').slice(0, 48),
      status: String(entry.status || '').slice(0, 32)
    };
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.auditFile) && fs.statSync(this.auditFile).size > AUDIT_MAX_BYTES) {
        const rotated = `${this.auditFile}.1`;
        try { fs.rmSync(rotated, { force: true }); } catch {}
        fs.renameSync(this.auditFile, rotated);
      }
      fs.appendFileSync(this.auditFile, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.auditFile, 0o600); } catch {}
      return true;
    } catch (error) {
      console.error('GRID SOUL audit: gravação indisponível; a tarefa não pode ser registrada.');
      return false;
    }
  }

  recentAudit(limit = 100) {
    try {
      return fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).slice(-limit).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch { return []; }
  }
}
