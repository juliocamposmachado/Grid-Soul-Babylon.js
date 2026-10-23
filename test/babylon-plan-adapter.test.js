import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptGridSoulPlan, createBabylonInstanceSamplePlan } from '../public/babylon-plan-adapter.js';

test('adapta o plano legado sem descartar reply, faceProfile nem partes', () => {
  const faceProfile = { face: { orientation: 'frontal' } };
  const materials = { preset: 'copper', albedo: '#B87333', metallic: 0.92, roughness: 0.26 };
  const parts = [{ kind: 'box', x: 1, y: 2, z: 3, sx: 1, sy: 1, sz: 1 }];
  const plan = adaptGridSoulPlan({
    reply: 'Plano persistido', shape: 'custom', population: 88_000,
    energy: 0.7, scale: 2.5, cubeSize: 1.2, rotationX: 1.1,
    moveY: -2, color: '#42B8FF', paletteMode: 'plasma',
    focusedAtomicNumber: 26, materials, parts, faceProfile
  });
  assert.equal(plan.reply, 'Plano persistido');
  assert.equal(plan.shape, 'custom');
  assert.equal(plan.population, 88_000);
  assert.equal(plan.energy, 0.7);
  assert.equal(plan.scale, 2.5);
  assert.equal(plan.cubeSize, 1.2);
  assert.equal(plan.rotationX, 1.1);
  assert.equal(plan.moveY, -2);
  assert.equal(plan.color, '#42B8FF');
  assert.equal(plan.paletteMode, 'plasma');
  assert.equal(plan.focusedAtomicNumber, 26);
  assert.equal(plan.materials, materials);
  assert.notEqual(plan.parts, parts);
  assert.deepEqual(plan.parts, parts);
  assert.equal(plan.faceProfile, faceProfile);
});

test('aceita os limites documentados de população, incluindo 88.000 e 500.000', () => {
  assert.equal(adaptGridSoulPlan({ population: 88_000 }).population, 88_000);
  assert.equal(adaptGridSoulPlan({ population: 500_000 }).population, 500_000);
  assert.equal(adaptGridSoulPlan({ population: 10 }).population, 1_000);
  assert.equal(adaptGridSoulPlan({ population: 900_000 }).population, 500_000);
});

test('normaliza valores numéricos inválidos e opções cromáticas sem gerar NaN', () => {
  const plan = adaptGridSoulPlan({
    energy: 'not-a-number', scale: Infinity, cubeSize: -1,
    rotationY: NaN, moveX: 100, color: 'red', paletteMode: 'remote-code',
    focusedAtomicNumber: 119, parts: 'invalid'
  });
  assert.equal(plan.energy, 0.6);
  assert.equal(plan.scale, 1);
  assert.equal(plan.cubeSize, 0.35);
  assert.equal(plan.rotationY, 0);
  assert.equal(plan.moveX, 10);
  assert.equal(plan.color, '#35eaff');
  assert.equal(plan.paletteMode, 'chemical');
  assert.equal(plan.focusedAtomicNumber, null);
  assert.deepEqual(plan.parts, []);
  for (const key of ['energy', 'scale', 'cubeSize', 'rotationX', 'rotationY', 'rotationZ', 'moveX', 'moveY', 'moveZ']) {
    assert.ok(Number.isFinite(plan[key]), `${key} deve ser finito`);
  }
});

test('usa campos geometry aninhados de planos antigos quando a chave plana não existe', () => {
  const plan = adaptGridSoulPlan({ geometry: { shape: 'face', population: 88_000, scale: 2.5 } });
  assert.equal(plan.shape, 'face');
  assert.equal(plan.population, 88_000);
  assert.equal(plan.scale, 2.5);
  assert.equal(plan.paletteMode, 'face');
});

test('o LOD cobre regularmente 500.000 slots sem alterar a população lógica', () => {
  const plan = createBabylonInstanceSamplePlan(500_000, 100_000);
  assert.equal(plan.requested, 500_000);
  assert.equal(plan.count, 100_000);
  assert.equal(plan.step, 5);
  assert.equal(plan.sourceIndex(0), 0);
  assert.equal(plan.sourceIndex(1), 5);
  assert.equal(plan.sourceIndex(99_999), 499_995);
});

test('mantém todas as amostras do rosto e a sequência completa dentro do orçamento', () => {
  const face = createBabylonInstanceSamplePlan(88_000, 100_000);
  assert.equal(face.count, 88_000);
  assert.equal(face.sourceIndex(87_999), 87_999);
  const all = createBabylonInstanceSamplePlan(500_000, 500_000);
  assert.equal(all.count, 500_000);
  assert.equal(all.sourceIndex(499_999), 499_999);
});
