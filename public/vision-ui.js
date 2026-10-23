import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildVoxelMeshFiles } from './vision-mesh-export.js';

const $ = selector => document.querySelector(selector);
const panel = $('#visionPanel');
const toggle = $('#visionToggle');
const canvas = $('#visionCanvas');
const viewport = $('.vision-viewport');
const original = $('#visionOriginal');
const autoLayer = $('#visionAutoLayer');
const annotationCanvas = $('#visionAnnotations');
const annotationContext = annotationCanvas.getContext('2d', { willReadFrequently: true });
const status = $('#visionStatus');
const populationInput = $('#visionPopulation');
const qualitySelect = $('#visionQuality');

const QUALITY_COUNTS = { draft: 6000, balanced: 24000, high: 60000, detailed: 100000 };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_PIXELS = 40_000_000;
let imageDataUrl = null;
let imageName = '';
let analysis = null;
let projectId = null;
let projectCreatedAt = null;
let scene, camera, renderer, controls, mesh, resizeObserver;
let drawingEnabled = false;
let drawing = null;
let history = [];
let historyIndex = -1;
let compareImageData = null;

function setStatus(message, state = '') {
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function showPanel() {
  $('#automationPanel').hidden = true;
  $('#automationToggle').setAttribute('aria-expanded', 'false');
  $('#forgePanel').hidden = true;
  $('#forgeToggle').setAttribute('aria-expanded', 'false');
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  initializeViewer();
  requestAnimationFrame(resizeViewer);
  loadProjectList();
}

function hidePanel() {
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

toggle.addEventListener('click', () => panel.hidden ? showPanel() : hidePanel());
$('#visionClose').addEventListener('click', hidePanel);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden) hidePanel();
});

function initializeViewer() {
  if (renderer) return;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#020711', 1);
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#020711');
    camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20_000_000);
    camera.position.set(0, 0, 500);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.05;
    controls.maxDistance = 10_000_000;
    resizeObserver = new ResizeObserver(resizeViewer);
    resizeObserver.observe(viewport);
    renderer.setAnimationLoop(() => {
      if (panel.hidden || !scene) return;
      controls.update();
      renderer.render(scene, camera);
    });
  } catch (error) {
    setStatus(`Prévia WebGL indisponível: ${String(error.message || error).slice(0, 200)}`, 'error');
  }
}

function resizeViewer() {
  if (!renderer || !camera) return;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return;
  renderer.setSize(bounds.width, bounds.height, false);
  camera.aspect = bounds.width / bounds.height;
  camera.updateProjectionMatrix();
}

