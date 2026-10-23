import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  FORK_DEFAULTS,
  calculateForkMetrics,
  createForkMesh,
  exportForkStl,
  validateForkParameters,
  validateTriangleMesh
} from '/engineering/fork.js';

const panel = document.querySelector('#forgePanel');
const toggle = document.querySelector('#forgeToggle');
const automationPanel = document.querySelector('#automationPanel');
const automationToggle = document.querySelector('#automationToggle');
const canvas = document.querySelector('#forgeCanvas');
const viewport = document.querySelector('.forge-viewport');
const questionBox = document.querySelector('#forgeQuestions');
const validationBox = document.querySelector('#forgeValidation');
const materialSelect = document.querySelector('#forgeMaterial');
const materialFacts = document.querySelector('#forgeMaterialFacts');
const metricsRoot = document.querySelector('#forgeMetrics');
const exportStlButton = document.querySelector('#forgeExportStl');
const exportReportButton = document.querySelector('#forgeExportReport');
const parameterInputs = [...document.querySelectorAll('[data-fork-key]')];

let catalog = [];
let catalogVerifiedOn = null;
let selectedMaterial = null;
let currentMesh = null;
let builtParameters = null;
let geometryStale = true;
let cutEnabled = false;
let layerAnimation = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let gridHelper = null;
let resizeObserver = null;
let rendering = false;
let lastMetrics = null;
let lastAnalysis = null;

