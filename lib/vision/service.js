import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'backend', 'vision', 'image_analyzer.py');
const PROJECTS = path.resolve(process.env.GRID_SOUL_VISION_DIR || path.join(ROOT, 'data', 'vision-projects'));
const MAX_INPUT_BYTES = 22 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_TIMEOUT_MS = 90_000;

function localRequest(req, res, next) {
  const host = req.get('host') || '';
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const allowedHosts = new Set([`127.0.0.1:${process.env.GRID_SOUL_PORT || 8765}`, `localhost:${process.env.GRID_SOUL_PORT || 8765}`]);
  if (!allowedHosts.has(host) || (origin && origin !== `http://${host}`) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    return res.status(403).json({ error: 'Visão computacional e projetos salvos só estão disponíveis pela interface local do GRID SOUL.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

function validateDataUrl(value, label, maxChars) {
  if (typeof value !== 'string' || value.length < 20 || value.length > maxChars || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error(`${label}: envie uma imagem PNG, JPG ou WEBP válida dentro do limite.`);
  }
}

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const projectPython = path.join(ROOT, '.venv', 'bin', 'python');
    const executable = process.env.GRID_SOUL_PYTHON || (existsSync(projectPython) ? projectPython : 'python3');
    const child = spawn(executable, [SCRIPT], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('A análise local excedeu o limite de 90 segundos. Reduza a resolução ou a população.'));
    }, MAX_TIMEOUT_MS);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_RESULT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('A resposta da análise excedeu o limite de tamanho. Reduza a população.'));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', error => finish(new Error(`Não foi possível iniciar o processador Python local: ${error.message}`)));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`O processador Python terminou com código ${code}: ${stderr.slice(-300)}`));
      try {
        const result = JSON.parse(stdout.toString('utf8'));
        if (!result || result.ok !== true) return finish(new Error(result?.error || 'A análise local falhou.'));
        finish(null, result);
      } catch (error) {
        finish(new Error(`Resposta inválida do analisador Python: ${error.message}`));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function readProjectId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Identificador de projeto inválido.');
  }
  return value.toLowerCase();
}

function validateProject(body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('O projeto deve ser um objeto JSON.');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new Error('Informe um nome para o projeto.');
  const state = body.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('O estado do projeto está ausente.');
  validateDataUrl(state.image, 'Imagem de referência', 11_200_000);
  if (state.annotations) validateDataUrl(state.annotations, 'Camada de marcações', 7_200_000);
  if (state.analysis && (typeof state.analysis !== 'object' || Array.isArray(state.analysis))) throw new Error('A análise salva é inválida.');
  const payload = {
    version: 1,
    id,
    name,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt.slice(0, 40) : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) throw new Error('O projeto excede 22 MiB; reduza a imagem ou a população antes de salvar.');
  return payload;
}

async function atomicWrite(file, contents) {
  await fs.mkdir(PROJECTS, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function createVisionRouter() {
  const router = express.Router();
  router.use(localRequest);

  router.post('/analyze', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Pedido de análise inválido.');
      validateDataUrl(body.image, 'Imagem', 11_200_000);
      if (body.annotations) validateDataUrl(body.annotations, 'Marcações', 7_200_000);
      const result = await runPython({ ...body, action: 'analyze' });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: String(error.message || 'Falha na análise local.').slice(0, 350) });
    }
  });

  router.post('/compare', async (req, res) => {
    try {
      validateDataUrl(req.body?.image, 'Imagem de referência', 11_200_000);
      validateDataUrl(req.body?.reconstruction, 'Reconstrução', 11_200_000);
      res.json(await runPython({ action: 'compare', image: req.body.image, reconstruction: req.body.reconstruction, rotation: req.body.rotation || 0 }));
    } catch (error) {
      res.status(400).json({ error: String(error.message || 'Falha na comparação.').slice(0, 350) });
    }
  });

  router.get('/projects', async (_req, res) => {
    try {
      await fs.mkdir(PROJECTS, { recursive: true, mode: 0o700 });
      const files = (await fs.readdir(PROJECTS)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name));
      const items = [];
      for (const filename of files) {
        try {
          const project = JSON.parse(gunzipSync(await fs.readFile(path.join(PROJECTS, filename))).toString('utf8'));
          items.push({ id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, width: project.state?.analysis?.image?.originalWidth || null, height: project.state?.analysis?.image?.originalHeight || null, samples: project.state?.analysis?.swarm?.count || null });
        } catch { /* A listagem ignora apenas um registro local inválido. */ }
      }
      items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json({ projects: items.slice(0, 100) });
    } catch (error) {
      res.status(500).json({ error: `Não foi possível listar os projetos locais: ${error.message}` });
    }
  });

  router.get('/projects/:id', async (req, res) => {
    try {
      const id = readProjectId(req.params.id);
      const data = await fs.readFile(path.join(PROJECTS, `${id}.json`));
      const project = JSON.parse(gunzipSync(data).toString('utf8'));
      res.json(project);
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : 400;
      res.status(status).json({ error: status === 404 ? 'Projeto local não encontrado.' : String(error.message || 'Não foi possível abrir o projeto.').slice(0, 300) });
    }
  });

  router.put('/projects/:id', async (req, res) => {
    try {
      const id = readProjectId(req.params.id);
      const project = validateProject(req.body, id);
      const file = path.join(PROJECTS, `${id}.json`);
      let createdAt = project.createdAt;
      try {
        const existing = JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8'));
        if (typeof existing.createdAt === 'string') createdAt = existing.createdAt;
      } catch { /* New project or invalid old record is replaced only after validation. */ }
      project.createdAt = createdAt;
      const compressed = gzipSync(Buffer.from(JSON.stringify(project)), { level: 6 });
      await atomicWrite(file, compressed);
      res.json({ ok: true, project: { id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt } });
    } catch (error) {
      res.status(400).json({ error: String(error.message || 'Não foi possível salvar o projeto local.').slice(0, 350) });
    }
  });

  return router;
}
