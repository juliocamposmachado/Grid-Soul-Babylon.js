import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createAutomationRouter } from './lib/automation/service.js';
import { analyzeForkLocally, buildEngineeringPrompt, sanitizeEngineeringProposal } from './lib/engineering/assistant.js';
import { createVisionRouter } from './lib/vision/service.js';
import { GRID_SOUL_MATERIALS, MATERIAL_CATALOG_VERIFIED_ON } from './components/material_catalog.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Memória persistente local do GRID SOUL.
const MEMORY_FILE = process.env.GRID_SOUL_MEMORY_FILE
  ? path.resolve(process.env.GRID_SOUL_MEMORY_FILE)
  : path.join(ROOT, 'data', 'gridsoul-memory.json');
const MEMORY_DIR = path.dirname(MEMORY_FILE);
const MEMORY_LIMIT = 100;
const PORT = Number(process.env.GRID_SOUL_PORT || 8765);
const BRIDGE_MODE = process.env.GRID_SOUL_CHATGPT_BRIDGE === 'extension' ? 'extension' : 'cdp';

function emptyMemory() {
  return { version: 1, updatedAt: null, lastCommand: '', lastPlan: null, history: [] };
}

function loadMemory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.history)) {
      return emptyMemory();
    }
    const lastPlan = parsed.lastPlan && typeof parsed.lastPlan === 'object'
      ? sanitizePlan(parsed.lastPlan)
      : null;
    if (lastPlan) lastPlan.reply = 'Estado visual restaurado.';
    const history = parsed.history.slice(-MEMORY_LIMIT).map(entry => ({
      timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : null,
      status: typeof entry?.status === 'string' ? entry.status : 'success',
      shape: typeof entry?.shape === 'string' ? entry.shape : undefined,
      population: Number.isFinite(entry?.population) ? entry.population : undefined,
      energy: Number.isFinite(entry?.energy) ? entry.energy : undefined,
      scale: Number.isFinite(entry?.scale) ? entry.scale : undefined,
      color: typeof entry?.color === 'string' ? entry.color : undefined
    }));
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      lastCommand: '',
      lastPlan,
      history
    };
  } catch {
    return emptyMemory();
  }
}

let memory;

function saveMemory() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const temporary = MEMORY_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(memory, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, MEMORY_FILE);
}

function visualOnlyPlan(plan) {
  const safePlan = JSON.parse(JSON.stringify(plan));
  safePlan.reply = 'Estado visual restaurado.';
  return safePlan;
}

function rememberSuccessfulCommand(plan) {
  const timestamp = new Date().toISOString();
  const safePlan = visualOnlyPlan(plan);

  memory.lastCommand = '';
  memory.lastPlan = safePlan;
  memory.updatedAt = timestamp;
  memory.history.push({
    timestamp,
    status: 'success',
    shape: safePlan.shape,
    population: safePlan.population,
    energy: safePlan.energy,
    scale: safePlan.scale,
    color: safePlan.color
  });
  memory.history = memory.history.slice(-MEMORY_LIMIT);
  saveMemory();
}