function setStatus(element, message, state = '') {
  element.textContent = message;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function readParameters() {
  const values = {};
  for (const input of parameterInputs) {
    values[input.dataset.forkKey] = input.value === '' ? '' : Number(input.value);
  }
  return validateForkParameters(values);
}

function writeParameters(parameters) {
  for (const input of parameterInputs) {
    if (Object.hasOwn(parameters, input.dataset.forkKey)) {
      input.value = String(parameters[input.dataset.forkKey]);
    }
  }
  markGeometryStale('A proposta foi aplicada aos campos. Revise os valores e construa a prévia antes de exportar.');
}

function markGeometryStale(message = 'Parâmetros alterados. Construa a prévia novamente antes de exportar.') {
  geometryStale = true;
  exportStlButton.disabled = true;
  exportReportButton.disabled = true;
  const cutButton = document.querySelector('#forgeCut');
  const layerButton = document.querySelector('#forgeLayers');
  cutButton.disabled = true;
  layerButton.disabled = true;
  cutButton.textContent = 'Alternar corte';
  layerButton.textContent = 'Construir por camadas';
  layerAnimation = null;
  cutEnabled = false;
  if (currentMesh) clearCurrentMesh();
  builtParameters = null;
  lastMetrics = null;
  metricsRoot.replaceChildren();
  setStatus(validationBox, message, '');
}

function slugify(value) {
  const safe = String(value || 'garfo-parametrico').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return safe || 'garfo-parametrico';
}

function saveBlob(blob, filename) {
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

function currentPurpose() {
  return document.querySelector('#forgePurpose').value;
}

function purposeLabel(value = currentPurpose()) {
  return ({ prototype: 'protótipo não alimentar', decorative: 'decorativo', 'food-contact': 'contato com alimentos — não certificado' })[value] || 'não informado';
}

function ensureViewer() {
  if (renderer) return;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    renderer.setClearColor('#030912', 1);
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#030912');
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, 310);
    scene.add(new THREE.HemisphereLight(0xc6f5ff, 0x142632, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-50, 80, 150);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x3adcf5, 1.2);
    rim.position.set(80, -30, -100);
    scene.add(rim);
    gridHelper = new THREE.GridHelper(240, 24, 0x23768b, 0x123746);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.z = -2;
    scene.add(gridHelper);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 40;
    controls.maxDistance = 900;
    controls.target.set(0, 0, 0);
    resizeObserver = new ResizeObserver(resizeViewer);
    resizeObserver.observe(viewport);
    resizeViewer();
  } catch (error) {
    setStatus(validationBox, `Pré-visualização WebGL indisponível: ${String(error.message || error).slice(0, 180)}`, 'error');
    throw error;
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

function startRendering() {
  if (!renderer || rendering) return;
  rendering = true;
  renderer.setAnimationLoop(time => {
    if (panel.hidden || !currentMesh) return;
    if (layerAnimation) {
      const progress = Math.min(1, (time - layerAnimation.startedAt) / layerAnimation.durationMs);
      layerAnimation.plane.constant = -builtParameters.lengthMm / 2 + progress * builtParameters.lengthMm;
      currentMesh.material.clippingPlanes = [layerAnimation.plane];
      if (progress >= 1) {
        layerAnimation = null;
        cutEnabled = false;
        currentMesh.material.clippingPlanes = [];
        currentMesh.material.needsUpdate = true;
        document.querySelector('#forgeLayers').textContent = 'Construir por camadas';
      }
    }
    controls.update();
    renderer.render(scene, camera);
  });
}

function stopRendering() {
  if (renderer && rendering) renderer.setAnimationLoop(null);
  rendering = false;
  layerAnimation = null;
  cutEnabled = false;
  document.querySelector('#forgeCut').textContent = 'Alternar corte';
  document.querySelector('#forgeLayers').textContent = 'Construir por camadas';
  if (currentMesh && currentMesh.material) {
    currentMesh.material.clippingPlanes = [];
    currentMesh.material.needsUpdate = true;
  }
}

function showPanel() {
  if (automationPanel) automationPanel.hidden = true;
  if (automationToggle) automationToggle.setAttribute('aria-expanded', 'false');
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  try { ensureViewer(); startRendering(); requestAnimationFrame(resizeViewer); }
  catch { /* O painel de parâmetros e exportação JSON continuam acessíveis sem WebGL. */ }
}

function hidePanel() {
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  stopRendering();
}

toggle.addEventListener('click', () => panel.hidden ? showPanel() : hidePanel());
document.querySelector('#forgeClose').addEventListener('click', hidePanel);
if (automationToggle) automationToggle.addEventListener('click', () => {
  if (automationPanel && !automationPanel.hidden) hidePanel();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden) hidePanel();
});

function renderMaterialFacts(material) {
  materialFacts.replaceChildren();
  if (!material) {
    materialFacts.textContent = 'Nenhum grade selecionado. A densidade e a massa teórica não serão estimadas.';
    return;
  }
  const density = Number(material.density_g_cm3);
  const lines = [
    `Família: ${material.polymer_and_reinforcement || material.family || 'não declarada pelo fabricante'}`,
    `Densidade publicada: ${Number.isFinite(density) && density > 0 ? `${density} g/cm³` : 'não informada na fonte consultada'}`,
    `Nota de densidade: ${material.density_note || 'sem observação adicional'}`,
    `Resistência à tração: ${material.tensile_strength_mpa || 'não informada na fonte consultada'}`,
    `Método/condição de tração: ${material.tensile_test_method_and_condition || 'não informado na fonte consultada'}`,
    `Módulo flexural: ${material.flexural_modulus_mpa || 'não informado na fonte consultada'}`,
    `Propriedade térmica: ${material.thermal_property_and_test || 'não informada na fonte consultada'}`,
    `Parâmetros recomendados: ${material.recommended_print_settings || 'não informados na fonte consultada'}`,
    `Ressalvas: ${material.caveats || 'verifique o TDS do lote e da impressora.'}`
  ];
  const text = document.createElement('p');
  text.textContent = lines.join('\n');
  text.style.whiteSpace = 'pre-line';
  materialFacts.append(text);
  for (const [index, url] of (material.source_urls || []).entries()) {
    try {
      const linkUrl = new URL(url);
      if (linkUrl.protocol !== 'https:') continue;
      const link = document.createElement('a');
      link.href = linkUrl.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `Fonte oficial ${index + 1}: ${material.source_labels?.[index] || material.brand_grade || linkUrl.hostname}`;
      materialFacts.append(link, document.createElement('br'));
    } catch { /* URLs inválidas não se tornam links clicáveis. */ }
  }
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/engineering/materials', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Catálogo não disponível.');
    const data = await response.json();
    if (!Array.isArray(data.materials) || !data.materials.length) throw new Error('Catálogo sem materiais verificados.');
    catalog = data.materials;
    catalogVerifiedOn = typeof data.verifiedOn === 'string' ? data.verifiedOn : null;
    materialSelect.replaceChildren();
    for (const material of catalog) {
      const option = document.createElement('option');
      option.value = material.id;
      option.textContent = material.brand_grade;
      materialSelect.append(option);
    }
    materialSelect.value = catalog.find(item => item.id === 'pla')?.id || catalog[0].id;
    selectMaterial();
  } catch (error) {
    materialSelect.replaceChildren(new Option('Catálogo indisponível', ''));
    selectedMaterial = null;
    renderMaterialFacts(null);
    setStatus(validationBox, `${error.message || 'Não foi possível carregar fontes de material.'} O sólido pode ser construído, mas não há massa estimada.`, 'error');
  }
}

