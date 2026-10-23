const MAX_EXPORT_CELLS = 25_000;

function safeColor(r, g, b) {
  return [r, g, b].map(value => Math.max(0, Math.min(255, Math.round(Number(value)))));
}

function facetNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...normal) || 1;
  return normal.map(component => component / length);
}

function triangulateQuad(quad, output, triangleCount) {
  const triangles = [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]];
  for (const triangle of triangles) {
    const normal = facetNormal(...triangle);
    let offset = 84 + triangleCount * 50;
    output.setFloat32(offset, normal[0], true); offset += 4;
    output.setFloat32(offset, normal[1], true); offset += 4;
    output.setFloat32(offset, normal[2], true); offset += 4;
    for (const point of triangle) {
      for (const coordinate of point) { output.setFloat32(offset, coordinate, true); offset += 4; }
    }
    output.setUint16(offset, 0, true);
    triangleCount += 1;
  }
  return triangleCount;
}

/** Build a watertight-shell candidate from evenly sampled image cells.
 * It is a 2.5D relief slab (not a certified or engineering CAD solid).
 * STL is geometry-only; OBJ/MTL contains preview material colors.
 */
export function buildVoxelMeshFiles(analysis, { gapPercent = 0, depthMm = 1.6 } = {}) {
  const grid = analysis?.swarm;
  if (!grid || !Array.isArray(grid.samples) || !grid.samples.length) throw new Error('Analise uma imagem antes de exportar a malha.');
  if (grid.samples.length > MAX_EXPORT_CELLS) throw new Error(`O exportador local aceita até ${MAX_EXPORT_CELLS.toLocaleString('pt-BR')} células por arquivo; reduza a população.`);
  const columns = Number(grid.columns);
  const rows = Number(grid.rows);
  const widthMm = Number(grid.physicalWidthMm);
  const heightMm = Number(grid.physicalHeightMm);
  const depth = Number(depthMm);
  const gap = Number(gapPercent) / 100;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 100_000) throw new Error('A grade salva não possui dimensões suportadas.');
  if (![widthMm, heightMm, depth, gap].every(Number.isFinite) || widthMm <= 0 || heightMm <= 0 || depth <= 0 || gap < 0 || gap > 0.35) throw new Error('Verifique as dimensões e o espaçamento antes de exportar.');

  const cells = new Array(columns * rows).fill(null);
  for (const sample of grid.samples) {
    if (!Array.isArray(sample) || sample.length < 5) throw new Error('Amostra de cor/posição inválida.');
    const column = Math.max(0, Math.min(columns - 1, Math.floor((Number(sample[0]) + 0.5) * columns)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((0.5 - Number(sample[1])) * rows)));
    const [r, g, b] = safeColor(sample[2], sample[3], sample[4]);
    cells[row * columns + column] = { color: [r, g, b], hex: [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase() };
  }
  const populated = cells.reduce((count, cell) => count + Number(Boolean(cell)), 0);
  if (!populated) throw new Error('A grade não contém células utilizáveis.');

  const objVertices = [];
  const vertexIndex = new Map();
  const objFaces = [];
  let lastMaterial = '';
  const materialNames = new Set();
  const coordinateKey = point => point.map(value => Number(value).toFixed(5)).join(',');
  const addVertex = point => {
    const key = coordinateKey(point);
    let index = vertexIndex.get(key);
    if (index !== undefined) return index;
    index = objVertices.length + 1;
    vertexIndex.set(key, index);
    objVertices.push(`v ${point.map(value => Number(value.toFixed(5))).join(' ')}`);
    return index;
  };
  const maxTriangles = populated * (gap > 0 ? 12 : 12) + 2 * (columns + rows) * 2;
  const stlBytes = new Uint8Array(84 + maxTriangles * 50);
  const stlView = new DataView(stlBytes.buffer);
  const header = new TextEncoder().encode('GRID SOUL voxel image relief; binary STL; geometry only; numeric coordinates in mm');
  stlBytes.set(header.subarray(0, 80), 0);
  let triangleCount = 0;
  const dx = widthMm / columns;
  const dy = heightMm / rows;
  const zTop = depth / 2;
  const zBottom = -depth / 2;
  const quad = (color, points) => {
    const name = `pixel_${color.hex}`;
    materialNames.add(color.hex);
    if (name !== lastMaterial) {
      objFaces.push(`usemtl ${name}`);
      lastMaterial = name;
    }
    const indexes = points.map(addVertex);
    objFaces.push(`f ${indexes.join(' ')}`);
    triangleCount = triangulateQuad(points, stlView, triangleCount);
  };
  const get = (column, row) => column < 0 || row < 0 || column >= columns || row >= rows ? null : cells[row * columns + column];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = get(column, row);
      if (!cell) continue;
      const centerX = -widthMm / 2 + (column + 0.5) * dx;
      const centerY = heightMm / 2 - (row + 0.5) * dy;
      const cellWidth = dx * (1 - gap);
      const cellHeight = dy * (1 - gap);
      const x0 = centerX - cellWidth / 2, x1 = centerX + cellWidth / 2;
      const y0 = centerY - cellHeight / 2, y1 = centerY + cellHeight / 2;
      const tlTop = [x0, y1, zTop], trTop = [x1, y1, zTop], brTop = [x1, y0, zTop], blTop = [x0, y0, zTop];
      quad(cell, [blTop, brTop, trTop, tlTop]);
      quad(cell, [[blTop[0], blTop[1], zBottom], [tlTop[0], tlTop[1], zBottom], [trTop[0], trTop[1], zBottom], [brTop[0], brTop[1], zBottom]]);

      const separateBlocks = gap > 1e-8;
      if (separateBlocks || !get(column - 1, row)) quad(cell, [[x0, y0, zTop], [x0, y1, zTop], [x0, y1, zBottom], [x0, y0, zBottom]]);
      if (separateBlocks || !get(column + 1, row)) quad(cell, [[x1, y1, zTop], [x1, y0, zTop], [x1, y0, zBottom], [x1, y1, zBottom]]);
      if (separateBlocks || !get(column, row - 1)) quad(cell, [[x0, y1, zTop], [x1, y1, zTop], [x1, y1, zBottom], [x0, y1, zBottom]]);
      if (separateBlocks || !get(column, row + 1)) quad(cell, [[x1, y0, zTop], [x0, y0, zTop], [x0, y0, zBottom], [x1, y0, zBottom]]);
    }
  }

  stlView.setUint32(80, triangleCount, true);
  const stl = stlBytes.subarray(0, 84 + triangleCount * 50);
  const mtl = [
    '# GRID SOUL image voxel colors; preview only; color support varies by slicer.',
    ...[...materialNames].sort().flatMap(hex => {
      const color = hex.match(/.{2}/g).map(value => parseInt(value, 16) / 255);
      return [`newmtl pixel_${hex}`, `Kd ${color.map(value => value.toFixed(6)).join(' ')}`, 'Ka 0.000000 0.000000 0.000000', 'Ks 0.000000 0.000000 0.000000', 'illum 1', ''];
    })
  ].join('\n');
  const obj = [
    '# GRID SOUL image-to-voxel relief; coordinate values are expressed in millimeters.',
    '# A visual 2.5D image slab, not certified engineering CAD.',
    'mtllib gridsoul-image.mtl',
    ...objVertices,
    ...objFaces,
    ''
  ].join('\n');
  const warnings = [];
  if (gap > 1e-8) warnings.push('Espaçamento maior que zero gera cubos separados; use 0% para uma chapa voxelizada conectada.');
  if (Math.min(dx * (1 - gap), dy * (1 - gap), depth) < 0.4) warnings.push('Há células abaixo de 0,4 mm; avalie resolução, bico, material e tolerâncias do processo antes de imprimir.');
  warnings.push('STL não armazena cores. OBJ/MTL guarda materiais de pré-visualização; nem todos os slicers convertem MTL em separação por material.');
  warnings.push('STL/OBJ não garantem metadados de unidade: confira e ajuste a escala ao importar; confirme malha, espessura, cama, pontes, retração e tolerâncias no CAD/slicer. Exportar não é certificação industrial.');
  return {
    stl,
    obj,
    mtl,
    triangleCount,
    polygonCount: triangleCount / 2,
    vertexCount: objVertices.length,
    materialCount: materialNames.size,
    cellCount: populated,
    boundsMm: { width: widthMm, height: heightMm, depth },
    warnings,
  };
}
