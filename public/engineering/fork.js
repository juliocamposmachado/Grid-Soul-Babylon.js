import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

export const FORK_DEFAULTS = Object.freeze({
  lengthMm: 190,
  tineCount: 4,
  tineLengthMm: 40,
  tineWidthMm: 3.2,
  tineGapMm: 2,
  neckLengthMm: 16,
  handleWidthMm: 13,
  handleTipWidthMm: 10,
  thicknessMm: 3
});

const NUMERIC_BOUNDS = Object.freeze({
  lengthMm: [90, 350],
  tineLengthMm: [20, 80],
  tineWidthMm: [1.5, 5],
  tineGapMm: [1.2, 5],
  neckLengthMm: [8, 25],
  handleWidthMm: [6, 30],
  handleTipWidthMm: [4, 30],
  thicknessMm: [1.6, 8]
});

export function validateForkParameters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Os parâmetros do garfo devem ser um objeto.');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'tineCount' && key !== 'headWidthMm' && !Object.hasOwn(NUMERIC_BOUNDS, key)) {
      throw new RangeError(`Parâmetro de garfo não permitido: ${key}.`);
    }
  }

  const parameters = {};
  for (const [key, [minimum, maximum]] of Object.entries(NUMERIC_BOUNDS)) {
    const candidate = input[key] ?? FORK_DEFAULTS[key];
    const value = typeof candidate === 'string' && candidate.trim() !== '' ? Number(candidate) : candidate;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`${key} deve estar entre ${minimum} e ${maximum} mm.`);
    }
    parameters[key] = value;
  }

  const count = input.tineCount ?? FORK_DEFAULTS.tineCount;
  if (!Number.isInteger(Number(count)) || Number(count) < 2 || Number(count) > 6) {
    throw new RangeError('tineCount deve ser um inteiro entre 2 e 6.');
  }
  parameters.tineCount = Number(count);
  if (parameters.handleTipWidthMm > parameters.handleWidthMm) {
    throw new RangeError('handleTipWidthMm não pode exceder handleWidthMm.');
  }

  const headWidthMm = parameters.tineCount * parameters.tineWidthMm
    + (parameters.tineCount - 1) * parameters.tineGapMm;
  if (input.headWidthMm !== undefined && (!Number.isFinite(Number(input.headWidthMm)) || Math.abs(Number(input.headWidthMm) - headWidthMm) > 1e-6)) {
    throw new RangeError('headWidthMm é derivado e não pode divergir das medidas das pontas.');
  }
  if (headWidthMm > 42) throw new RangeError('A largura calculada da cabeça excede 42 mm.');
  if (parameters.handleWidthMm > headWidthMm + 4) {
    throw new RangeError('A largura do cabo não pode exceder a cabeça do garfo em mais de 4 mm.');
  }
  if (parameters.tineLengthMm + parameters.neckLengthMm + 18 > parameters.lengthMm) {
    throw new RangeError('As pontas e o pescoço deixam menos de 18 mm para o cabo.');
  }

  return Object.freeze({ ...parameters, headWidthMm });
}

export function parseForkRequest(description, currentParameters = {}) {
  const text = String(description || '').trim();
  if (!text || text.length > 1200) throw new RangeError('Descreva o projeto em até 1.200 caracteres.');
  if (!/\b(garfo|fork)\b/i.test(text)) {
    return {
      supported: false,
      questions: ['Esta primeira versão gera garfos paramétricos. Qual peça você quer projetar?'],
      assumptions: []
    };
  }

  const candidate = { ...currentParameters };
  const lengthMatch = text.match(/\bcomprimento(?:\s+total)?\s*(?:de|:|=)?\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)\b/i);
  if (lengthMatch) {
    candidate.lengthMm = Number(lengthMatch[1].replace(',', '.')) * (lengthMatch[2].toLowerCase() === 'cm' ? 10 : 1);
  }
  const tineMatch = text.match(/\b(\d+)\s*(?:dentes|pontas)\b/i);
  if (tineMatch) candidate.tineCount = Number(tineMatch[1]);
  const thicknessMatch = text.match(/\b(?:espessura|grossura)(?:\s+de)?\s*(\d+(?:[.,]\d+)?)\s*mm\b/i)
    || text.match(/\b(\d+(?:[.,]\d+)?)\s*mm\s+de\s+espessura\b/i);
  if (thicknessMatch) candidate.thicknessMm = Number(thicknessMatch[1].replace(',', '.'));

  const parameters = validateForkParameters(candidate);
  const assumptions = [];
  if (!lengthMatch) assumptions.push(`Comprimento padrão sugerido: ${parameters.lengthMm} mm.`);
  if (!tineMatch) assumptions.push(`Quantidade padrão sugerida: ${parameters.tineCount} pontas.`);
  if (!thicknessMatch) assumptions.push(`Espessura padrão sugerida: ${parameters.thicknessMm} mm.`);
  assumptions.push('Protótipo conceitual; não validado para contato com alimentos nem para resistência estrutural.');
  return {
    supported: true,
    parameters,
    questions: [
      `As dimensões sugeridas — ${parameters.lengthMm} mm e ${parameters.tineCount} pontas — atendem ao uso pretendido? Você pode editá-las antes de construir.`,
      'O uso será decorativo, protótipo ou contato com alimentos? A escolha não certifica segurança alimentar.'
    ],
    assumptions
  };
}