function selectMaterial() {
  selectedMaterial = catalog.find(item => item.id === materialSelect.value) || null;
  renderMaterialFacts(selectedMaterial);
  if (currentMesh && !geometryStale) updateMetrics();
}
materialSelect.addEventListener('change', selectMaterial);

function appendMetric(label, value) {
  const tile = document.createElement('div');
  tile.className = 'forge-metric';
  const number = document.createElement('strong');
  number.textContent = value;
  const caption = document.createElement('span');
  caption.textContent = label;
  tile.append(number, caption);
  metricsRoot.append(tile);
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function updateMetrics() {
  if (!currentMesh || !builtParameters || geometryStale) return;
  lastMetrics = calculateForkMetrics(currentMesh, builtParameters, selectedMaterial);
  metricsRoot.replaceChildren();
  appendMetric('Comprimento · mm', formatNumber(lastMetrics.boundingBoxMm.length));
  appendMetric('Largura máxima · mm', formatNumber(lastMetrics.boundingBoxMm.width));
  appendMetric('Espessura · mm', formatNumber(lastMetrics.boundingBoxMm.thickness));
  appendMetric('Volume CAD · mm³', formatNumber(lastMetrics.volumeMm3, 1));
  appendMetric('Área externa · mm²', formatNumber(lastMetrics.surfaceAreaMm2, 1));
  appendMetric('Triângulos', formatNumber(lastMetrics.triangleCount, 0));
  appendMetric('Massa teórica sólida · g', lastMetrics.solidMassEstimateG === null ? 'n/d' : formatNumber(lastMetrics.solidMassEstimateG, 2));
  const warnings = [
    'A malha fechada e o volume são da geometria triangulada produzida.',
    lastMetrics.massAssumption,
    'Sem solver FEM/térmico. Resistência, encaixe, suporte, tolerância e imprimibilidade não foram simulados.'
  ];
  if (currentPurpose() === 'food-contact') warnings.push('Contato com alimentos não está certificado. Filamento, aditivos, bico, contaminação, acabamento e limpeza exigem avaliação independente.');
  setStatus(validationBox, `MALHA ${lastMetrics.validation.closed ? 'FECHADA' : 'ABERTA'} · ${lastMetrics.triangleCount} triângulos\n${warnings.join('\n')}`, lastMetrics.validation.valid ? 'ok' : 'error');
  exportStlButton.disabled = !lastMetrics.validation.valid;
  exportReportButton.disabled = !lastMetrics.validation.valid;
}

function updateCameraForParameters(parameters) {
  if (!camera || !controls) return;
  const distance = Math.max(parameters.lengthMm * 1.55, 240);
  camera.position.set(0, 0, distance);
  camera.near = 0.1;
  camera.far = Math.max(3000, distance * 5);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.minDistance = parameters.lengthMm * 0.25;
  controls.maxDistance = parameters.lengthMm * 5;
  controls.update();
  if (gridHelper) gridHelper.position.z = -parameters.thicknessMm / 2 - 1;
}

function clearCurrentMesh() {
  if (!currentMesh) return;
  scene?.remove(currentMesh);
  currentMesh.geometry.dispose();
  currentMesh.material.dispose();
  currentMesh = null;
  lastMetrics = null;
}

function buildPreview() {
  try {
    const parameters = readParameters();
    ensureViewer();
    clearCurrentMesh();
    currentMesh = createForkMesh(parameters);
    builtParameters = parameters;
    geometryStale = false;
    cutEnabled = false;
    layerAnimation = null;
    currentMesh.material.clippingPlanes = [];
    scene.add(currentMesh);
    updateCameraForParameters(parameters);
    document.querySelector('#forgeCut').textContent = 'Alternar corte';
    document.querySelector('#forgeCut').disabled = false;
    document.querySelector('#forgeLayers').disabled = false;
    document.querySelector('#forgeLayers').textContent = 'Construir por camadas';
    updateMetrics();
    startRendering();
  } catch (error) {
    geometryStale = true;
    clearCurrentMesh();
    builtParameters = null;
    lastMetrics = null;
    metricsRoot.replaceChildren();
    document.querySelector('#forgeCut').disabled = true;
    document.querySelector('#forgeLayers').disabled = true;
    exportStlButton.disabled = true;
    exportReportButton.disabled = true;
    setStatus(validationBox, `Construção bloqueada: ${String(error.message || error).slice(0, 300)}`, 'error');
  }
}

document.querySelector('#forgeBuild').addEventListener('click', buildPreview);
for (const input of parameterInputs) input.addEventListener('input', () => markGeometryStale());
document.querySelector('#forgePurpose').addEventListener('change', () => {
  if (currentMesh && !geometryStale) updateMetrics();
});

document.querySelector('#forgeCut').addEventListener('click', () => {
  if (!currentMesh || geometryStale) return;
  layerAnimation = null;
  cutEnabled = !cutEnabled;
  currentMesh.material.clippingPlanes = cutEnabled
    ? [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)] : [];
  currentMesh.material.needsUpdate = true;
  document.querySelector('#forgeCut').textContent = cutEnabled ? 'Remover corte' : 'Alternar corte';
  document.querySelector('#forgeLayers').textContent = 'Construir por camadas';
});

