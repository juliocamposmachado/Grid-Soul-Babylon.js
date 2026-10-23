const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};
const finite = (value, fallback = 0, min = -1e6, max = 1e6) => clamp(value, min, max, fallback);
const HEX_COLOR = /^#[\da-f]{6}$/i;
const PALETTES = new Set(['chemical', 'single', 'rainbow', 'plasma', 'fire', 'green', 'cyan', 'face']);
const MAX_POPULATION = 500_000;

/** Maps the established JSON contract to bounded renderer-facing values without calling AI. */
export function adaptGridSoulPlan(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const shapeValue = source.shape ?? source.geometry?.shape ?? source.form ?? 'cloud';
  const shape = String(shapeValue).slice(0, 40) || 'cloud';
  const population = Math.round(clamp(source.population ?? source.geometry?.population, 1_000, MAX_POPULATION, 2_000));
  const paletteValue = source.paletteMode;
  const paletteMode = PALETTES.has(paletteValue) ? paletteValue : (shape === 'face' ? 'face' : 'chemical');
  const color = typeof source.color === 'string' && HEX_COLOR.test(source.color) ? source.color : '#35eaff';
  const parts = Array.isArray(source.parts) ? source.parts.slice(0, 128) : [];
  const focus = Number(source.focusedAtomicNumber);
  return {
    ...source,
    shape,
    population,
    energy: clamp(source.energy, 0, 1, 0.6),
    scale: clamp(source.scale ?? source.geometry?.scale, 0.5, 8, 1),
    cubeSize: clamp(source.cubeSize, 0.35, 2.5, 1),
    rotationX: finite(source.rotationX),
    rotationY: finite(source.rotationY),
    rotationZ: finite(source.rotationZ),
    moveX: finite(source.moveX, 0, -10, 10),
    moveY: finite(source.moveY, 0, -10, 10),
    moveZ: finite(source.moveZ, 0, -10, 10),
    color,
    parts,
    paletteMode,
    focusedAtomicNumber: Number.isInteger(focus) && focus >= 1 && focus <= 118 ? focus : null
  };
}

/** Uniform deterministic visual LOD: logical slots and atomic identities remain unchanged. */
export function createBabylonInstanceSamplePlan(population, budget = MAX_POPULATION) {
  const requested = Math.round(clamp(population, 0, MAX_POPULATION, 0));
  const cap = Math.max(1, Math.round(clamp(budget, 1, MAX_POPULATION, MAX_POPULATION)));
  const count = Math.min(requested, cap);
  return {
    requested,
    count,
    step: count ? requested / count : 1,
    sourceIndex(slot) {
      const index = Math.floor(clamp(slot, 0, Math.max(0, count - 1), 0) * requested / Math.max(1, count));
      return Math.min(Math.max(0, requested - 1), index);
    }
  };
}