function fitCamera(width, height, depth = 1) {
  const margin = 1.18;
  const verticalDistance = (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const horizontalDistance = (width * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.max(camera.aspect, 0.1);
  const distance = Math.max(verticalDistance, horizontalDistance) * margin + depth;
  camera.position.set(0, 0, distance);
  camera.near = Math.max(0.001, distance / 100_000);
  camera.far = Math.max(100, distance * 20);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.minDistance = Math.max(0.001, distance / 1000);
  controls.maxDistance = Math.max(100, distance * 8);
  controls.update();
}

function clearMesh() {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  mesh = null;
}

function currentGap() {
  return Number($('#visionGap').value) / 100;
}

function renderSwarm(result) {
  if (!renderer || !scene || !result?.swarm?.samples?.length) throw new Error('Execute a análise primeiro para gerar as amostras do enxame.');
  clearMesh();
  const swarm = result.swarm;
  const samples = swarm.samples;
  const width = swarm.physicalWidthMm;
  const height = swarm.physicalHeightMm;
  const cellX = width / swarm.columns;
  const cellY = height / swarm.rows;
  const gap = currentGap();
  const depth = Math.max(0.02, Number($('#visionDepth').value) || 1.6);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  mesh = new THREE.InstancedMesh(geometry, material, samples.length);
  mesh.count = samples.length;
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    position.set(sample[0] * width, sample[1] * height, 0);
    scale.set(Math.max(0.001, cellX * (1 - gap)), Math.max(0.001, cellY * (1 - gap)), depth);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    color.setRGB(sample[2] / 255, sample[3] / 255, sample[4] / 255, THREE.SRGBColorSpace);
    mesh.setColorAt(index, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
  fitCamera(width, height, depth);
  $('#visionExportPng').disabled = false;
  $('#visionExportPalette').disabled = false;
  $('#visionExportCoords').disabled = false;
  $('#visionExportStl').disabled = false;
  $('#visionExportObj').disabled = false;
  $('#visionSave').disabled = false;
  $('#visionDownloadProject').disabled = false;
  $('#visionCompareOriginal').src = imageDataUrl;
  setStatus(`Reconstrução concluída · ${samples.length.toLocaleString('pt-BR')} microcubos em grade regular ${swarm.columns} × ${swarm.rows}. Dimensão declarada: ${swarm.physicalWidthMm.toLocaleString('pt-BR')} × ${swarm.physicalHeightMm.toLocaleString('pt-BR')} mm; a altura visual do painel não valida uma peça física.\n${swarm.warnings.join('\n')}`, 'ok');
}

function setImageLayers() {
  const showOriginal = $('#visionShowOriginal').checked;
  original.hidden = !showOriginal;
  const showAnnotations = $('#visionShowAnnotations').checked;
  annotationCanvas.hidden = !showAnnotations;
  const showAuto = $('#visionShowAuto').checked || $('#visionShowSegmentation').checked;
  autoLayer.hidden = !showAuto || !analysis;
  if (analysis && showAuto) {
    autoLayer.src = $('#visionShowSegmentation').checked ? analysis.segmentationPng : analysis.edgesPng;
    autoLayer.style.opacity = $('#visionShowSegmentation').checked ? '0.72' : '0.95';
    autoLayer.style.mixBlendMode = $('#visionShowSegmentation').checked ? 'normal' : 'screen';
  }
}

for (const selector of ['#visionShowOriginal', '#visionShowAuto', '#visionShowSegmentation', '#visionShowAnnotations']) {
  $(selector).addEventListener('change', setImageLayers);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function waitImage(src) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe);
    probe.onerror = () => reject(new Error('O navegador não conseguiu decodificar esta imagem.'));
    probe.src = src;
  });
}

function resetAnnotationHistory() {
  history = [annotationCanvas.toDataURL('image/png')];
  historyIndex = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#visionUndo').disabled = historyIndex <= 0;
  $('#visionRedo').disabled = historyIndex >= history.length - 1;
}

function recordAnnotationChange() {
  const next = annotationCanvas.toDataURL('image/png');
  if (next === history[historyIndex]) return;
  history = history.slice(0, historyIndex + 1);
  history.push(next);
  if (history.length > 12) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

async function restoreAnnotation(dataUrl) {
  const image = await waitImage(dataUrl);
  annotationContext.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  annotationContext.drawImage(image, 0, 0, annotationCanvas.width, annotationCanvas.height);
}

$('#visionUndo').addEventListener('click', async () => {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  await restoreAnnotation(history[historyIndex]);
  updateHistoryButtons();
});
$('#visionRedo').addEventListener('click', async () => {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  await restoreAnnotation(history[historyIndex]);
  updateHistoryButtons();
});
$('#visionClearMarks').addEventListener('click', () => {
  if (!annotationCanvas.width) return;
  annotationContext.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  recordAnnotationChange();
});
$('#visionDrawToggle').addEventListener('click', event => {
  drawingEnabled = !drawingEnabled;
  annotationCanvas.dataset.drawing = String(drawingEnabled && $('#visionTool').value !== 'pan');
  event.currentTarget.textContent = drawingEnabled ? 'Desativar desenho' : 'Ativar desenho';
  annotationCanvas.style.cursor = drawingEnabled ? 'crosshair' : 'default';
});
$('#visionTool').addEventListener('change', () => {
  annotationCanvas.dataset.drawing = String(drawingEnabled && $('#visionTool').value !== 'pan');
});

function pointerPosition(event) {
  const bounds = annotationCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(annotationCanvas.width, (event.clientX - bounds.left) * annotationCanvas.width / bounds.width)),
    y: Math.max(0, Math.min(annotationCanvas.height, (event.clientY - bounds.top) * annotationCanvas.height / bounds.height)),
  };
}