export function createForkShape(input = {}) {
  const p = validateForkParameters(input);
  const shape = new THREE.Shape();
  const rootY = p.lengthMm / 2 - p.tineLengthMm;
  const neckY = rootY - p.neckLengthMm;
  const headHalfWidth = p.headWidthMm / 2;
  const tinePitch = p.tineWidthMm + p.tineGapMm;
  const firstCenter = -headHalfWidth + p.tineWidthMm / 2;
  const tipY = p.lengthMm / 2;
  const tipRadius = Math.min(0.65, p.tineWidthMm * 0.2, p.tineGapMm * 0.24);

  shape.moveTo(-headHalfWidth, rootY);
  for (let index = 0; index < p.tineCount; index += 1) {
    const centerX = firstCenter + index * tinePitch;
    const leftX = centerX - p.tineWidthMm / 2;
    const rightX = centerX + p.tineWidthMm / 2;
    shape.lineTo(leftX, rootY);
    shape.lineTo(leftX, tipY - tipRadius);
    shape.quadraticCurveTo(leftX, tipY, centerX, tipY);
    shape.quadraticCurveTo(rightX, tipY, rightX, tipY - tipRadius);
    shape.lineTo(rightX, rootY);
  }
  shape.lineTo(headHalfWidth, rootY);
  shape.lineTo(headHalfWidth, neckY);

  const bottomY = -p.lengthMm / 2;
  const transition = Math.min(12, p.neckLengthMm * 0.65);
  const handleTopY = neckY - transition;
  const handleSideBottomY = bottomY + 7;
  shape.lineTo(p.handleWidthMm / 2, handleTopY);
  shape.lineTo(p.handleWidthMm / 2, handleSideBottomY);
  shape.quadraticCurveTo(p.handleWidthMm / 2, bottomY, p.handleTipWidthMm / 2, bottomY);
  shape.lineTo(-p.handleTipWidthMm / 2, bottomY);
  shape.quadraticCurveTo(-p.handleWidthMm / 2, bottomY, -p.handleWidthMm / 2, handleSideBottomY);
  shape.lineTo(-p.handleWidthMm / 2, handleTopY);
  shape.lineTo(-headHalfWidth, neckY);
  shape.lineTo(-headHalfWidth, rootY);
  shape.closePath();
  return shape;
}

export function createForkMesh(input = {}, materialOptions = {}) {
  const parameters = validateForkParameters(input);
  const geometry = new THREE.ExtrudeGeometry(createForkShape(parameters), {
    depth: parameters.thicknessMm,
    bevelEnabled: false,
    curveSegments: 12,
    steps: 1
  });
  geometry.translate(0, 0, -parameters.thicknessMm / 2);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: materialOptions.color || '#DCE8EE',
    metalness: 0.08,
    roughness: 0.62
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'GRID-SOUL-Atomic-Forge-Fork';
  mesh.userData.parameters = parameters;
  mesh.userData.unit = 'mm';
  return mesh;
}

function positionKey(attribute, index) {
  return [0, 1, 2].map(axis => Math.round(attribute.getComponent(index, axis) * 100000) / 100000).join(',');
}

