/**
 * Deterministic pseudo-random utilities for the synthetic corpus generator.
 *
 * Everything the generator produces is a pure function of `config.db.seed`, so
 * two runs on two machines produce byte-identical corpora. That matters because
 * the trained model artifacts are committed to git: if the corpus drifted, the
 * reported metrics would no longer be reproducible.
 */

/** mulberry32 — small, fast, good enough distribution for corpus generation. */
export function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    next,
    /**
     * Zero-argument uniform [0, 1) generator.
     *
     * This is the form every algorithm in server/ml/ takes. Passing `rng.float`
     * instead would be a silent bug: called with no bounds it returns NaN, and a
     * NaN index produces a silent `undefined` rather than an error.
     */
    unit: next,
    /** Uniform float in [min, max). */
    float: (min, max) => min + next() * (max - min),
    /** Uniform integer in [min, max] inclusive. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** True with probability p. */
    chance: (p) => next() < p,
    pick: (array) => array[Math.floor(next() * array.length)],
    /** Sample `count` distinct members (or fewer if the array is small). */
    sample: (array, count) => {
      const pool = [...array];
      const out = [];
      const n = Math.min(count, pool.length);
      for (let i = 0; i < n; i += 1) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      return out;
    },
    /** Approximately normal via the sum of 3 uniforms (Bates). */
    normal: (mean, stdDev) => {
      const u = (next() + next() + next()) / 3;
      return mean + (u - 0.5) * 3.4641 * stdDev;
    },
    /** Shifted geometric-ish integer draw, useful for skewed magnitudes. */
    skew: (min, max, power = 2) => {
      const u = next() ** power;
      return Math.round(min + u * (max - min));
    },
    shuffle: (array) => {
      const out = [...array];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
}

export const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// --- Unit conversions -------------------------------------------------------
// Drilling reports mix several conventions and the NLP normaliser has to agree
// with the generator on every one of them.
//
//   pressure gradient  G [psi/ft]  =  ppg * 0.0518894  =  SG * 0.433
//   mud weight         W [ppg]      =  G / 0.0518894
//   specific gravity   SG           =  ppg / 8.345
//   hydrostatic press. P [psi]      =  ppg * 0.0518894 * depth[ft]

export const PpgPerPsiPerFt = 1 / 0.0518894; // ≈ 19.27

/** Gradient in psi/ft → equivalent mud weight in ppg. 0.48 psi/ft → 9.25 ppg. */
export const gradientToPpg = (psiPerFt) => psiPerFt * PpgPerPsiPerFt;
/** Mud weight in ppg → gradient in psi/ft. */
export const ppgToGradient = (ppg) => ppg * 0.0518894;
/** Gradient in psi/ft → gradient in SG/ft (how gradients are usually quoted). */
export const gradientToSgPerFt = (psiPerFt) => psiPerFt / 0.433;

export const ppgToPsi = (ppg, depthFt) => ppg * 0.0518894 * depthFt;
export const psiToPpg = (psi, depthFt) => (depthFt > 0 ? psi / (0.0518894 * depthFt) : 0);
export const ppgToSg = (ppg) => ppg / 8.345;
export const sgToPpg = (sg) => sg * 8.345;
export const metresToFeet = (m) => m * 3.28084;
export const feetToMetres = (ft) => ft / 3.28084;
export const psiToBar = (psi) => psi * 0.0689476;
export const knmToLbft = (knm) => knm * 737.56;

/** Normalise a casing size written as a fraction into a float inch value. */
export function parseFraction(text) {
  if (typeof text !== 'string') return text;
  const whole = /^(\d+)\s*(\d+)?\s*\/\s*(\d+)/.exec(text);
  if (!whole) return Number(text);
  return Number(whole[1]) + Number(whole[2]) / Number(whole[3]);
}