function drawStyle(ctx) {
  const mode = $('#visionMarkMode').value;
  if (mode === 'ignore') {
    ctx.strokeStyle = 'rgba(0,0,0,0.96)';
    ctx.fillStyle = 'rgba(0,0,0,0.96)';
  } else {
    const hex = $('#visionMarkColor').value;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.86)`;
    ctx.fillStyle = `rgba(${r},${g},${b},0.42)`;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, Number($('#visionBrushSize').value) * annotationCanvas.width / Math.max(1, annotationCanvas.clientWidth));
}

function drawShape(ctx, tool, start, end, filled = false) {
  drawStyle(ctx);
  ctx.beginPath();
  if (tool === 'rect') {
    ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
    if (filled) ctx.fill(); else ctx.stroke();
  } else if (tool === 'circle') {
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
    if (filled) ctx.fill(); else ctx.stroke();
  } else if (tool === 'point') {
    ctx.arc(end.x, end.y, ctx.lineWidth * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

annotationCanvas.addEventListener('pointerdown', event => {
  if (!drawingEnabled || $('#visionTool').value === 'pan' || !imageDataUrl) return;
  event.preventDefault();
  annotationCanvas.setPointerCapture(event.pointerId);
  const point = pointerPosition(event);
  const image = annotationContext.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
  drawing = { pointerId: event.pointerId, start: point, previous: point, before: image, tool: $('#visionTool').value };
  if (drawing.tool === 'brush' || drawing.tool === 'line') {
    drawStyle(annotationContext);
    annotationContext.beginPath();
    annotationContext.moveTo(point.x, point.y);
  } else if (drawing.tool === 'point') {
    drawShape(annotationContext, 'point', point, point, true);
  }
});

annotationCanvas.addEventListener('pointermove', event => {
  if (!drawing || drawing.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = pointerPosition(event);
  if (drawing.tool === 'brush' || drawing.tool === 'line') {
    drawStyle(annotationContext);
    annotationContext.lineTo(point.x, point.y);
    annotationContext.stroke();
  } else if (drawing.tool === 'rect' || drawing.tool === 'circle') {
    annotationContext.putImageData(drawing.before, 0, 0);
    drawShape(annotationContext, drawing.tool, drawing.start, point);
  }
  drawing.previous = point;
});

function finishDrawing(event) {
  if (!drawing || (event && drawing.pointerId !== event.pointerId)) return;
  const final = event ? pointerPosition(event) : drawing.previous;
  if (drawing.tool === 'rect' || drawing.tool === 'circle') drawShape(annotationContext, drawing.tool, drawing.start, final);
  recordAnnotationChange();
  drawing = null;
}
annotationCanvas.addEventListener('pointerup', finishDrawing);
annotationCanvas.addEventListener('pointercancel', finishDrawing);

async function acceptImage(file, dataUrl = null) {
  if (!file && !dataUrl) throw new Error('Escolha uma imagem primeiro.');
  if (file) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('O arquivo excede o limite de 8 MiB.');
    const extensionMime = /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : '';
    const mime = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : extensionMime;
    if (!mime) throw new Error('Formato não permitido; use PNG, JPG ou WEBP.');
    projectId = null;
    projectCreatedAt = null;
    imageName = file.name.slice(0, 120);
    imageDataUrl = await readFileAsDataUrl(new Blob([file], { type: mime }));
  } else {
    imageDataUrl = dataUrl;
    imageName = imageName || 'imagem-salva';
  }
  const img = await waitImage(imageDataUrl);
  if (img.naturalWidth * img.naturalHeight > MAX_UPLOAD_PIXELS) throw new Error('A imagem excede 40 megapixels.');
  original.src = imageDataUrl;
  $('#visionCompareOriginal').src = imageDataUrl;
  $('#visionImageFrame').hidden = false;
  const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight), Math.sqrt(4_194_304 / (img.naturalWidth * img.naturalHeight)));
  annotationCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  annotationCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  annotationContext.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  resetAnnotationHistory();
  analysis = null;
  compareImageData = null;
  clearMesh();
  $('#visionCompareResult').removeAttribute('src');
  $('#visionAutoLayer').hidden = true;
  $('#visionMetrics').replaceChildren();
  $('#visionPalette').replaceChildren();
  $('#visionExportPng').disabled = true;
  $('#visionExportPalette').disabled = true;
  $('#visionExportCoords').disabled = true;
  $('#visionExportStl').disabled = true;
  $('#visionExportObj').disabled = true;
  $('#visionDownloadProject').disabled = false;
  $('#visionSave').disabled = false;
  setImageLayers();
  setStatus(`Imagem carregada localmente · ${img.naturalWidth} × ${img.naturalHeight} px · ${imageName}. Nenhum conteúdo foi enviado à IA.`, 'ok');
}

$('#visionFile').addEventListener('change', async event => {
  try { await acceptImage(event.target.files?.[0]); }
  catch (error) { setStatus(error.message || 'Falha ao abrir a imagem.', 'error'); }
  finally { event.target.value = ''; }
});
const dropArea = $('#visionDrop');
for (const name of ['dragenter', 'dragover']) dropArea.addEventListener(name, event => { event.preventDefault(); dropArea.classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) dropArea.addEventListener(name, event => { event.preventDefault(); dropArea.classList.remove('dragover'); });
dropArea.addEventListener('drop', async event => {
  try { await acceptImage(event.dataTransfer.files?.[0]); }
  catch (error) { setStatus(error.message || 'Falha ao abrir a imagem.', 'error'); }
});

qualitySelect.addEventListener('change', () => {
  if (QUALITY_COUNTS[qualitySelect.value]) populationInput.value = String(QUALITY_COUNTS[qualitySelect.value]);
});
populationInput.addEventListener('input', () => {
  const value = Math.max(1000, Math.min(100000, Math.round(Number(populationInput.value) / 1000) * 1000));
  populationInput.value = String(value);
  if (!Object.values(QUALITY_COUNTS).includes(value)) qualitySelect.value = 'custom';
});
$('#visionEdgeWeight').addEventListener('input', event => { $('#visionEdgeWeightValue').textContent = Number(event.target.value).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); });
$('#visionGap').addEventListener('input', () => { if (analysis) renderSwarm(analysis); });
$('#visionDepth').addEventListener('change', () => { if (analysis) renderSwarm(analysis); });

function settings() {
  const population = Number(populationInput.value);
  const width = Number($('#visionWidth').value);
  if (!Number.isInteger(population) || population < 1000 || population > 100000) throw new Error('A população deve ser um inteiro entre 1.000 e 100.000 nesta interface.');
  if (!Number.isFinite(width) || width < 10 || width > 1_000_000) throw new Error('A largura de referência deve estar entre 10 e 1.000.000 mm.');
  const rotation = Number($('#visionRotation')?.value || 0);
  return {
    population,
    colors: Number($('#visionColors').value),
    physicalWidthMm: width,
    edgeWeight: Number($('#visionEdgeWeight').value),
    seed: Number($('#visionSeed').value) || 20261022,
    rotation,
    gapPercent: Number($('#visionGap').value),
    depthMm: Number($('#visionDepth').value),
    quality: qualitySelect.value,
  };
}

function annotationData() {
  return annotationCanvas.width ? annotationCanvas.toDataURL('image/png') : null;
}

async function analyze() {
  if (!imageDataUrl) throw new Error('Envie uma imagem antes de analisar.');
  const current = settings();
  setStatus('Analisando cores, contornos, regiões e grade de amostragem localmente com Python/OpenCV…');
  $('#visionAnalyze').disabled = true;
  $('#visionReconstruct').disabled = true;
  const started = performance.now();
  try {
    const response = await fetch('/api/vision/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ image: imageDataUrl, annotations: annotationData(), ...current }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'A análise local falhou.');
    analysis = data;
    renderAnalysisSummary(data, performance.now() - started);
    setImageLayers();
    renderSwarm(data);
    $('#visionSave').disabled = false;
    $('#visionDownloadProject').disabled = false;
  } finally {
    $('#visionAnalyze').disabled = false;
    $('#visionReconstruct').disabled = false;
  }
}

function renderAnalysisSummary(data, elapsed) {
  const metrics = $('#visionMetrics');
  metrics.replaceChildren();
  const entries = [
    ['Dimensões fonte', `${data.image.originalWidth} × ${data.image.originalHeight} px`],
    ['Microcubos', data.swarm.count.toLocaleString('pt-BR')],
    ['Cores quantizadas', String(data.palette.length)],
    ['Regiões de cor', String(data.regionCount)],
    ['Contornos', String(data.contours.length)],
    ['Contraste', (data.features.contrastStdDev * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'],
    ['Saturação', (data.features.saturationMean * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'],
    ['Brilho médio', (data.features.brightnessMean * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'],
    ['Processamento', `${Math.round(elapsed)} ms`],
  ];
  for (const [label, value] of entries) {
    const tile = document.createElement('div');
    const strong = document.createElement('strong');
    const caption = document.createElement('span');
    strong.textContent = value;
    caption.textContent = label;
    tile.append(strong, caption);
    metrics.append(tile);
  }
  const paletteRoot = $('#visionPalette');
  paletteRoot.replaceChildren();
  for (const item of data.palette) {
    const swatch = document.createElement('span');
    swatch.className = 'vision-swatch';
    swatch.style.backgroundColor = item.hex;
    swatch.title = `${item.hex} · ${(item.fraction * 100).toFixed(1)}%`;
    paletteRoot.append(swatch);
  }
  const resized = data.image.resizedForProcessing ? `
Imagem reduzida localmente para ${data.image.width} × ${data.image.height} px antes do processamento.` : '';
  setStatus(`Análise real concluída · ${data.image.width} × ${data.image.height} px processados · Canny ${Math.round(data.features.edgePixelFraction * 100)}% de pixels de borda · ${data.contours.length} contornos listados · semente ${data.swarm.seed}.${resized}\nOs contornos são candidatos computacionais; revise-os visualmente. Métricas de imagem não certificam geometria física.`, 'ok');
}

$('#visionAnalyze').addEventListener('click', async () => {
  try { await analyze(); }
  catch (error) { setStatus(error.message || 'Erro na análise.', 'error'); }
});
$('#visionReconstruct').addEventListener('click', async () => {
  try {
    if (!analysis) await analyze();
    else renderSwarm(analysis);
  } catch (error) { setStatus(error.message || 'Erro na reconstrução.', 'error'); }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFilename(value) {
  return String(value || 'gridsoul-visao').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'gridsoul-visao';
}

$('#visionExportPng').addEventListener('click', () => {
  if (!renderer || !mesh) return;
  renderer.render(scene, camera);
  canvas.toBlob(blob => { if (blob) downloadBlob(blob, `${safeFilename(imageName)}-enxame.png`); }, 'image/png');
});
$('#visionExportPalette').addEventListener('click', () => {
  if (!analysis) return;
  downloadBlob(new Blob([JSON.stringify({ source: imageName, palette: analysis.palette, features: analysis.features }, null, 2)], { type: 'application/json' }), `${safeFilename(imageName)}-paleta.json`);
});
$('#visionExportCoords').addEventListener('click', () => {
  if (!analysis) return;
  const payload = { format: 'gridsoul-image-samples-v1', source: imageName, image: analysis.image, grid: { ...analysis.swarm, samples: undefined }, samples: analysis.swarm.samples, notes: analysis.notes };
  downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${safeFilename(imageName)}-coordenadas.json`);
});