export function validateTriangleMesh(geometry) {
  const position = geometry?.getAttribute?.('position');
  if (!position || position.count < 12 || position.count % 3 !== 0) {
    return { valid: false, errors: ['A malha não contém uma lista de triângulos válida.'] };
  }
  let allFinite = true;
  for (let index = 0; index < position.count * 3; index += 1) {
    if (!Number.isFinite(position.array[index])) { allFinite = false; break; }
  }
  if (!allFinite) return { valid: false, errors: ['A malha contém coordenadas não finitas.'] };

  const edgeCounts = new Map();
  const index = geometry.index;
  const vertexIndex = triangleVertex => index ? index.getX(triangleVertex) : triangleVertex;
  const addEdge = (a, b) => {
    const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
    edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1);
  };
  for (let triangle = 0; triangle < position.count; triangle += 3) {
    const ids = [0, 1, 2].map(offset => positionKey(position, vertexIndex(triangle + offset)));
    addEdge(ids[0], ids[1]); addEdge(ids[1], ids[2]); addEdge(ids[2], ids[0]);
  }
  const nonManifoldEdges = [...edgeCounts.values()].filter(count => count !== 2).length;
  const bounds = geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox);
  const dimensions = bounds.getSize(new THREE.Vector3());
  const boxPositive = dimensions.x > 0 && dimensions.y > 0 && dimensions.z > 0;
  const metrics = computeTriangleMetrics(geometry);
  const closed = nonManifoldEdges === 0;
  const positiveVolume = metrics.volumeMm3 > 0;
  const valid = closed && boxPositive && positiveVolume;
  const errors = [];
  if (!closed) errors.push(`A malha tem ${nonManifoldEdges} arestas abertas ou não manifold.`);
  if (!boxPositive) errors.push('Uma ou mais dimensões do sólido são nulas.');
  if (!positiveVolume) errors.push('O volume calculado da malha não é positivo.');
  return {
    valid,
    closed,
    nonManifoldEdges,
    triangleCount: position.count / 3,
    errors,
    dimensionsMm: { width: dimensions.x, length: dimensions.y, thickness: dimensions.z },
    volumeMm3: metrics.volumeMm3
  };
}

export function computeTriangleMetrics(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  let signedVolume = 0;
  let areaMm2 = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const get = (i, target) => {
    const vertex = index ? index.getX(i) : i;
    return target.fromBufferAttribute(position, vertex);
  };
  for (let triangle = 0; triangle < count; triangle += 3) {
    get(triangle, a); get(triangle + 1, b); get(triangle + 2, c);
    signedVolume += a.dot(cross.crossVectors(b, c)) / 6;
    ab.subVectors(b, a); ac.subVectors(c, a);
    areaMm2 += cross.crossVectors(ab, ac).length() / 2;
  }
  return { volumeMm3: Math.abs(signedVolume), surfaceAreaMm2: areaMm2, triangleCount: count / 3 };
}

export function calculateForkMetrics(mesh, input, material = null) {
  const parameters = validateForkParameters(input);
  const validation = validateTriangleMesh(mesh.geometry);
  if (!validation.valid) throw new Error(`Malha inválida: ${validation.errors.join(' ')}`);
  const triangles = computeTriangleMetrics(mesh.geometry);
  const density = Number(material?.density_g_cm3);
  const solidMassEstimateG = Number.isFinite(density) && density > 0
    ? triangles.volumeMm3 * density / 1000
    : null;
  return {
    validation,
    volumeMm3: triangles.volumeMm3,
    surfaceAreaMm2: triangles.surfaceAreaMm2,
    triangleCount: triangles.triangleCount,
    boundingBoxMm: validation.dimensionsMm,
    solidMassEstimateG,
    massAssumption: solidMassEstimateG === null
      ? 'Densidade não publicada para o grade selecionado; massa não estimada.'
      : `Estimativa teórica a 100% de volume sólido, usando densidade publicada de ${density} g/cm³. Não representa consumo do fatiador nem massa real da peça impressa.`,
    units: { length: 'mm', volume: 'mm³', surfaceArea: 'mm²', density: 'g/cm³', mass: 'g' },
    parameters
  };
}

export function exportForkStl(mesh) {
  const validation = validateTriangleMesh(mesh.geometry);
  if (!validation.valid) throw new Error(`Exportação bloqueada: ${validation.errors.join(' ')}`);
  const result = new STLExporter().parse(mesh, { binary: true });
  const view = result instanceof DataView ? result : new DataView(result);
  if (view.byteLength < 134 || view.getUint32(80, true) !== validation.triangleCount) {
    throw new Error('O STL gerado não passou na validação de cabeçalho e contagem de triângulos.');
  }
  return view;
}
