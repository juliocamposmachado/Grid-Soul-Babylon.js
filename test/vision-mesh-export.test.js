import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoxelMeshFiles } from '../public/vision-mesh-export.js';

function smallAnalysis() {
  return {
    swarm: {
      columns: 2,
      rows: 2,
      physicalWidthMm: 20,
      physicalHeightMm: 20,
      samples: [
        [-0.25, 0.25, 255, 0, 0, 0], [0.25, 0.25, 0, 255, 0, 0],
        [-0.25, -0.25, 0, 0, 255, 0], [0.25, -0.25, 255, 255, 255, 0],
      ],
    },
  };
}

test('STL e OBJ representam uma placa voxelizada fechada com mm e materiais MTL', () => {
  const files = buildVoxelMeshFiles(smallAnalysis(), { gapPercent: 0, depthMm: 2 });
  assert.equal(files.cellCount, 4);
  assert.equal(files.materialCount, 4);
  assert.equal(files.boundsMm.width, 20);
  assert.equal(files.boundsMm.height, 20);
  assert.equal(files.boundsMm.depth, 2);
  assert.equal(files.triangleCount, 32, 'quatro pixels cobrem as faces superiores/inferiores e oito paredes de perímetro');
  const stlBytes = Buffer.from(files.stl);
  assert.equal(stlBytes.readUInt32LE(80), files.triangleCount);
  assert.equal(files.stl.length, 84 + files.triangleCount * 50);
  assert.equal(stlBytes.toString('ascii', 0, 11), 'GRID SOUL v');
  assert.equal(stlBytes.readFloatLE(84 + 8), 1, 'normal do primeiro triângulo aponta para +Z');
  assert.equal(stlBytes.readFloatLE(84 + 2 * 50 + 8), -1, 'normal do primeiro triângulo inferior aponta para -Z');
  assert.match(files.obj, /mtllib gridsoul-image\.mtl/);
  assert.match(files.obj, /v -10 10 1/);
  assert.match(files.obj, /usemtl pixel_FF0000/);
  assert.match(files.obj, /\nf \d+ \d+ \d+ \d+/);
  assert.match(files.mtl, /newmtl pixel_00FF00/);
  assert.match(files.mtl, /Kd 0\.000000 1\.000000 0\.000000/);
});

test('gap positivo exporta cubos desconectados e registra o aviso de continuidade', () => {
  const files = buildVoxelMeshFiles(smallAnalysis(), { gapPercent: 10, depthMm: 1.2 });
  assert.equal(files.triangleCount, 48, 'quatro cubos isolados possuem seis faces quad cada');
  assert.ok(files.warnings.some(warning => /cubos separados/.test(warning)));
  assert.ok(files.warnings.some(warning => /STL não armazena cores/.test(warning)));
});

test('amostras inválidas e populações acima do limite não são exportadas', () => {
  assert.throws(() => buildVoxelMeshFiles({}), /Analise uma imagem/);
  const tooMany = { swarm: { columns: 25_001, rows: 1, physicalWidthMm: 1, physicalHeightMm: 1, samples: Array.from({ length: 25_001 }, () => [0, 0, 0, 0, 0]) } };
  assert.throws(() => buildVoxelMeshFiles(tooMany), /até 25\.000 células/);
});