function meshExportResult() {
  if (!analysis) throw new Error('Execute a análise da imagem antes de exportar a malha.');
  return buildVoxelMeshFiles(analysis, { gapPercent: Number($('#visionGap').value), depthMm: Number($('#visionDepth').value) });
}

$('#visionExportStl').addEventListener('click', () => {
  try {
    const result = meshExportResult();
    downloadBlob(new Blob([result.stl], { type: 'model/stl' }), `${safeFilename(imageName)}-relevo-voxel.stl`);
    setStatus(`STL binário exportado localmente · ${result.triangleCount.toLocaleString('pt-BR')} triângulos · ${result.cellCount.toLocaleString('pt-BR')} células · dimensões ${result.boundsMm.width} × ${result.boundsMm.height} × ${result.boundsMm.depth} mm. STL não armazena cores.\n${result.warnings.join('\n')}`, 'ok');
  } catch (error) { setStatus(error.message || 'Falha ao exportar STL.', 'error'); }
});

$('#visionExportObj').addEventListener('click', () => {
  try {
    const result = meshExportResult();
    const basename = `${safeFilename(imageName)}-microcubos`;
    const obj = result.obj.replace('mtllib gridsoul-image.mtl', `mtllib ${basename}.mtl`);
    downloadBlob(new Blob([result.mtl], { type: 'text/plain;charset=utf-8' }), `${basename}.mtl`);
    downloadBlob(new Blob([obj], { type: 'text/plain;charset=utf-8' }), `${basename}.obj`);
    setStatus(`Par de malha OBJ + MTL exportado · ${result.vertexCount.toLocaleString('pt-BR')} vértices · ${result.polygonCount.toLocaleString('pt-BR')} polígonos · ${result.materialCount} cores etiquetadas. Guarde OBJ e MTL juntos na mesma pasta.\n${result.warnings.join('\n')}`, 'ok');
  } catch (error) { setStatus(error.message || 'Falha ao exportar OBJ/MTL.', 'error'); }
});