document.querySelector('#forgeLayers').addEventListener('click', () => {
  if (!currentMesh || geometryStale) return;
  if (layerAnimation) {
    layerAnimation = null;
    currentMesh.material.clippingPlanes = cutEnabled
      ? [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)] : [];
    currentMesh.material.needsUpdate = true;
    document.querySelector('#forgeLayers').textContent = 'Construir por camadas';
    return;
  }
  cutEnabled = false;
  document.querySelector('#forgeCut').textContent = 'Alternar corte';
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -builtParameters.lengthMm / 2);
  layerAnimation = { plane, startedAt: performance.now(), durationMs: 3200 };
  currentMesh.material.clippingPlanes = [plane];
  currentMesh.material.needsUpdate = true;
  document.querySelector('#forgeLayers').textContent = 'Parar camadas';
});

document.querySelector('#forgeResetView').addEventListener('click', () => {
  if (!currentMesh || !builtParameters) return;
  updateCameraForParameters(builtParameters);
});

function currentProject() {
  const parameters = readParameters();
  const validation = currentMesh && !geometryStale ? validateTriangleMesh(currentMesh.geometry) : null;
  const metrics = validation?.valid ? calculateForkMetrics(currentMesh, builtParameters, selectedMaterial) : null;
  return {
    schema: 'grid-soul-atomic-forge-project-v1',
    createdAt: new Date().toISOString(),
    projectName: document.querySelector('#forgeProjectName').value.trim().slice(0, 80) || 'Garfo paramétrico',
    description: document.querySelector('#forgeDescription').value.trim().slice(0, 1200),
    intendedUse: purposeLabel(),
    units: 'mm',
    parameters,
    materialId: selectedMaterial?.id || null,
    materialGrade: selectedMaterial?.brand_grade || null,
    materialSnapshot: selectedMaterial ? {
      catalogVerifiedOn,
      ...selectedMaterial,
      densityUsed_g_cm3: Number.isFinite(selectedMaterial.density_g_cm3) && selectedMaterial.density_g_cm3 > 0
        ? selectedMaterial.density_g_cm3 : null
    } : null,
    geometryStatus: validation?.valid ? 'malha construída e verificada' : 'geometria ainda não construída',
    metrics,
    limitations: [
      'Protótipo geométrico de garfo; não é certificação de fabricação ou uso.',
      'Massa calculada assume 100% do volume CAD e densidade de ficha; não representa consumo de impressão.',
      'Sem solver FEM/térmico, slicer, G-code, exportador 3MF/STEP ou validação alimentar.'
    ]
  };
}

