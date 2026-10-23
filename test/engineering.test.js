import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORK_DEFAULTS,
  calculateForkMetrics,
  createForkMesh,
  exportForkStl,
  parseForkRequest,
  validateForkParameters,
  validateTriangleMesh
} from '../public/engineering/fork.js';
import {
  analyzeForkLocally,
  buildEngineeringPrompt,
  sanitizeEngineeringProposal
} from '../lib/engineering/assistant.js';
import { GRID_SOUL_MATERIALS } from '../components/material_catalog.js';

function dispose(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

test('garfo padrão gera sólido triangular fechado com dimensões e volume positivos', () => {
  const mesh = createForkMesh();
  try {
    const valid = validateTriangleMesh(mesh.geometry);
    assert.equal(valid.valid, true, valid.errors.join(' '));
    assert.equal(valid.closed, true);
    assert.equal(valid.nonManifoldEdges, 0);
    assert.equal(valid.dimensionsMm.length, FORK_DEFAULTS.lengthMm);
    assert.equal(valid.dimensionsMm.thickness, FORK_DEFAULTS.thicknessMm);
    assert.ok(Math.abs(valid.dimensionsMm.width - 18.8) < 1e-4);
    assert.ok(valid.volumeMm3 > 0);
  } finally { dispose(mesh); }
});

test('STL binário exportado contém cabeçalho consistente e todos os triângulos', () => {
  const mesh = createForkMesh();
  try {
    const validation = validateTriangleMesh(mesh.geometry);
    const stl = exportForkStl(mesh);
    assert.ok(stl instanceof DataView);
    assert.equal(stl.byteLength, 84 + validation.triangleCount * 50);
    assert.equal(stl.getUint32(80, true), validation.triangleCount);
    const metrics = calculateForkMetrics(mesh, mesh.userData.parameters, { density_g_cm3: 1.24 });
    assert.ok(metrics.solidMassEstimateG > 0);
    assert.match(metrics.massAssumption, /100% de volume sólido/);
  } finally { dispose(mesh); }
});

test('requisição em português converte dimensões e parâmetros explícitos sem inventar o restante', () => {
  const result = parseForkRequest('Garfo com comprimento total de 20 cm, 3 dentes e espessura de 2,4 mm.');
  assert.equal(result.supported, true);
  assert.equal(result.parameters.lengthMm, 200);
  assert.equal(result.parameters.tineCount, 3);
  assert.equal(result.parameters.thicknessMm, 2.4);
  assert.ok(result.assumptions.some(item => item.includes('não validado')));
});

test('objeto não suportado pergunta antes de construir geometria', () => {
  const result = analyzeForkLocally('Preciso de uma dobradiça articulada.');
  assert.equal(result.supported, false);
  assert.equal(result.parameters, null);
  assert.match(result.questions[0], /garfos paramétricos/i);
});

test('validação rejeita dimensões fora do limite e parâmetros extras', () => {
  assert.throws(() => validateForkParameters({ lengthMm: 500 }), /lengthMm/);
  assert.throws(() => validateForkParameters({ tineCount: 9 }), /tineCount/);
  assert.throws(() => validateForkParameters({ handleTipWidthMm: 20 }), /não pode exceder/);
  assert.throws(() => validateForkParameters({ command: 'rm -rf' }), /não permitido/);
});

test('dentes configuráveis continuam produzindo uma única malha fechada', () => {
  for (const tineCount of [2, 3, 5, 6]) {
    const parameters = { ...FORK_DEFAULTS, tineCount };
    if (tineCount === 2) parameters.handleWidthMm = 12;
    const mesh = createForkMesh(parameters);
    try {
      const validation = validateTriangleMesh(mesh.geometry);
      assert.equal(validation.valid, true, `${tineCount}: ${validation.errors.join(' ')}`);
      assert.equal(validation.dimensionsMm.length, FORK_DEFAULTS.lengthMm);
    } finally { dispose(mesh); }
  }
});

test('proposta IA é somente sugestão, revalidada e sem autoridade sobre parâmetros inválidos', () => {
  const proposal = sanitizeEngineeringProposal({
    object: 'fork', parameters: { lengthMm: 205, tineCount: 4 },
    requirements: ['comprimento explícito'], questions: [], assumptions: ['valor proposto'], warnings: []
  }, { description: 'Garfo de teste' });
  assert.equal(proposal.supported, true);
  assert.equal(proposal.parameters.lengthMm, 205);
  assert.match(proposal.source, /não validada/);
  assert.throws(() => sanitizeEngineeringProposal({ object: 'fork', parameters: { lengthMm: 900 } }), /lengthMm/);
  const prompt = buildEngineeringPrompt('garfo protótipo');
  assert.match(prompt, /apenas JSON válido/);
  assert.match(prompt, /não dê parecer de segurança alimentar/);
});

test('seis grades mantêm fontes oficiais e ausência de densidade não vira uma estimativa falsa', () => {
  assert.equal(GRID_SOUL_MATERIALS.length, 6);
  for (const material of GRID_SOUL_MATERIALS) {
    assert.ok(material.source_urls.length > 0, `${material.id} precisa de fonte`);
    assert.ok(material.source_urls.every(url => url.startsWith('https://')));
  }
  const reinforced = GRID_SOUL_MATERIALS.find(material => material.id === 'reinforced');
  assert.equal(reinforced.density_g_cm3, null);
  const mesh = createForkMesh();
  try {
    const metrics = calculateForkMetrics(mesh, mesh.userData.parameters, reinforced);
    assert.equal(metrics.solidMassEstimateG, null);
  } finally { dispose(mesh); }
});