$('#visionCompare').addEventListener('click', async () => {
  if (!imageDataUrl || !analysis?.rasterPng) { setStatus('Execute a análise antes de comparar a grade de cores.', 'error'); return; }
  try {
    compareImageData = analysis.rasterPng;
    $('#visionCompareResult').src = compareImageData;
    setStatus('Calculando MAE, PSNR e SSIM da grade de cores 2D quantizada local…');
    const response = await fetch('/api/vision/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl, reconstruction: compareImageData, rotation: settings().rotation }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Falha na comparação.');
    setStatus(`Comparação da grade RGB projetada em 2D · MAE ${(result.mae * 100).toFixed(2)}% · PSNR ${result.psnrDb.toFixed(2)} dB · SSIM ${result.ssim.toFixed(4)}. A métrica avalia a quantização/grade de cor (sem espaçamento ou câmera); não atesta fidelidade tridimensional, fabricabilidade ou resistência.`, 'ok');
  } catch (error) { setStatus(error.message || 'Erro na comparação.', 'error'); }
});

function projectState() {
  return {
    image: imageDataUrl,
    imageName,
    annotations: annotationData(),
    settings: settings(),
    analysis: null,
    revision: 2,
    updatedAt: new Date().toISOString(),
  };
}

function downloadProject() {
  if (!imageDataUrl) { setStatus('Envie uma imagem antes de exportar o projeto.', 'error'); return; }
  const project = { format: 'gridsoul-vision-project-v1', id: projectId, name: $('#visionProjectName').value || 'Reconstrução de imagem', createdAt: projectCreatedAt, state: projectState() };
  downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${safeFilename(project.name)}.gridsoul.json`);
}
$('#visionDownloadProject').addEventListener('click', downloadProject);

async function loadProjectList(selectId = '') {
  const select = $('#visionProjectList');
  try {
    const response = await fetch('/api/vision/projects');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível listar projetos.');
    select.replaceChildren(new Option(data.projects.length ? 'Selecione um projeto' : 'Nenhum projeto salvo', ''));
    for (const item of data.projects) {
      const option = new Option(`${item.name} · ${new Date(item.updatedAt).toLocaleString('pt-BR')}`, item.id);
      select.append(option);
    }
    if (selectId) select.value = selectId;
  } catch (error) {
    select.replaceChildren(new Option('Armazenamento local indisponível', ''));
    console.warn('GRID SOUL vision projects:', error.message);
  }
}

function applySavedSettings(saved = {}) {
  if (saved.population) populationInput.value = String(saved.population);
  if (saved.colors) $('#visionColors').value = String(saved.colors);
  if (saved.physicalWidthMm) $('#visionWidth').value = String(saved.physicalWidthMm);
  if (saved.edgeWeight !== undefined) $('#visionEdgeWeight').value = String(saved.edgeWeight);
  if (saved.gapPercent !== undefined) $('#visionGap').value = String(saved.gapPercent);
  if (saved.depthMm !== undefined) $('#visionDepth').value = String(saved.depthMm);
  if (saved.seed) $('#visionSeed').value = String(saved.seed);
  if (saved.rotation !== undefined) $('#visionRotation').value = String(saved.rotation);
  if (saved.quality) qualitySelect.value = saved.quality;
  $('#visionEdgeWeightValue').textContent = Number($('#visionEdgeWeight').value).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

async function restoreProjectState(project, savedLocally = false) {
  if (!project?.state || typeof project.state.image !== 'string') throw new Error('O projeto não contém imagem e configuração válidas.');
  projectId = savedLocally ? project.id : null;
  projectCreatedAt = savedLocally ? project.createdAt : null;
  $('#visionProjectName').value = String(project.name || 'Reconstrução importada').slice(0, 80);
  imageName = String(project.state.imageName || project.name || 'imagem-salva').slice(0, 120);
  await acceptImage(null, project.state.image);
  if (project.state.annotations) {
    await restoreAnnotation(project.state.annotations);
    history = [annotationCanvas.toDataURL('image/png')];
    historyIndex = 0;
    updateHistoryButtons();
  }
  applySavedSettings(project.state.settings || {});
  analysis = null;
  await analyze();
  $('#visionSave').disabled = false;
  $('#visionDownloadProject').disabled = false;
}

$('#visionSave').addEventListener('click', async () => {
  if (!imageDataUrl) { setStatus('Envie uma imagem para criar um projeto local.', 'error'); return; }
  const name = $('#visionProjectName').value.trim();
  if (!name) { setStatus('Informe um nome para o projeto.', 'error'); return; }
  const id = projectId || crypto.randomUUID();
  try {
    setStatus('Salvando projeto no armazenamento local deste servidor…');
    const response = await fetch(`/api/vision/projects/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, createdAt: projectCreatedAt || new Date().toISOString(), state: projectState() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o projeto.');
    projectId = result.project.id;
    projectCreatedAt = result.project.createdAt;
    await loadProjectList(projectId);
    setStatus(`Projeto “${result.project.name}” salvo localmente · atualização ${new Date(result.project.updatedAt).toLocaleString('pt-BR')}. Pode reabrir e continuar após reiniciar o GRID SOUL.`, 'ok');
  } catch (error) { setStatus(error.message || 'Falha ao salvar projeto.', 'error'); }
});