document.querySelector('#forgeExportJson').addEventListener('click', () => {
  try {
    const project = currentProject();
    if (!window.confirm('Baixar um JSON local com a descrição digitada, dimensões, material selecionado e estado de validação? O arquivo será salvo pelo navegador no computador.')) return;
    saveBlob(new Blob([JSON.stringify(project, null, 2) + '\n'], { type: 'application/json' }), `${slugify(project.projectName)}.grid-soul.json`);
  } catch (error) { setStatus(validationBox, String(error.message || error), 'error'); }
});

document.querySelector('#forgeExportStl').addEventListener('click', () => {
  if (!currentMesh || geometryStale || !lastMetrics?.validation.valid) return;
  const project = currentProject();
  const filename = `${slugify(project.projectName)}.stl`;
  if (!window.confirm(`Exportar ${filename} como STL binário em milímetros?\n\nA malha está fechada. O STL não contém unidades gravadas, solver FEM nem parâmetros de fatiamento; confirme a escala mm no slicer. A exportação não inicia impressão.`)) return;
  try {
    const result = exportForkStl(currentMesh);
    saveBlob(new Blob([result], { type: 'model/stl' }), filename);
    setStatus(validationBox, `STL binário exportado localmente · ${lastMetrics.triangleCount} triângulos · escala pretendida: mm. A escala deve ser conferida ao importar.`, 'ok');
  } catch (error) { setStatus(validationBox, `Exportação bloqueada: ${String(error.message || error)}`, 'error'); }
});

document.querySelector('#forgeExportReport').addEventListener('click', () => {
  if (!currentMesh || geometryStale || !lastMetrics?.validation.valid) return;
  try {
    const project = currentProject();
    const material = selectedMaterial;
    const citations = (material?.source_urls || []).map((url, index) =>
      `- ${material.source_labels?.[index] || material.brand_grade || `Fonte ${index + 1}`}: ${url}`
    ).join('\n') || '- Nenhuma fonte de material selecionada.';
    const densityUsed = project.materialSnapshot?.densityUsed_g_cm3;
    const materialFacts = material ? [
      `- Catálogo verificado em: ${catalogVerifiedOn || 'data não informada'}`,
      `- Grade: ${material.brand_grade}`,
      `- Densidade publicada: ${material.density_g_cm3 ?? 'não informada'}${material.density_g_cm3 == null ? '' : ' g/cm³'}`,
      `- Densidade usada na massa teórica: ${densityUsed == null ? 'não estimada' : `${densityUsed} g/cm³`}`,
      `- Nota/divergência de densidade: ${material.density_note || 'não informada'}`,
      `- Tração: ${material.tensile_strength_mpa || 'não informada'}`,
      `- Método/condição de tração: ${material.tensile_test_method_and_condition || 'não informada'}`,
      `- Módulo flexural: ${material.flexural_modulus_mpa || 'não informado'}`,
      `- Propriedades térmicas: ${material.thermal_property_and_test || 'não informadas'}`,
      `- Ressalvas: ${material.caveats || 'nenhuma informada'}`
    ] : ['- Nenhum material selecionado.'];
    const report = [
      `# Relatório técnico — ${project.projectName}`,
      '',
      `Gerado localmente em ${project.createdAt}.` ,
      `Uso informado: ${project.intendedUse}.`,
      '',
      '## Especificação',
      `- Objeto: garfo paramétrico de protótipo`,
      `- Unidade geométrica: ${project.units}`,
      `- Parâmetros: ${JSON.stringify(project.parameters)}`,
      `- Material selecionado: ${project.materialGrade || 'não selecionado'}`,
      '',
      '## Procedência e dados publicados do material',
      ...materialFacts,
      '',
      '## Geometria construída',
      `- Validação de malha fechada: ${lastMetrics.validation.closed ? 'sim' : 'não'}`,
      `- Triângulos: ${lastMetrics.triangleCount}`,
      `- Bounding box (mm): ${JSON.stringify(lastMetrics.boundingBoxMm)}`,
      `- Volume triangulado (mm³): ${lastMetrics.volumeMm3}`,
      `- Área externa (mm²): ${lastMetrics.surfaceAreaMm2}`,
      `- Massa teórica a 100% sólido (g): ${lastMetrics.solidMassEstimateG ?? 'não estimada'}`,
      `- Hipótese de massa: ${lastMetrics.massAssumption}`,
      '',
      '## Limites',
      ...project.limitations.map(item => `- ${item}`),
      '- Não foram verificados encaixes, orientação de impressão, suportes, tolerâncias, resistência estrutural ou tempo de fatiamento.',
      '',
      '## Fontes oficiais do material selecionado',
      citations,
      ''
    ].join('\n');
    saveBlob(new Blob([report], { type: 'text/markdown;charset=utf-8' }), `${slugify(project.projectName)}.relatorio.md`);
  } catch (error) { setStatus(validationBox, String(error.message || error), 'error'); }
});

