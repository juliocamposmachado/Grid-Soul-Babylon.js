import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

test('módulo embutido da interface tem sintaxe válida e mantém os contratos químico e facial', () => {
  const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/i);
  assert.ok(moduleMatch, 'interface deve conter o módulo principal');
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: moduleMatch[1],
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stderr || 'sintaxe inválida no módulo principal');
  assert.match(html, /gridSoulBuildIdentityMap\(CAPACITY\)/);
  assert.match(html, /gridSoulReferenceFacePointForCube\(i,n,referenceFaceAtlas,faceProfile\?\.face\?\.orientation\)/);
  assert.match(html, /gridSoulReferenceFaceColorForCube\(i,active,referenceFaceAtlas\)/);
  assert.match(html, /new GridSoulBabylonStage\(primaryCanvas,renderMetrics/);
  assert.match(html, /adaptGridSoulPlan\(rawPlan\)/);
  assert.match(html, /<canvas id="primaryCanvas"/);
  assert.match(html, /id="fitViewButton"/);
  assert.match(html, /mainRenderer\.setFitBounds\(/);
  assert.match(html, /mainRenderer\.fitView\(true\)/);
  assert.match(html, /dummy\.position\.set\(target\[offset\],target\[offset\+1\],target\[offset\+2\]\)\.applyEuler\(rotation\)\.add\(move\)/);
  assert.doesNotMatch(html, /new THREE\.WebGLRenderer/);
  assert.doesNotMatch(html, /OrbitControls/);
  assert.match(html, /await ensureReferenceFaceAtlas\(\)/);
  assert.match(html, /gridSoulBuildFacialRegions\(population,referenceFaceAtlas\)/);
  assert.match(html, /gridSoulEyeBlinkAmount\(faceElapsedMs\)/);
  assert.match(html, /gridSoulTalkAmount\(faceElapsedMs\)/);
  assert.match(html, /eyeScaleY=1-eyeWeight\*\.9/);
  assert.match(html, /mouthSides\[i\]\*opening/);
  assert.ok(html.includes("faceProfile.face.orientation='frontal'"));
  assert.match(html, /if\(shape==='face'\)return/);
  assert.match(html, /somente com cubos instanciados e cores da referência/);
  assert.doesNotMatch(html, /gridSoulFace(?:Point|Color)ForCube/);
  assert.match(html, /faceProfile\?\.geometry\?\.grid\?\.size\|\|\.025/);
  assert.match(html, /if\(referenceFaceAtlas\)return 0/);
  assert.match(html, /applyFaceProfileAppearance\(/);
  assert.match(html, /cubeAtomicNumbers\[i\] - 1/);
  assert.match(html, /gridSoulColorForAtomicNumber\(atomicNumber\)/);
  assert.match(html, /repeat\(18,minmax\(0,1fr\)\)/);
  assert.match(html, /<details open>/);
  assert.match(html, /value="2000"/);
  assert.match(html, /function openShowcase\(/);
  assert.match(html, /value="face">Rosto — cores da referência/);
  assert.match(html, /JSON\.stringify\(\{message,population:active,energy,scale,cubeSize\}\)/);
  assert.match(html, /id="cubeSize"/);
  assert.match(html, /id="visionPanel"/);
  assert.match(html, /id="visionAnnotations"/);
  assert.match(html, /get\('demo'\)==='1'/);
  assert.equal((html.match(/stage\.addEventListener\('pointerdown',function\(event\)/g) || []).length, 1);
  assert.doesNotMatch(html, /GRID_SOUL_CLICK_WAKE_GUARD_V1/);
});

test('palco Babylon usa PBR e thin instances, mantém um único loop de render principal', () => {
  const renderer = readFileSync(path.join(ROOT, 'public/babylon-stage.js'), 'utf8');
  assert.match(renderer, /import '\/vendor\/babylon\/Meshes\/thinInstanceMesh\.js'/);
  assert.match(renderer, /new Engine\(this\.canvas/);
  assert.match(renderer, /new ArcRotateCamera/);
  assert.match(renderer, /new PBRMaterial/);
  assert.match(renderer, /this\.swarmMaterial\.albedoColor = hexColor\(albedo\)/);
  assert.match(renderer, /thinInstanceSetBuffer\('matrix'/);
  assert.match(renderer, /thinInstanceSetBuffer\('color'/);
  assert.match(renderer, /thinInstanceBufferUpdated\('matrix'\)/);
  assert.match(renderer, /this\.scene\.render\(\)/);
  assert.doesNotMatch(renderer, /runRenderLoop\(/);
  assert.match(renderer, /MAX_POPULATION = 500_000/);
  assert.match(renderer, /this\.adaptiveBudget/);
  assert.match(renderer, /this\.frameWindowFrames/);
  assert.match(renderer, /onContextLostObservable/);
  assert.match(renderer, /onContextRestoredObservable/);
  assert.match(renderer, /applyFitBounds\(\)/);
  assert.match(renderer, /horizontalFov/);
  assert.match(renderer, /this\.userCameraAdjusted/);
  assert.match(renderer, /setFitBounds\(minimum, maximum, padding = 0\.0275\)/);
  assert.match(renderer, /performanceTarget = Math\.max\(minimumVisible, Math\.floor\(\(this\.active \* 0\.75\) \/ 10_000\) \* 10_000\)/);
  assert.match(renderer, /if \(this\.adaptiveBudget !== previousBudget\) \{[\s\S]*?this\.renderCount = this\.getRenderPlan\(this\.active\)\.count/);
  assert.match(renderer, /new WebGPUEngine/);
  assert.match(renderer, /navigator\.gpu\.requestAdapter\(\)/);
  assert.match(renderer, /new Engine\(this\.canvas/);
});