async function openSavedProject() {
  const id = $('#visionProjectList').value;
  if (!id) { setStatus('Selecione um projeto local salvo.', 'error'); return; }
  try {
    setStatus('Abrindo projeto local…');
    const response = await fetch(`/api/vision/projects/${id}`);
    const project = await response.json();
    if (!response.ok) throw new Error(project.error || 'Projeto não encontrado.');
    await restoreProjectState(project, true);
    await loadProjectList(project.id);
  } catch (error) { setStatus(error.message || 'Falha ao abrir projeto.', 'error'); }
}
$('#visionLoad').addEventListener('click', openSavedProject);

$('#visionImportProject').addEventListener('click', () => $('#visionProjectFile').click());
$('#visionProjectFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  try {
    if (!file) return;
    if (file.size > 22 * 1024 * 1024) throw new Error('O arquivo do projeto excede 22 MiB.');
    const imported = JSON.parse(await file.text());
    if (imported.format !== 'gridsoul-vision-project-v1') throw new Error('Este não é um projeto GRID SOUL Vision compatível.');
    await restoreProjectState(imported, false);
    await loadProjectList();
    setStatus(`Projeto “${$('#visionProjectName').value}” importado e reconstruído localmente. Use Salvar projeto local para criar um novo registro neste computador.`, 'ok');
  } catch (error) { setStatus(error.message || 'Não foi possível importar o projeto.', 'error'); }
  finally { event.target.value = ''; }
});