function rememberVisualState(plan) {
  memory.lastCommand = '';
  memory.lastPlan = visualOnlyPlan(plan);
  memory.updatedAt = new Date().toISOString();
  saveMemory();
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
app.use('/api/extension', (req, res, next) => {
  const origin = req.get('origin');
  const match = typeof origin === 'string' ? origin.match(CHROME_EXTENSION_ORIGIN) : null;
  if (origin && !match) {
    return res.status(403).json({ error: 'A API da ponte aceita somente origens de extensões Chrome.' });
  }
  if (match) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.vary('Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!match) return res.sendStatus(403);
    const requestedMethod = req.get('access-control-request-method');
    const requestedHeaders = (req.get('access-control-request-headers') || '')
      .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
    if (!['GET', 'POST'].includes(requestedMethod) || requestedHeaders.some(header => header !== 'content-type')) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  }
  next();
});
app.use('/api/vision', express.json({ limit: '24mb' }));
app.use(express.json({ limit: '600kb' }));
app.use('/api/', rateLimit({
  windowMs: 60_000,
  limit: 60,
  skip: req => req.path.startsWith('/extension/')
}));
app.use('/api/automation', createAutomationRouter({ rootDirectory: ROOT, port: PORT }));
app.use('/api/vision', rateLimit({ windowMs: 60_000, limit: 20 }), createVisionRouter());

const shapes = ['sphere', 'torus', 'spiral', 'wave', 'cloud', 'face', 'terrain', 'custom'];
const partKinds = ['sphere', 'ellipsoid', 'torus', 'cylinder', 'cone', 'box'];
memory = loadMemory();
try { saveMemory(); }
catch {
  memory = emptyMemory();
  try { fs.unlinkSync(MEMORY_FILE); } catch {}
  console.error('GRID SOUL: memória legada não pôde ser sanitizada e foi desativada nesta sessão.');
}

// GRID_SOUL_CDP_BRIDGE
let busy = false;
let cdpBrowser = null;
let extensionTask = null;

async function getChatGPTPage() {
  if (!cdpBrowser || !cdpBrowser.isConnected()) {
    cdpBrowser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  }

  const contexts = cdpBrowser.contexts();
  if (!contexts.length) throw new Error("Nenhum contexto Chrome disponível.");

  const context = contexts[0];
  const pages = context.pages();
  const allowedChatOrigins = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
  let page = pages.find(candidate => {
    try {
      const url = new URL(candidate.url());
      return url.protocol === 'https:' && allowedChatOrigins.has(url.origin);
    } catch { return false; }
  });

  if (!page) {
    page = await context.newPage();
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  await page.bringToFront();
  return page;
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}


function extractJSON(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") {
    throw new Error("A resposta do ChatGPT não é texto.");
  }

  const text = raw.replace(/```(?:json)?/gi, "");

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];

      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }

      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(i, j + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {}
        break;
      }
    }
  }

  throw new Error("O ChatGPT não retornou um JSON válido.");
}

function sanitizePlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("O plano visual recebido é inválido.");
  }

  const number = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
  const safeColor = (value, fallback) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toUpperCase() : fallback;

  const allowedShapes = new Set(shapes);
  const geometryInput = input.geometry && typeof input.geometry === 'object' && !Array.isArray(input.geometry)
    ? input.geometry : {};
  const isHumanoidObject = input.object === 'grid_soul_humanoid' && geometryInput.type === 'human_face';
  const shape = isHumanoidObject ? 'face' : allowedShapes.has(input.shape) ? input.shape : 'sphere';
  const color = safeColor(input.color, '#00DFFF');
  const rawFaceProfile = input.faceProfile && typeof input.faceProfile === 'object'
    ? input.faceProfile : input;
  const profileGeometry = rawFaceProfile.geometry && typeof rawFaceProfile.geometry === 'object'
    ? rawFaceProfile.geometry : geometryInput;
  const profileGrid = profileGeometry.grid && typeof profileGeometry.grid === 'object' ? profileGeometry.grid : {};
  const profileFace = rawFaceProfile.face && typeof rawFaceProfile.face === 'object' ? rawFaceProfile.face : {};
  const profileMaterials = rawFaceProfile.materials && typeof rawFaceProfile.materials === 'object' ? rawFaceProfile.materials : {};
  const profileMesh = rawFaceProfile.mesh && typeof rawFaceProfile.mesh === 'object' ? rawFaceProfile.mesh : {};
  const profileParticles = rawFaceProfile.particles && typeof rawFaceProfile.particles === 'object' ? rawFaceProfile.particles : {};
  const profileLighting = rawFaceProfile.lighting && typeof rawFaceProfile.lighting === 'object' ? rawFaceProfile.lighting : {};
  const profileRender = rawFaceProfile.render && typeof rawFaceProfile.render === 'object' ? rawFaceProfile.render : {};
  const particleColors = Array.isArray(profileParticles.colors)
    ? profileParticles.colors.slice(0, 8).map(c => safeColor(c, null)).filter(Boolean)
    : [];
  const faceProfile = shape === 'face' ? {
    geometry: {
      type: 'human_face',
      representation: profileGeometry.representation === 'voxel_mesh' ? 'voxel_mesh' : 'voxel_mesh',
      referenceMode: 'cube_atlas',
      density: number(profileGeometry.density, 0.92, 0.1, 1),
      distribution: ['surface_adaptive', 'uniform_lattice'].includes(profileGeometry.distribution)
        ? profileGeometry.distribution : 'surface_adaptive',
      grid: {
        type: '3d_cubic_lattice',
        cellShape: 'cube',
        size: number(profileGrid.size, 0.025, 0.005, 0.15),
        spacing: number(profileGrid.spacing, 0.004, 0, 0.08),
        adaptiveResolution: boolean(profileGrid.adaptiveResolution, true),
        surfaceConforming: boolean(profileGrid.surfaceConforming, true),
        preserveFacialFeatures: boolean(profileGrid.preserveFacialFeatures, true)
      }
    },
    materials: {
      base: safeColor(profileMaterials.base, '#005BFF'),
      primary: safeColor(profileMaterials.primary, '#00E5FF'),
      secondary: safeColor(profileMaterials.secondary, '#7B2CFF'),
      accent: safeColor(profileMaterials.accent, '#FF38D1'),
      highlight: safeColor(profileMaterials.highlight, '#FFD34D'),
      metallic: number(profileMaterials.metallic, 0.65, 0, 1),
      roughness: number(profileMaterials.roughness, 0.22, 0.02, 1),
      emissiveIntensity: number(profileMaterials.emissiveIntensity, 1.5, 0, 3)
    },
    face: {
      symmetry: number(profileFace.symmetry, 0.92, 0, 1),
      eyeDetail: number(profileFace.eyeDetail, 1, 0, 1.5),
      noseDetail: number(profileFace.noseDetail, 0.95, 0, 1.5),
      mouthDetail: number(profileFace.mouthDetail, 0.95, 0, 1.5),
      surfaceDisplacement: number(profileFace.surfaceDisplacement, 0.035, 0, 0.2),
      expression: ['neutral', 'smile', 'frown'].includes(profileFace.expression) ? profileFace.expression : 'neutral',
      orientation: ['frontal', 'three_quarter', 'profile'].includes(profileFace.orientation) ? profileFace.orientation : 'frontal'
    },
    mesh: {
      connectivity: 'neighbor_lattice',
      renderCubesIndividually: true,
      mergeAdjacentFaces: false,
      edgeDefinition: number(profileMesh.edgeDefinition, 0, 0, 0.5),
      surfaceContinuity: number(profileMesh.surfaceContinuity, 1, 0, 1),
      lod: boolean(profileMesh.lod, false)
    },
    particles: {
      enabled: boolean(profileParticles.enabled, true),
      count: Math.round(number(profileParticles.count, 0, 0, 10000)),
      distribution: profileParticles.distribution === 'orbiting_surface' ? 'orbiting_surface' : 'orbiting_surface',
      dispersion: number(profileParticles.dispersion, 0.35, 0, 2),
      sizeVariation: number(profileParticles.sizeVariation, 0.8, 0, 1),
      colors: particleColors.length ? particleColors : ['#00E5FF', '#126BFF', '#A52CFF', '#FF38D1', '#FFD34D']
    },
    lighting: {
      bloom: number(profileLighting.bloom, 0, 0, 3),
      contrast: number(profileLighting.contrast, 1, 0.5, 2),
      ambient: number(profileLighting.ambient, 0.12, 0, 1),
      keyLight: safeColor(profileLighting.keyLight, '#00CFFF'),
      rimLight: safeColor(profileLighting.rimLight, '#A52CFF'),
      background: safeColor(profileLighting.background, '#020617')
    },
    render: {
      quality: ['standard', 'high', 'ultra'].includes(profileRender.quality) ? profileRender.quality : 'high',
      antialiasing: boolean(profileRender.antialiasing, true),
      shadows: boolean(profileRender.shadows, false),
      depthOfField: number(profileRender.depthOfField, 0, 0, 1),
      transparentBackground: boolean(profileRender.transparentBackground, false)
    }
  } : null;

  const materialInput = input.materials && typeof input.materials === 'object' && !Array.isArray(input.materials)
    ? input.materials : {};
  const materialDefaults = {
    neutral: { metallic: 0.25, roughness: 0.35 },
    steel: { metallic: 0.88, roughness: 0.28 },
    aluminum: { metallic: 0.9, roughness: 0.24 },
    copper: { metallic: 0.92, roughness: 0.26 },
    iron: { metallic: 0.86, roughness: 0.38 },
    plastic: { metallic: 0, roughness: 0.4 },
    glass: { metallic: 0.05, roughness: 0.08 },
    wood: { metallic: 0, roughness: 0.68 }
  };
  const preset = Object.hasOwn(materialDefaults, materialInput.preset) ? materialInput.preset : 'neutral';
  const materialProfile = faceProfile?.materials || {
    preset,
    albedo: safeColor(materialInput.albedo, '#FFFFFF'),
    metallic: number(materialInput.metallic, materialDefaults[preset].metallic, 0, 1),
    roughness: number(materialInput.roughness, materialDefaults[preset].roughness, 0.02, 1),
    emissiveColor: safeColor(materialInput.emissiveColor, '#000000'),
    emissiveIntensity: number(materialInput.emissiveIntensity, 0, 0, 3)
  };

  const allowedKinds = new Set(partKinds);
  const parts = shape === "custom" && Array.isArray(input.parts)
    ? input.parts.slice(0, 24).filter(p => p && typeof p === "object").map(p => ({
        kind: allowedKinds.has(p.kind) ? p.kind : "box",
        x: number(p.x, 0, -4, 4),
        y: number(p.y, 0, -4, 4),
        z: number(p.z, 0, -4, 4),
        sx: number(p.sx, 0.5, 0.05, 3),
        sy: number(p.sy, 0.5, 0.05, 3),
        sz: number(p.sz, 0.5, 0.05, 3),
        rx: number(p.rx, 0, -6.28, 6.28),
        ry: number(p.ry, 0, -6.28, 6.28),
        rz: number(p.rz, 0, -6.28, 6.28),
        color: safeColor(p.color, null)
      }))
    : [];

  return {
    object: shape === 'face' ? 'grid_soul_humanoid' : undefined,
    geometry: faceProfile ? { ...faceProfile.geometry, population: Math.round(number(isHumanoidObject ? geometryInput.population : input.population, 85000, 1000, 500000)), scale: number(isHumanoidObject ? geometryInput.scale : input.scale, 2.5, 0.5, 8) } : undefined,
    materials: materialProfile,
    face: faceProfile?.face,
    mesh: faceProfile?.mesh,
    particles: faceProfile?.particles,
    lighting: faceProfile?.lighting,
    render: faceProfile?.render,
    reply: typeof input.reply === "string"
      ? input.reply.slice(0, 1000)
      : "Plano visual recebido pelo GRID SOUL.",
    shape,
    population: Math.round(number(isHumanoidObject ? geometryInput.population : input.population, 85000, 1000, 500000)),
    energy: number(input.energy, 0.7, 0, 1),
    scale: number(isHumanoidObject ? geometryInput.scale : input.scale, 2.5, 0.5, 8),
    cubeSize: number(input.cubeSize, 1, 0.35, 2.5),
    rotationX: number(input.rotationX, 0, -6.28, 6.28),
    rotationY: number(input.rotationY, 0, -6.28, 6.28),
    rotationZ: number(input.rotationZ, 0, -6.28, 6.28),
    moveX: number(input.moveX, 0, -10, 10),
    moveY: number(input.moveY, 0, -10, 10),
    moveZ: number(input.moveZ, 0, -10, 10),
    color,
    paletteMode: isHumanoidObject ? 'face' : ['chemical', 'single', 'rainbow', 'plasma', 'fire', 'green', 'cyan', 'face'].includes(input.paletteMode)
      ? input.paletteMode
      : 'chemical',
    focusedAtomicNumber: Number.isInteger(Number(input.focusedAtomicNumber)) && Number(input.focusedAtomicNumber) >= 1 && Number(input.focusedAtomicNumber) <= 118
      ? Number(input.focusedAtomicNumber)
      : null,
    identityVersion: 'cube-slot-modulo-118-v1',
    faceProfile,
    parts
  };
}

async function askChatGPT(prompt) {
  const page = await getChatGPTPage();
  const composer = await firstVisible(page, [
    '[data-chatgpt-composer] [role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    '[aria-label="Ask ChatGPT"]',
    "textarea"
  ]);

  if (!composer) throw new Error("Campo de mensagem não encontrado no ChatGPT.");

  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Parar"]'
  ];

  if (await firstVisible(page, stopSelectors)) {
    throw new Error("O ChatGPT ainda está gerando uma resposta anterior.");
  }

  const body = page.locator("body");
  const before = await body.innerText().catch(() => "");
  const beforeAssistantCount = await page.locator(
    '[data-message-author-role="assistant"]'
  ).count().catch(() => 0);

  await composer.fill(prompt);

  // O botão de envio da interface atual pode não ter rótulo acessível.
  // Após preencher, o último botão do formulário do compositor é o enviar.
  const form = composer.locator("xpath=ancestor::form[1]");
  const send = form.locator("button").last();

  if (await send.count()) {
    const sendInfo = await send.evaluate(b => ({
      visible: (() => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(),
      disabled: b.disabled,
      aria: b.getAttribute("aria-label"),
      svg: b.querySelector("svg use")?.getAttribute("href") || ""
    }));

    if (sendInfo.visible && !sendInfo.disabled &&
        !/voice|microphone|microfone/i.test(
          (sendInfo.aria || "") + " " + sendInfo.svg
        )) {
      await send.click();
    } else {
      await composer.press("Enter");
    }
  } else {
    await composer.press("Enter");
  }

  const deadline = Date.now() + 180000;
  let lastCandidate = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(500);

    const generating = await firstVisible(page, stopSelectors);
    const currentText = await body.innerText().catch(() => "");

    let candidate = "";
    let newResponse = false;

    // Preferir a última mensagem real do assistente quando disponível.
    const messages = page.locator('[data-message-author-role="assistant"]');
    const count = await messages.count().catch(() => 0);

    if (count > beforeAssistantCount && count > 0) {
      candidate = (await messages.nth(count - 1).innerText().catch(() => "")).trim();
      newResponse = candidate.length > 0;
    }

    // Compatibilidade com interfaces que usam marcadores textuais.
    if (!newResponse) {
      const markers = ["ChatGPT said:", "ChatGPT disse:"];
      let markerIndex = -1;
      let markerLength = 0;

      for (const marker of markers) {
        const i = currentText.lastIndexOf(marker);
        if (i > markerIndex) {
          markerIndex = i;
          markerLength = marker.length;
        }
      }

      if (markerIndex >= 0) {
        const tail = currentText.slice(markerIndex + markerLength).trim();
        if (tail && tail !== before.trim()) {
          candidate = tail;
          newResponse = true;
        }
      }
    }

    // Último recurso: considerar apenas o texto acrescentado após o envio.
    if (!newResponse && currentText.startsWith(before)) {
      const appended = currentText.slice(before.length).trim();
      if (appended.length > 10) {
        candidate = appended;
        newResponse = true;
      }
    }

    let validJSON = false;
    if (newResponse && candidate) {
      try {
        extractJSON(candidate);
        validJSON = true;
      } catch {}
    }

    if (candidate !== lastCandidate) {
      lastCandidate = candidate;
      stableSince = Date.now();
    }

    if (generating) stableSince = Date.now();

    if (newResponse && validJSON && !generating &&
        Date.now() - stableSince >= 1800) {
      return candidate;
    }
  }

  console.error("GRID SOUL: tempo esgotado aguardando resposta JSON do ChatGPT.");
  throw new Error("Tempo esgotado aguardando JSON novo do ChatGPT.");
}

function askChatGPTWithExtension(prompt) {
  if (extensionTask) {
    return Promise.reject(new Error('A ponte da extensão já tem um comando pendente.'));
  }

  return new Promise((resolve, reject) => {
    const task = { id: randomUUID(), message: prompt, delivered: false, resolve, reject, timeout: null };
    task.timeout = setTimeout(() => {
      if (extensionTask === task) extensionTask = null;
      reject(new Error('Tempo esgotado aguardando a extensão do Chrome.'));
    }, 180_000);
    extensionTask = task;
  });
}

function requestChatGPT(prompt) {
  return BRIDGE_MODE === 'extension' ? askChatGPTWithExtension(prompt) : askChatGPT(prompt);
}

app.get('/api/memory', (_req, res) => {
  res.json({
    ok: true,
    updatedAt: memory.updatedAt,
    lastCommand: memory.lastCommand,
    lastPlan: memory.lastPlan,
    historyCount: memory.history.length
  });
});

app.post('/api/memory/state', (req, res) => {
  try {
    const plan = sanitizePlan(req.body?.plan);
    rememberVisualState(plan);
    res.json({ ok: true, updatedAt: memory.updatedAt });
  } catch (err) {
    console.error('GRID SOUL memory:', String(err.message || err).slice(0, 200));
    res.status(400).json({ error: 'Estado de memória inválido.' });
  }
});

let extensionPresence = null;
const EXTENSION_HEARTBEAT_TIMEOUT_MS = 90_000;

app.post('/api/extension/heartbeat', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Envie application/json.' });
  const id = req.body?.id;
  const version = req.body?.version;
  if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) {
    return res.status(400).json({ error: 'ID runtime da extensão Chrome inválido.' });
  }
  if (typeof version !== 'string' || !/^\d{1,4}(\.\d{1,4}){0,3}$/.test(version)) {
    return res.status(400).json({ error: 'Versão da extensão inválida.' });
  }
  const originId = req.get('origin')?.match(CHROME_EXTENSION_ORIGIN)?.[1];
  if (originId && originId !== id) return res.status(403).json({ error: 'O ID do heartbeat não corresponde à origem Chrome que o enviou.' });
  extensionPresence = { id, version, lastSeen: new Date().toISOString(), lastSeenAt: Date.now() };
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/api/extension/next', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!extensionTask || extensionTask.delivered) return res.json({});
  res.json({ id: extensionTask.id, message: extensionTask.message });
});

app.post('/api/extension/claim', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Envie application/json.' });
  const task = extensionTask;
  if (!task || req.body?.id !== task.id) return res.status(404).json({ error: 'Tarefa da extensão não encontrada.' });
  if (task.delivered) return res.status(409).json({ error: 'Tarefa já reivindicada.' });
  task.delivered = true;
  res.json({ ok: true });
});

app.post('/api/extension/result', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Envie application/json.' });
  const task = extensionTask;
  if (!task || !task.delivered || req.body?.id !== task.id) {
    return res.status(404).json({ error: 'Tarefa da extensão não encontrada.' });
  }
  const result = typeof req.body?.result === 'string' ? req.body.result : '';
  const error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 300) : '';
  if (result.length > 7000) {
    return res.status(413).json({ error: 'Resposta da extensão excede o limite permitido.' });
  }
  extensionTask = null;
  clearTimeout(task.timeout);
  if (error) task.reject(new Error(error));
  else task.resolve(result);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  const extensionOnline = Boolean(extensionPresence && Date.now() - extensionPresence.lastSeenAt <= EXTENSION_HEARTBEAT_TIMEOUT_MS);
  res.json({
    ok: true,
    service: "GRID SOUL",
    brain: BRIDGE_MODE === 'extension'
      ? 'ChatGPT via extensão do Chrome'
      : 'ChatGPT via Playwright/CDP no Chrome',
    bridge: BRIDGE_MODE,
    port: PORT,
    browserReady: Boolean(cdpBrowser && cdpBrowser.isConnected()),
    extension: BRIDGE_MODE === 'extension' ? {
      connected: extensionOnline,
      id: extensionPresence?.id || null,
      version: extensionPresence?.version || null,
      lastSeen: extensionPresence?.lastSeen || null
    } : null,
    busy
  });
});

app.post("/api/command", async (req, res) => {
  const message = req.body?.message;
  const currentPopulation = Number(req.body?.population);
  const currentEnergy = Number(req.body?.energy);
  const currentScale = Number(req.body?.scale);
  const currentCubeSize = Number(req.body?.cubeSize);

  if (typeof message !== "string" || !message.trim() || message.length > 1200) {
    return res.status(400).json({ error: "Informe um comando de até 1200 caracteres." });
  }
  if (busy) {
    return res.status(429).json({ error: "O GRID SOUL já está aguardando outra resposta do ChatGPT." });
  }

  busy = true;
  try {
    const prompt = [
      "Você é o cérebro do GRID SOUL: planeja uma cena Babylon.js como um único enxame visual coordenado de microcubos 3D.",
      "Responda SOMENTE com um objeto JSON válido, sem markdown ou texto externo.",
      "Campos aceitos: reply, shape, population, energy, scale, cubeSize, rotationX, rotationY, rotationZ, moveX, moveY, moveZ, color, materials, parts, paletteMode, focusedAtomicNumber.",
      "Para uma face humanoide, também pode retornar o perfil aninhado: object=grid_soul_humanoid; geometry.type=human_face; geometry.representation=voxel_mesh; geometry.population/scale/density/distribution/grid; materials; face; mesh; particles; lighting; render. O servidor normaliza, limita e valida os parâmetros e mantém os campos legados shape=face, population, scale e paletteMode=face.",
      "Perfil facial: reconstrua o rosto frontal usando somente os cubos instanciados do mapa de amostras da referência; não crie textura, sprite, fotografia como plano nem malha facial. As coordenadas e RGB das amostras já vêm da referência e prevalecem sobre a paleta/material/iluminação artificiais. Mantenha a face frontal. Perfil: geometry.representation=voxel_mesh, grid size=0.025, density=0.92, scale=2.5, face symmetry=0.92, eyeDetail=1, noseDetail/mouthDetail=0.95, neutral/frontal; fundo #020617. Ao usuário pedir rosto exatamente igual/fiel ao anexo ou à referência e não especificar outra população, use 88000 slots para corresponder ao mapa. Para pedidos comuns, conserve a população atual; respeite sempre uma população que o usuário especificar explicitamente. Cubos orbitais já estão contidos no mapa de referência: não acrescente outra faixa de partículas.",
      "A geometria.grid contém type=3d_cubic_lattice, cellShape=cube, size, spacing, adaptiveResolution, surfaceConforming e preserveFacialFeatures. A face aceita symmetry, eyeDetail, noseDetail, mouthDetail, surfaceDisplacement, expression e orientation. materials aceita base/primary/secondary/accent/highlight, metallic, roughness e emissiveIntensity.",
      "O palco usa um PBRMaterial por enxame e RGB por instância. Para materiais gerais, materials pode conter preset (neutral, steel, aluminum, copper, iron, plastic, glass ou wood), albedo #RRGGBB, metallic 0..1, roughness 0.02..1, emissiveColor e emissiveIntensity. Prefira defaults adequados ao material. Glass é somente uma aparência visual opaca; não prometa transparência física. O perfil facial nested materials permanece reservado ao modo rosto.",
      "mesh preserva cubos individuais e topologia de vizinhos; particles controla enabled/count/distribution/dispersion/sizeVariation/colors. O viewer tem orçamento e amostragem LOD adaptativos por hardware; isso reduz instâncias visíveis sem mudar população lógica. bloom, sombras em tempo real e profundidade de campo continuam não implementados.",
      "shape permitido: sphere, torus, spiral, wave, cloud, face, terrain, custom.",
      "population inteiro entre 1000 e 500000; energy entre 0 e 1; scale entre 0.5 e 8; cubeSize é multiplicador independente entre 0.35 e 2.5.",
      "Planejamento de renderização: não use cor única por padrão. Prefira paletteMode=chemical para identidade determinística multicolorida ou paletteMode=rainbow/plasma se o pedido enfatizar várias cores; só escolha single/monocromático quando o usuário pedir explicitamente uma única cor. Dê instruções de cores variadas e distribuídas, preservando as cores da referência quando houver amostra de imagem. Separe energia (movimento/coesão) de tamanho físico dos cubos: use cubeSize e só o altere quando pedido. Energia coletiva não é força física.",
      "Em reply, explique brevemente em português (ou no idioma do usuário) o plano que será aplicado: paleta multicolorida e como os tons se distribuem, componentes/cores quando for composto, perfil de material PBR, população/densidade e relação com área/detalhe, energia coletiva, tamanho dos microcubos e escala visual. Distinga valores medidos de suposições; nunca declare milímetros/metragem real, precisão industrial ou capacidade de impressão sem dados.",
      "A população deve ser adequada à área aparente solicitada e ao nível de detalhe, não maximizada cegamente. Se o usuário especificar uma população, respeite-a exatamente dentro dos limites. Se indicar mais área/escala sem população, escolha uma densidade proporcional à área projetada (população cresce aproximadamente com o quadrado da escala visual), preserve distribuição regular e limite de desempenho. Se não solicitar alteração de área, detalhe, população, energia ou tamanho, preserve os valores atuais. scale é uma escala visual sem unidade física e não certifica uma dimensão em metros.",
      "Rotações entre -6.28 e 6.28; moveX, moveY e moveZ entre -10 e 10; color hexadecimal #RRGGBB.",
      "Para pedidos compostos (por exemplo, casa futurista ou suporte mecânico visual), prefira shape=custom e represente cada base, parede, pilar, janela, telhado, nervura ou braço por um componente espacial separado; não use uma única caixa para um objeto complexo. Deixe vazios entre componentes ou use toroides/cilindros para sugerir aberturas. É uma voxelização visual de primitivas; não é operação booleana CAD nem validação de fabricação.",
      "parts deve ser [] exceto para shape custom. Para custom, no máximo 24 partes.",
      "Cada parte: kind, x, y, z, sx, sy, sz, rx, ry, rz e color opcional #RRGGBB. kind: sphere, ellipsoid, torus, cylinder, cone ou box. Cores explícitas por peça só devem ser usadas para componentes/materiais distintos; caso contrário, mantenha a identidade química multicolorida.",
      "Posições entre -4 e 4; dimensões entre 0.05 e 3; rotações entre -6.28 e 6.28.",
      "Os IDs dos microcubos e seus elementos químicos são persistentes e determinísticos; não reatribua elementos. Use paletteMode=chemical por padrão; paletteMode pode ser face para rosto holográfico, single, rainbow, plasma, fire, green ou cyan quando solicitado. Para shape=face ou object=grid_soul_humanoid, os destinos de cada cubo são calculados localmente usando os slots existentes e o atlas de amostras. focusedAtomicNumber deve ser null, salvo seleção explícita.",
      `População atual do enxame: ${Number.isInteger(currentPopulation) && currentPopulation >= 1000 && currentPopulation <= 500000 ? currentPopulation : 85000}.`,
      `Energia atual: ${Number.isFinite(currentEnergy) ? Math.max(0, Math.min(1, currentEnergy)) : 0.6}; escala visual atual: ${Number.isFinite(currentScale) ? Math.max(0.5, Math.min(8, currentScale)) : 2}; multiplicador de tamanho do cubo atual: ${Number.isFinite(currentCubeSize) ? Math.max(0.35, Math.min(2.5, currentCubeSize)) : 1}.`,
      "Não produza código executável nem comandos de sistema.",
      "Pedido do usuário: " + message.trim()
    ].join("\n");

    const raw = await requestChatGPT(prompt);
    const plan = sanitizePlan(extractJSON(raw));
    const structuredHumanoidPopulation = /["']object["']\s*:\s*["']grid_soul_humanoid["'][\s\S]*?["']population["']\s*:\s*\d+/i.test(message);
    const requestedPopulationChange = structuredHumanoidPopulation || /\b(popula(?:ção|cao)|microcubos?|cubos?)\b.{0,45}\b(\d{3,}|aument|reduz|mais|menos|metade|dobro)\b|\b(aumente|reduza|amplie|diminua)\b.{0,35}\b(popula(?:ção|cao)|microcubos?|cubos?)\b/i.test(message);
    const asksReferenceMatch = /\b(exatamente|id[eê]ntic[oa]|igual|fiel)\b/i.test(message)
      && /\b(rosto|face|humanoide|refer[eê]ncia|anexo|imagem)\b/i.test(message);
    const explicitAreaOrScale = /\b(área|area|mapa|terreno|largura|comprimento|escala|metros?|quilômetros?|hectares?)\b/i.test(message)
      && /\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m|metros?|km|quilômetros?|hectares?)\b/i.test(message);
    const explicitCubeSize = /\b(tamanho|microcubos?|cubos?)\b.{0,35}\b(maior(?:es)?|menor(?:es)?|grande|pequeno|aument|reduz|espessura|grossura)\b|\b(?:aumente|reduza|engrosse|afine)\b.{0,30}\b(cubos?|microcubos?)\b/i.test(message);
    const explicitEnergy = /\benergia\b/i.test(message);
    const explicitMonochrome = /\b(cor única|uma única cor|monocrom[aá]tic[oa]s?)\b/i.test(message);
    if (!explicitMonochrome && plan.paletteMode === 'single') plan.paletteMode = 'chemical';
    if (!explicitCubeSize && Number.isFinite(currentCubeSize)) plan.cubeSize = Math.max(0.35, Math.min(2.5, currentCubeSize));
    if (!explicitEnergy && Number.isFinite(currentEnergy)) plan.energy = Math.max(0, Math.min(1, currentEnergy));
    if (!requestedPopulationChange && asksReferenceMatch && plan.shape === 'face') {
      plan.population = 88000;
      if (plan.geometry && typeof plan.geometry === 'object') plan.geometry.population = 88000;
    } else if (!requestedPopulationChange && !explicitAreaOrScale && Number.isInteger(currentPopulation) && currentPopulation >= 1000 && currentPopulation <= 500000) {
      plan.population = currentPopulation;
      if (plan.geometry && typeof plan.geometry === 'object') plan.geometry.population = currentPopulation;
    }
    try {
      rememberSuccessfulCommand(plan);
    } catch (memoryError) {
      console.error("GRID SOUL memory write:", String(memoryError.message || memoryError).slice(0, 200));
    }
    res.json(plan);
  } catch (err) {
    console.error(BRIDGE_MODE === 'extension' ? 'ChatGPT extension bridge:' : 'ChatGPT CDP bridge:', String(err.message || err).slice(0, 500));
    res.status(502).json({
      error: String(err.message || "Não foi possível obter um plano válido do ChatGPT.").slice(0, 300)
    });
  } finally {
    busy = false;
  }
});

const ENGINEERING_SESSION_COOKIE = 'grid_soul_engineering_session';
const ENGINEERING_CONSENT_TTL_MS = 2 * 60 * 1000;
const engineeringConsentTokens = new Map();

function getEngineeringSession(req, res) {
  const existing = (req.get('cookie') || '').split(';')
    .map(part => part.trim().split('='))
    .find(([name]) => name === ENGINEERING_SESSION_COOKIE)?.[1];
  if (typeof existing === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(existing)) return existing;
  const session = randomBytes(32).toString('base64url');
  res.append('Set-Cookie', `${ENGINEERING_SESSION_COOKIE}=${session}; Path=/api/engineering; HttpOnly; SameSite=Strict; Max-Age=900`);
  return session;
}

function engineeringRequestGate(req, res, next) {
  const host = req.get('host') || '';
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!allowedHosts.has(host) || (origin && origin !== `http://${host}`) || (fetchSite && fetchSite !== 'same-origin')) {
    return res.status(403).json({ error: 'Engenharia disponível somente pela interface local do GRID SOUL.' });
  }
  req.engineeringSession = getEngineeringSession(req, res);
  res.set('Cache-Control', 'no-store');
  next();
}

function isExplicitEngineeringBrowserRequest(req) {
  const host = req.get('host') || '';
  return req.get('origin') === `http://${host}` && req.get('sec-fetch-site') === 'same-origin';
}

function validateEngineeringInput(body) {
  const description = body?.description;
  if (typeof description !== 'string' || !description.trim() || description.length > 1200) {
    throw new Error('Descreva o projeto em até 1.200 caracteres.');
  }
  const intendedUse = body?.intendedUse ?? 'prototype';
  if (!['prototype', 'decorative', 'food-contact'].includes(intendedUse)) {
    throw new Error('Finalidade de uso inválida.');
  }
  const parameters = body?.parameters ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('Os parâmetros dimensionais devem ser um objeto JSON.');
  }
  return { description, intendedUse, parameters };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function engineeringPayloadDigest(input) {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

app.get('/api/engineering/materials', engineeringRequestGate, (_req, res) => {
  res.json({ verifiedOn: MATERIAL_CATALOG_VERIFIED_ON, materials: GRID_SOUL_MATERIALS });
});

app.post('/api/engineering/consent', engineeringRequestGate, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'O consentimento requer JSON da interface local.' });
  if (!isExplicitEngineeringBrowserRequest(req)) {
    return res.status(403).json({ error: 'Confirme o envio pela interface local do GRID SOUL.' });
  }
  let input;
  try { input = validateEngineeringInput(req.body); }
  catch (error) { return res.status(400).json({ error: String(error.message || 'Dados de projeto inválidos.').slice(0, 300) }); }

  const now = Date.now();
  for (const [token, record] of engineeringConsentTokens) {
    if (record.expiresAt <= now) engineeringConsentTokens.delete(token);
  }
  if (engineeringConsentTokens.size >= 256) return res.status(429).json({ error: 'Há muitas confirmações aguardando; tente novamente em instantes.' });
  const consentToken = randomBytes(32).toString('base64url');
  const expiresAt = now + ENGINEERING_CONSENT_TTL_MS;
  engineeringConsentTokens.set(consentToken, {
    session: req.engineeringSession,
    payloadDigest: engineeringPayloadDigest(input),
    expiresAt
  });
  return res.status(201).json({ consentToken, expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/api/engineering/analyze', engineeringRequestGate, async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'A análise requer JSON enviado pela interface local.' });
  let input;
  try { input = validateEngineeringInput(req.body); }
  catch (error) { return res.status(400).json({ error: String(error.message || 'Dados de projeto inválidos.').slice(0, 300) }); }
  const { description, intendedUse, parameters } = input;
  const useAI = req.body?.useAI === true;

  if (!useAI) {
    try { return res.json({ ok: true, result: analyzeForkLocally(description, parameters, intendedUse) }); }
    catch (error) { return res.status(400).json({ error: String(error.message || 'Parâmetros inválidos.').slice(0, 300) }); }
  }
  if (!isExplicitEngineeringBrowserRequest(req)) {
    return res.status(403).json({ error: 'A análise externa exige uma confirmação iniciada pela interface local.' });
  }
  if (busy) return res.status(429).json({ error: 'A ponte de IA já está processando outra solicitação.' });

  const consentToken = req.body?.consentToken;
  const consent = typeof consentToken === 'string' ? engineeringConsentTokens.get(consentToken) : null;
  if (typeof consentToken === 'string') engineeringConsentTokens.delete(consentToken);
  if (!consent || consent.expiresAt <= Date.now() || consent.session !== req.engineeringSession
      || consent.payloadDigest !== engineeringPayloadDigest(input)) {
    return res.status(403).json({ error: 'A confirmação está ausente, expirada ou não corresponde à descrição/parâmetros. Confirme novamente na interface.' });
  }

  busy = true;
  try {
    const prompt = buildEngineeringPrompt(description, parameters, intendedUse);
    const raw = await requestChatGPT(prompt);
    const proposal = sanitizeEngineeringProposal(extractJSON(raw), { description, currentParameters: parameters, intendedUse });
    return res.json({ ok: true, result: proposal });
  } catch (error) {
    console.error('GRID SOUL engineering assistant:', String(error.message || error).slice(0, 300));
    return res.status(502).json({ error: String(error.message || 'Não foi possível obter uma proposta técnica.').slice(0, 300) });
  } finally {
    busy = false;
  }
});

app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three'), {
  immutable: true, maxAge: '1y', fallthrough: false
}));
app.use('/vendor/babylon', express.static(path.join(ROOT, 'node_modules', '@babylonjs', 'core'), {
  immutable: true, maxAge: '1y', fallthrough: false
}));
app.use(express.static(path.join(ROOT, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`GRID SOUL: http://127.0.0.1:${PORT}`);
  console.log(BRIDGE_MODE === 'extension'
    ? 'Cérebro: ChatGPT via extensão carregada no navegador.'
    : 'Cérebro: ChatGPT via Playwright/CDP em 127.0.0.1:9222.');
});