function proposalText(result) {
  const lines = [`Origem: ${result.source || 'análise local'}`];
  if (result.parameters) lines.push(`Sugestão validada: ${JSON.stringify(result.parameters)}`);
  for (const [label, key] of [['Perguntas', 'questions'], ['Hipóteses', 'assumptions'], ['Requisitos', 'requirements'], ['Avisos', 'warnings']]) {
    if (Array.isArray(result[key]) && result[key].length) lines.push(`${label}:\n• ${result[key].join('\n• ')}`);
  }
  if (!result.supported) lines.push('Nenhum sólido foi construído.');
  return lines.join('\n\n');
}

document.querySelector('#forgeAnalyze').addEventListener('click', async event => {
  const button = event.currentTarget;
  const description = document.querySelector('#forgeDescription').value.trim();
  const useAI = document.querySelector('#forgeUseAI').checked;
  if (!description) {
    setStatus(questionBox, 'Descreva o objeto. Esta versão só gera um garfo paramétrico.', 'error');
    return;
  }
  let parameters;
  try { parameters = readParameters(); }
  catch (error) { setStatus(questionBox, `Corrija os parâmetros antes de analisar: ${error.message}`, 'error'); return; }
  const intendedUse = purposeLabel();
  const intendedUseKey = currentPurpose();
  if (useAI) {
    const approved = window.confirm(`Enviar a descrição e os parâmetros exatos abaixo à ponte ChatGPT configurada?\n\nDescrição: ${description}\n\nFinalidade: ${intendedUse} (${intendedUseKey})\n\nParâmetros:\n${JSON.stringify(parameters, null, 2)}\n\nNenhum arquivo, pasta, credencial ou conversa existente será anexado. A IA retornará apenas uma proposta dimensional que você ainda precisará revisar. Continuar?`);
    if (!approved) return;
  }
  button.disabled = true;
  setStatus(questionBox, useAI ? 'Registrando a confirmação local antes de solicitar a proposta…' : 'Analisando localmente; nenhum dado sai deste computador…');
  try {
    let consentToken = null;
    if (useAI) {
      const consentResponse = await fetch('/api/engineering/consent', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, intendedUse: intendedUseKey, parameters })
      });
      const consentData = await consentResponse.json();
      if (!consentResponse.ok || typeof consentData.consentToken !== 'string') {
        throw new Error(consentData.error || 'Não foi possível registrar a confirmação local.');
      }
      consentToken = consentData.consentToken;
    }
    setStatus(questionBox, useAI ? 'Aguardando proposta do ChatGPT…' : 'Analisando localmente; nenhum dado sai deste computador…');
    const response = await fetch('/api/engineering/analyze', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, intendedUse: intendedUseKey, useAI, consentToken, parameters })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Não foi possível analisar a descrição.');
    lastAnalysis = data.result;
    setStatus(questionBox, proposalText(lastAnalysis), lastAnalysis.supported ? 'ok' : '');
    if (lastAnalysis.supported && lastAnalysis.parameters) writeParameters(lastAnalysis.parameters);
  } catch (error) {
    setStatus(questionBox, `Análise não concluída: ${String(error.message || error).slice(0, 300)}`, 'error');
  } finally { button.disabled = false; }
});

for (const input of [document.querySelector('#forgeProjectName'), document.querySelector('#forgeDescription')]) {
  input.addEventListener('input', () => {
    if (currentMesh && !geometryStale) updateMetrics();
  });
}

loadCatalog();
setStatus(validationBox, 'Nenhuma geometria construída. Escolha um material e construa a prévia para calcular volume e validar a malha.');
