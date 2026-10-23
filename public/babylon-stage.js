import '/vendor/babylon/Meshes/thinInstanceMesh.js';
import { Engine } from '/vendor/babylon/Engines/engine.js';
import { Scene } from '/vendor/babylon/scene.js';
import { ArcRotateCamera } from '/vendor/babylon/Cameras/arcRotateCamera.js';
import { HemisphericLight } from '/vendor/babylon/Lights/hemisphericLight.js';
import { DirectionalLight } from '/vendor/babylon/Lights/directionalLight.js';
import { PBRMaterial } from '/vendor/babylon/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '/vendor/babylon/Materials/standardMaterial.js';
import { DynamicTexture } from '/vendor/babylon/Materials/Textures/dynamicTexture.js';
import { TransformNode } from '/vendor/babylon/Meshes/transformNode.js';
import { CreateBox } from '/vendor/babylon/Meshes/Builders/boxBuilder.js';
import { CreateSphere } from '/vendor/babylon/Meshes/Builders/sphereBuilder.js';
import { CreatePlane } from '/vendor/babylon/Meshes/Builders/planeBuilder.js';
import { CreateTorus } from '/vendor/babylon/Meshes/Builders/torusBuilder.js';
import { Color3, Color4 } from '/vendor/babylon/Maths/math.color.js';
import { Vector3 } from '/vendor/babylon/Maths/math.vector.js';
import { createBabylonInstanceSamplePlan } from '/babylon-plan-adapter.js';

const MAX_POPULATION = 500_000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const hexColor = value => {
  try { return Color3.FromHexString(String(value)); }
  catch { return Color3.FromHexString('#35eaff'); }
};

function displayBudget(engine) {
  const cores = Number(navigator.hardwareConcurrency) || 8;
  const memory = Number(navigator.deviceMemory) || 8;
  const caps = engine.getCaps?.() || {};
  const lowGpu = Number(caps.maxTextureSize) > 0 && caps.maxTextureSize < 4096;
  if (memory <= 4 || cores <= 4 || lowGpu) return 100_000;
  if (memory <= 8 || cores <= 8) return 250_000;
  return MAX_POPULATION;
}

export class GridSoulBabylonStage {
  constructor(canvas, metricsElement, onReady = () => {}) {
    this.canvas = canvas;
    this.metricsElement = metricsElement;
    this.onReady = onReady;
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.swarmMesh = null;
    this.swarmMaterial = null;
    this.matrixBuffer = new Float32Array(0);
    this.colorBuffer = new Float32Array(0);
    this.capacity = 0;
    this.active = 0;
    this.renderCount = 0;
    this.hardwareBudget = MAX_POPULATION;
    this.adaptiveBudget = MAX_POPULATION;
    this.backend = 'initializing';
    this.lastMatrixMs = 0;
    this.lastColorMs = 0;
    this.lastBuildMs = 0;
    this.lastMetricsAt = 0;
    this.lastFps = 0;
    this.lastFpsCheckAt = 0;
    this.frameWindowStart = 0;
    this.frameWindowFrames = 0;
    this.stableFastSince = 0;
    this.sourceColors = null;
    this.cameraState = { position: { x: 0, y: 5, z: 19 }, target: { x: 0, y: 0, z: 0 } };
    this.fitBounds = null;
    this.userCameraAdjusted = false;
    this.appearanceState = {};
    this.faceAtlasMode = false;
    this.matrixDirty = false;
    this.periodicRoot = null;
    this.periodicMeshes = [];
    this.atomRoot = null;
    this.electronEntries = [];
    this.atomRotation = 0;
    this.disposed = false;
    this.contextLost = false;
    this.ready = this.initialize();
  }

  async createEngine() {
    if (navigator.gpu) {
      let candidate = null;
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('Nenhum adapter WebGPU compatível foi anunciado.');
        const { WebGPUEngine } = await import('/vendor/babylon/Engines/webgpuEngine.js');
        candidate = new WebGPUEngine(this.canvas, { adaptToDeviceRatio: true, powerPreference: 'high-performance' });
        await candidate.initAsync();
        this.backend = 'WebGPU';
        return candidate;
      } catch (error) {
        console.info('GRID SOUL: WebGPU indisponível neste dispositivo; usando WebGL.', error);
        try { candidate?.dispose(); } catch { /* descarta o candidato parcialmente inicializado */ }
        // Um canvas não pode mudar de tipo de contexto depois de solicitar WebGPU.
        const fallbackCanvas = this.canvas.cloneNode(false);
        this.canvas.replaceWith(fallbackCanvas);
        this.canvas = fallbackCanvas;
      }
    }
    this.backend = 'WebGL';
    return new Engine(this.canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      antialias: true,
      powerPreference: 'high-performance',
      adaptToDeviceRatio: true
    });
  }

  async initialize() {
    try {
      this.engine = await this.createEngine();
      this.engine.onContextLostObservable?.add(() => {
        this.contextLost = true;
        if (this.metricsElement) this.metricsElement.textContent = 'Babylon.js · contexto gráfico perdido · aguardando restauração';
      });
      this.engine.onContextRestoredObservable?.add(() => {
        this.contextLost = false;
        this.frameWindowStart = 0;
        this.frameWindowFrames = 0;
        this.lastFps = 0;
        this.engine?.resize();
        if (this.swarmMesh && this.capacity) {
          this.swarmMesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16, false);
          this.swarmMesh.thinInstanceSetBuffer('color', this.colorBuffer, 4, false);
          this.swarmMesh.thinInstanceCount = this.renderCount;
        }
      });
      this.engine.setHardwareScalingLevel?.(Math.max(1, (window.devicePixelRatio || 1) / 1.5));
      this.scene = new Scene(this.engine);
      this.scene.useRightHandedSystem = true;
      this.scene.clearColor = new Color4(0.008, 0.025, 0.052, 1);
      this.scene.fogMode = Scene.FOGMODE_EXP2;
      this.scene.fogDensity = 0.012;
      this.scene.fogColor = hexColor('#020617');

      this.camera = new ArcRotateCamera('grid-soul-orbit-camera', -Math.PI / 2, 1.305, 19, Vector3.Zero(), this.scene);
      this.camera.setPosition(new Vector3(0, 5, 19));
      this.camera.fov = 50 * Math.PI / 180;
      this.camera.minZ = 0.05;
      this.camera.maxZ = 20_000_000;
      this.camera.lowerRadiusLimit = 2.8;
      this.camera.upperRadiusLimit = 90;
      this.camera.inertia = 0.82;
      this.camera.wheelPrecision = 22;
      this.camera.panningSensibility = 0;
      this.camera.attachControl(this.canvas, true);
      this.markCameraAdjusted = () => { this.userCameraAdjusted = true; };
      this.canvas.addEventListener('pointerdown', this.markCameraAdjusted, { passive: true });
      this.canvas.addEventListener('wheel', this.markCameraAdjusted, { passive: true });

      const hemi = new HemisphericLight('grid-soul-hemi', new Vector3(0, 1, 0), this.scene);
      hemi.diffuse = hexColor('#78baff');
      hemi.intensity = 1.3;
      const key = new DirectionalLight('grid-soul-key', new Vector3(-0.32, -0.7, -0.63), this.scene);
      key.diffuse = hexColor('#18dfff');
      key.intensity = 2.2;
      const rim = new DirectionalLight('grid-soul-rim', new Vector3(0.72, 0.3, 0.5), this.scene);
      rim.diffuse = hexColor('#2355ff');
      rim.intensity = 1.4;

      this.swarmMaterial = new PBRMaterial('grid-soul-microcube-pbr', this.scene);
      this.swarmMaterial.albedoColor = Color3.White();
      this.swarmMaterial.emissiveColor = hexColor('#073d58');
      this.swarmMaterial.metallic = 0.25;
      this.swarmMaterial.roughness = 0.25;
      this.swarmMaterial.useVertexColors = true;
      this.swarmMaterial.useVertexAlpha = false;
      this.swarmMaterial.backFaceCulling = true;
      this.swarmMesh = CreateBox('grid-soul-microcube-source', { size: 0.055 }, this.scene);
      this.swarmMesh.material = this.swarmMaterial;
      this.swarmMesh.isPickable = false;
      this.swarmMesh.alwaysSelectAsActiveMesh = true;
      this.swarmMesh.doNotSyncBoundingInfo = true;
      this.swarmMesh.thinInstanceEnablePicking = false;
      if (this.capacity) {
        this.swarmMesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16, false);
        this.swarmMesh.thinInstanceSetBuffer('color', this.colorBuffer, 4, false);
        this.swarmMesh.thinInstanceCount = this.renderCount;
      }

      this.hardwareBudget = displayBudget(this.engine);
      this.adaptiveBudget = this.hardwareBudget;
      this.setCamera(this.cameraState.position, this.cameraState.target);
      this.applyFitBounds();
      this.setAppearance(this.appearanceState);
      this.setFaceAtlasMode(this.faceAtlasMode);
      if (this.sourceColors) this.setColors(this.sourceColors, this.active);
      this.resize();
      this.onReady({ backend: this.backend, budget: this.hardwareBudget });
      return true;
    } catch (error) {
      this.backend = 'failed';
      console.error('GRID SOUL Babylon renderer:', error);
      this.onReady({ backend: 'failed', error });
      return false;
    }
  }

  ensureCapacity(required) {
    const safe = clamp(Math.ceil(Number(required) || 1), 1, MAX_POPULATION);
    if (safe <= this.capacity) return;
    const next = Math.min(MAX_POPULATION, Math.max(safe, this.capacity ? Math.ceil(this.capacity * 1.5) : 2_000));
    const matrices = new Float32Array(next * 16);
    const colors = new Float32Array(next * 4);
    matrices.set(this.matrixBuffer.subarray(0, Math.min(this.matrixBuffer.length, matrices.length)));
    colors.set(this.colorBuffer.subarray(0, Math.min(this.colorBuffer.length, colors.length)));
    for (let i = Math.floor(this.matrixBuffer.length / 16); i < next; i += 1) {
      const offset = i * 16;
      matrices[offset] = matrices[offset + 5] = matrices[offset + 10] = matrices[offset + 15] = 1;
      colors[offset / 4] = 0.2;
      colors[offset / 4 + 1] = 0.8;
      colors[offset / 4 + 2] = 1;
      colors[offset / 4 + 3] = 1;
    }
    this.matrixBuffer = matrices;
    this.colorBuffer = colors;
    this.capacity = next;
    if (this.swarmMesh) {
      this.swarmMesh.thinInstanceSetBuffer('matrix', this.matrixBuffer, 16, false);
      this.swarmMesh.thinInstanceSetBuffer('color', this.colorBuffer, 4, false);
      this.swarmMesh.thinInstanceCount = this.renderCount;
    }
  }

  getRenderPlan(population = this.active) {
    const cap = Math.max(1, Math.min(MAX_POPULATION, this.adaptiveBudget || this.hardwareBudget || MAX_POPULATION));
    return createBabylonInstanceSamplePlan(population, cap);
  }

  setPopulation(population) {
    this.active = clamp(Math.floor(Number(population) || 0), 0, MAX_POPULATION);
    this.ensureCapacity(Math.max(1, this.active));
    this.renderCount = this.getRenderPlan(this.active).count;
    if (this.swarmMesh) this.swarmMesh.thinInstanceCount = this.renderCount;
  }

  setColors(sourceColors, population = this.active) {
    if (!sourceColors || !this.capacity) return;
    this.sourceColors = sourceColors;
    const startedAt = performance.now();
    const plan = this.getRenderPlan(population);
    this.ensureCapacity(Math.max(1, plan.count));
    for (let slot = 0; slot < plan.count; slot += 1) {
      const source = plan.sourceIndex(slot) * 3;
      const target = slot * 4;
      this.colorBuffer[target] = sourceColors[source] ?? 0;
      this.colorBuffer[target + 1] = sourceColors[source + 1] ?? 0;
      this.colorBuffer[target + 2] = sourceColors[source + 2] ?? 0;
      this.colorBuffer[target + 3] = 1;
    }
    if (this.swarmMesh) this.swarmMesh.thinInstanceBufferUpdated('color');
    this.lastColorMs = performance.now() - startedAt;
  }

  beginFrame(population = this.active) {
    this.setPopulation(population);
    this.matrixDirty = false;
    return this.getRenderPlan(this.active);
  }

  writeTransform(slot, x, y, z, sx, sy, sz) {
    const offset = slot * 16;
    const buffer = this.matrixBuffer;
    buffer[offset] = sx; buffer[offset + 1] = 0; buffer[offset + 2] = 0; buffer[offset + 3] = 0;
    buffer[offset + 4] = 0; buffer[offset + 5] = sy; buffer[offset + 6] = 0; buffer[offset + 7] = 0;
    buffer[offset + 8] = 0; buffer[offset + 9] = 0; buffer[offset + 10] = sz; buffer[offset + 11] = 0;
    buffer[offset + 12] = x; buffer[offset + 13] = y; buffer[offset + 14] = z; buffer[offset + 15] = 1;
    this.matrixDirty = true;
  }

  endFrame(population = this.active, simulationMs = 0, buildMs = this.lastBuildMs) {
    const startedAt = performance.now();
    if (!this.engine || !this.scene || this.disposed || this.contextLost) return;
    if (!this.frameWindowStart) this.frameWindowStart = startedAt;
    this.frameWindowFrames += 1;
    const elapsedWindow = startedAt - this.frameWindowStart;
    if (elapsedWindow >= 1_000) {
      this.lastFps = this.frameWindowFrames * 1_000 / elapsedWindow;
      this.frameWindowStart = startedAt;
      this.frameWindowFrames = 0;
    }
    this.active = clamp(Math.floor(Number(population) || 0), 0, MAX_POPULATION);
    const plan = this.getRenderPlan(this.active);
    this.renderCount = plan.count;
    if (this.swarmMesh) {
      this.swarmMesh.isVisible = true;
      this.swarmMesh.thinInstanceCount = this.renderCount;
      if (this.matrixDirty) this.swarmMesh.thinInstanceBufferUpdated('matrix');
    }
    this.scene.render();
    const renderMs = performance.now() - startedAt;
    this.updatePerformanceBudget(performance.now());
    this.updateMetrics(simulationMs, buildMs, renderMs);
  }

  updatePerformanceBudget(now) {
    if (now - this.lastFpsCheckAt < 2_000) return;
    this.lastFpsCheckAt = now;
    const previousBudget = this.adaptiveBudget;
    const fps = this.lastFps;
    if (fps > 0 && fps < 25 && this.adaptiveBudget > 50_000) {
      const minimumVisible = Math.min(50_000, Math.max(1, this.active));
      const performanceTarget = Math.max(minimumVisible, Math.floor((this.active * 0.75) / 10_000) * 10_000);
      const reducedBudget = Math.floor((this.adaptiveBudget * 0.75) / 10_000) * 10_000;
      this.adaptiveBudget = Math.max(minimumVisible, Math.min(reducedBudget, performanceTarget));
      this.stableFastSince = 0;
    } else if (fps >= 48) {
      if (!this.stableFastSince) this.stableFastSince = now;
      if (now - this.stableFastSince >= 8_000 && this.adaptiveBudget < this.hardwareBudget) {
        this.adaptiveBudget = Math.min(this.hardwareBudget, Math.ceil((this.adaptiveBudget * 1.15) / 10_000) * 10_000);
        this.stableFastSince = now;
      }
    } else {
      this.stableFastSince = 0;
    }
    if (this.adaptiveBudget !== previousBudget) {
      this.renderCount = this.getRenderPlan(this.active).count;
      if (this.swarmMesh) this.swarmMesh.thinInstanceCount = this.renderCount;
      if (this.sourceColors) this.setColors(this.sourceColors, this.active);
    }
  }

  updateMetrics(simulationMs, buildMs, renderMs) {
    if (!this.metricsElement) return;
    const now = performance.now();
    if (now - this.lastMetricsAt < 750) return;
    this.lastMetricsAt = now;
    const fps = this.lastFps;
    const cpuBuffersMiB = (this.matrixBuffer.byteLength + this.colorBuffer.byteLength) / (1024 * 1024);
    const selected = this.active > this.renderCount;
    const backend = this.backend === 'WebGPU' ? 'WebGPU' : 'WebGL';
    this.metricsElement.textContent = `${backend} · Babylon.js · ${fps ? `${fps.toFixed(0)} FPS` : 'medindo FPS'} · ${this.renderCount.toLocaleString('pt-BR')}/${this.active.toLocaleString('pt-BR')} cubos · build ${buildMs.toFixed(1)} ms · sim ${simulationMs.toFixed(1)} ms · submissão CPU ${renderMs.toFixed(1)} ms · buffer CPU ${cpuBuffersMiB.toFixed(1)} MiB${selected ? ' · amostra adaptativa' : ''}`;
    this.metricsElement.title = `Babylon scene · população lógica ${this.active.toLocaleString('pt-BR')} · malha de cubos: 1 draw mesh · orçamento automático ${this.adaptiveBudget.toLocaleString('pt-BR')} · buffers CPU aproximados ${cpuBuffersMiB.toFixed(1)} MiB (não inclui a cópia GPU, alocações do navegador ou materiais) · última geração de alvos ${Number(buildMs || 0).toFixed(1)} ms · cores ${this.lastColorMs.toFixed(1)} ms`;
  }

  resize() {
    this.engine?.resize();
    if (!this.userCameraAdjusted) this.applyFitBounds();
  }

  setFitBounds(minimum, maximum, padding = 0.0275) {
    if (![minimum?.x, minimum?.y, minimum?.z, maximum?.x, maximum?.y, maximum?.z].every(Number.isFinite)) return;
    this.fitBounds = { minimum: { ...minimum }, maximum: { ...maximum }, padding: Math.max(0, Number(padding) || 0) };
    if (!this.userCameraAdjusted) this.applyFitBounds();
  }

  fitView(force = true) {
    if (force) this.userCameraAdjusted = false;
    return this.applyFitBounds();
  }

  applyFitBounds() {
    if (!this.fitBounds || !this.camera || !this.engine || this.userCameraAdjusted) return false;
    const { minimum: min, maximum: max } = this.fitBounds;
    const center = new Vector3((min.x + max.x) * 0.5, (min.y + max.y) * 0.5, (min.z + max.z) * 0.5);
    const radius = Math.max((max.x - min.x) * 0.5, (max.y - min.y) * 0.5, (max.z - min.z) * 0.5, 0.12) + this.fitBounds.padding;
    const width = Math.max(1, this.engine.getRenderWidth?.() || this.canvas.clientWidth || 1);
    const height = Math.max(1, this.engine.getRenderHeight?.() || this.canvas.clientHeight || 1);
    const aspect = width / height;
    const verticalFov = clamp(this.camera.fov || Math.PI / 3, 0.1, Math.PI - 0.1);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
    const limitingFov = Math.min(verticalFov, horizontalFov);
    const distance = radius / Math.tan(limitingFov * 0.36) * 1.12;
    this.camera.setTarget(center);
    this.camera.lowerRadiusLimit = 0.5;
    this.camera.upperRadiusLimit = 20_000_000;
    this.camera.radius = clamp(distance, this.camera.lowerRadiusLimit, this.camera.upperRadiusLimit);
    this.cameraState = {
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: center.x, y: center.y, z: center.z }
    };
    return true;
  }

  setCamera(position, target) {
    this.cameraState = { position: { ...position }, target: { ...target } };
    if (!this.camera) return;
    this.camera.setPosition(new Vector3(Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0));
    this.camera.setTarget(new Vector3(Number(target.x) || 0, Number(target.y) || 0, Number(target.z) || 0));
  }

  setTarget(target) {
    this.cameraState.target = { ...target };
    if (!this.camera) return;
    this.camera.setTarget(new Vector3(Number(target.x) || 0, Number(target.y) || 0, Number(target.z) || 0));
  }

  getCameraDistance() {
    return Math.max(1, Number(this.camera?.radius) || 19);
  }

  setAppearance({ background, fog = true, unlit = false, albedo = '#FFFFFF', metallic = 0.25, roughness = 0.25, emissive = '#073d58', emissiveIntensity = 1.5, ambient = 1.3, keyLight = 2.2, rimLight = 1.4 } = {}) {
    this.appearanceState = { background, fog, unlit, albedo, metallic, roughness, emissive, emissiveIntensity, ambient, keyLight, rimLight };
    if (!this.scene || !this.swarmMaterial) return;
    if (background) {
      const color = hexColor(background);
      this.scene.clearColor = new Color4(color.r, color.g, color.b, 1);
      this.scene.fogColor = color;
    }
    this.scene.fogMode = fog ? Scene.FOGMODE_EXP2 : Scene.FOGMODE_NONE;
    this.swarmMaterial.unlit = Boolean(unlit);
    this.swarmMaterial.albedoColor = hexColor(albedo);
    this.swarmMaterial.metallic = clamp(Number(metallic) || 0, 0, 1);
    this.swarmMaterial.roughness = clamp(Number(roughness) || 0, 0, 1);
    const glow = hexColor(emissive);
    this.swarmMaterial.emissiveColor = glow.scale(clamp(Number(emissiveIntensity) || 0, 0, 4) * 0.08);
    const hemi = this.scene.getLightByName('grid-soul-hemi');
    const key = this.scene.getLightByName('grid-soul-key');
    const rim = this.scene.getLightByName('grid-soul-rim');
    if (hemi) hemi.intensity = clamp(Number(ambient) || 0, 0, 5);
    if (key) key.intensity = clamp(Number(keyLight) || 0, 0, 8);
    if (rim) rim.intensity = clamp(Number(rimLight) || 0, 0, 8);
  }

  setFaceAtlasMode(enabled) {
    this.faceAtlasMode = Boolean(enabled);
    if (!this.swarmMaterial) return;
    this.swarmMaterial.unlit = this.faceAtlasMode;
    this.swarmMaterial.metallic = enabled ? 0 : 0.25;
    this.swarmMaterial.roughness = enabled ? 1 : 0.25;
  }

  ensurePeriodicRoot() {
    if (this.periodicRoot) return;
    this.periodicRoot = new TransformNode('grid-soul-periodic-table-root', this.scene);
  }

  buildPeriodicLabels(elements, colorForAtomicNumber, positionForElement) {
    if (!this.scene) return;
    this.ensurePeriodicRoot();
    if (this.periodicMeshes.length) {
      for (const mesh of this.periodicMeshes) mesh.setEnabled(true);
      return;
    }
    for (const element of elements) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      const accent = colorForAtomicNumber(element.z);
      ctx.fillStyle = '#061522'; ctx.fillRect(8, 8, 240, 144);
      ctx.strokeStyle = accent; ctx.lineWidth = 7; ctx.strokeRect(8, 8, 240, 144);
      ctx.fillStyle = accent; ctx.font = '24px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(String(element.z), 20, 36);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 64px sans-serif'; ctx.fillText(element.s, 128, 100);
      ctx.fillStyle = '#8eefff'; ctx.font = '18px sans-serif'; ctx.fillText(element.n, 128, 132);
      const texture = new DynamicTexture(`grid-soul-element-label-${element.z}`, canvas, this.scene, true);
      texture.hasAlpha = true;
      const material = new StandardMaterial(`grid-soul-element-material-${element.z}`, this.scene);
      material.diffuseTexture = texture;
      material.emissiveColor = Color3.White();
      material.useAlphaFromDiffuseTexture = true;
      material.backFaceCulling = false;
      material.disableLighting = true;
      const mesh = CreatePlane(`grid-soul-element-${element.z}`, { width: 0.64, height: 0.40 }, this.scene);
      mesh.parent = this.periodicRoot;
      const position = positionForElement(element);
      mesh.position.set(position.x, position.y, 0.12);
      mesh.billboardMode = 7;
      mesh.material = material;
      mesh.isPickable = true;
      mesh.metadata = { element };
      this.periodicMeshes.push(mesh);
    }
  }

  setPeriodicVisible(visible) {
    this.periodicRoot?.setEnabled(Boolean(visible));
  }

  pickPeriodicElement(clientX, clientY) {
    if (!this.scene || !this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const x = (clientX - rect.left) * this.engine.getRenderWidth() / rect.width;
    const y = (clientY - rect.top) * this.engine.getRenderHeight() / rect.height;
    const pick = this.scene.pick(x, y, mesh => Boolean(mesh.metadata?.element));
    return pick?.hit ? pick.pickedMesh?.metadata?.element || null : null;
  }

  clearAtom() {
    if (this.atomRoot) {
      this.atomRoot.dispose(false, true);
      this.atomRoot = null;
    }
    this.electronEntries = [];
  }

  buildAtom(element, electronShells) {
    if (!this.scene) return;
    this.clearAtom();
    this.atomRoot = new TransformNode('grid-soul-atomic-rest-v2', this.scene);
    this.atomRoot.setEnabled(false);
    const accents = { Au: '#ffd54a', Cu: '#b87333', Ag: '#cbd5e1', Fe: '#ff7043', C: '#37f5ff' };
    const accent = hexColor(accents[element.s] || '#26eaff');

    const cube = CreateBox('grid-soul-atom-wireframe', { size: 0.9 }, this.scene);
    cube.parent = this.atomRoot;
    const cubeMat = new StandardMaterial('grid-soul-atom-wireframe-material', this.scene);
    cubeMat.emissiveColor = accent;
    cubeMat.wireframe = true;
    cubeMat.alpha = 0.8;
    cubeMat.disableLighting = true;
    cube.material = cubeMat;
    cube.isPickable = false;

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 160;
    const labelCtx = labelCanvas.getContext('2d');
    labelCtx.textAlign = 'center'; labelCtx.textBaseline = 'middle'; labelCtx.shadowColor = '#22eaff'; labelCtx.shadowBlur = 22;
    labelCtx.fillStyle = '#c7ffff'; labelCtx.font = 'bold 76px sans-serif'; labelCtx.fillText(element.s, 128, 62);
    labelCtx.shadowBlur = 0; labelCtx.fillStyle = '#65dfff'; labelCtx.font = 'bold 26px sans-serif'; labelCtx.fillText(`Z = ${element.z}`, 128, 125);
    const labelTexture = new DynamicTexture('grid-soul-atom-label-texture', labelCanvas, this.scene, true);
    labelTexture.hasAlpha = true;
    const labelMat = new StandardMaterial('grid-soul-atom-label-material', this.scene);
    labelMat.diffuseTexture = labelTexture; labelMat.emissiveColor = Color3.White(); labelMat.useAlphaFromDiffuseTexture = true; labelMat.disableLighting = true;
    const label = CreatePlane('grid-soul-atom-label', { width: 1.15, height: 0.72 }, this.scene);
    label.parent = this.atomRoot; label.position.z = 0.53; label.billboardMode = 7; label.material = labelMat; label.isPickable = false;

    const neutronCount = Math.max(0, (Number(element.a) || Number(element.z)) - element.z);
    const nucleonCount = element.z + neutronCount;
    const protonPositions = [];
    const neutronPositions = [];
    for (let i = 0; i < nucleonCount; i += 1) {
      const angle = i * 2.399963229728653;
      const radius = Math.sqrt(i + 1) * 0.022;
      const xyz = [Math.cos(angle) * radius, Math.sin(angle) * radius, ((i % 3) - 1) * 0.025];
      (i < element.z ? protonPositions : neutronPositions).push(xyz);
    }
    this.createNucleonBatch('grid-soul-protons', protonPositions, '#ff7855');
    this.createNucleonBatch('grid-soul-neutrons', neutronPositions, '#e3f6ff');

    electronShells.forEach((count, shellIndex) => {
      const radius = 1.05 + shellIndex * 0.48;
      const tilt = 0.38 + shellIndex * 0.47;
      const orbit = CreateTorus(`grid-soul-electron-orbit-${shellIndex}`, { diameter: radius * 2, thickness: 0.012, tessellation: 96 }, this.scene);
      orbit.parent = this.atomRoot;
      orbit.scaling.y = 0.72;
      orbit.rotation.set(tilt, tilt * 0.37, tilt * 0.61);
      const orbitMat = new StandardMaterial(`grid-soul-electron-orbit-material-${shellIndex}`, this.scene);
      orbitMat.emissiveColor = accent; orbitMat.alpha = 0.55; orbitMat.disableLighting = true; orbit.material = orbitMat; orbit.isPickable = false;
      for (let e = 0; e < count; e += 1) {
        this.electronEntries.push({ radius, tilt, angle: Math.PI * 2 * e / count + shellIndex * 0.29, speed: (shellIndex % 2 ? -1 : 1) * (0.7 + shellIndex * 0.12) });
      }
    });
    this.createElectronBatch(this.electronEntries.length);
    return { neutronCount, electronCount: this.electronEntries.length };
  }

  createNucleonBatch(name, positions, color) {
    if (!positions.length) return;
    const mesh = CreateSphere(`${name}-source`, { diameter: 0.11, segments: 8 }, this.scene);
    mesh.parent = this.atomRoot;
    const material = new StandardMaterial(`${name}-material`, this.scene);
    material.emissiveColor = hexColor(color); material.disableLighting = true; mesh.material = material; mesh.isPickable = false;
    const matrices = new Float32Array(positions.length * 16);
    positions.forEach(([x, y, z], index) => {
      const offset = index * 16;
      matrices[offset] = matrices[offset + 5] = matrices[offset + 10] = matrices[offset + 15] = 1;
      matrices[offset + 12] = x; matrices[offset + 13] = y; matrices[offset + 14] = z;
    });
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
    mesh.thinInstanceCount = positions.length;
  }

  createElectronBatch(count) {
    if (!count) return;
    this.electronMesh = CreateSphere('grid-soul-electron-source', { diameter: 0.13, segments: 10 }, this.scene);
    this.electronMesh.parent = this.atomRoot;
    const material = new StandardMaterial('grid-soul-electron-material', this.scene);
    material.emissiveColor = hexColor('#37f5ff'); material.disableLighting = true; this.electronMesh.material = material; this.electronMesh.isPickable = false;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i += 1) matrices[i * 16] = matrices[i * 16 + 5] = matrices[i * 16 + 10] = matrices[i * 16 + 15] = 1;
    this.electronMatrixBuffer = matrices;
    this.electronMesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
    this.electronMesh.thinInstanceCount = count;
  }

  updateElectrons(positions) {
    if (!this.electronMesh || !positions) return;
    const count = Math.min(this.electronEntries.length, Math.floor(positions.length / 3));
    for (let i = 0; i < count; i += 1) {
      const matrixOffset = i * 16;
      this.electronMatrixBuffer[matrixOffset + 12] = positions[i * 3];
      this.electronMatrixBuffer[matrixOffset + 13] = positions[i * 3 + 1];
      this.electronMatrixBuffer[matrixOffset + 14] = positions[i * 3 + 2];
    }
    this.electronMesh.thinInstanceBufferUpdated('matrix');
  }

  setAtomVisible(visible) {
    this.atomRoot?.setEnabled(Boolean(visible));
  }

  setAtomPosition(x, y, z = 0.35, scale = 0.65) {
    if (!this.atomRoot) return;
    this.atomRoot.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    this.atomRoot.scaling.setAll(scale);
  }

  rotateAtom(delta) {
    if (!this.atomRoot) return;
    this.atomRoot.rotation.y += Number(delta) || 0;
  }

  setBuildTime(milliseconds) {
    this.lastBuildMs = Number(milliseconds) || 0;
  }

  dispose() {
    this.disposed = true;
    this.camera?.detachControl();
    this.scene?.dispose();
    this.engine?.dispose();
  }
}
