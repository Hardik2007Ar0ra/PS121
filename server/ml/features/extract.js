/**
 * Depth-context feature extraction.
 *
 * This module is the single definition of what the models see. It is called
 * both when building training rows and when scoring a live depth, so the
 * feature vectors are byte-identical in both paths — the single most common way
 * a production ML system silently breaks.
 *
 * Two design rules worth stating explicitly:
 *
 *  1. **Self-normalising where possible.** Raw torque means different things at
 *     1,500 m and 4,000 m, so the model gets both the absolute value and a
 *     ratio to the well's own trailing behaviour. The same holds for ROP, flow
 *     and gas ratio. This is what lets a model trained on 48 wells transfer to
 *     the 49th.
 *
 *  2. **Offset-well history is a feature, not a separate lookup.** The rates in
 *     `formationPriors` are supplied by the caller from nearby wells, so the
 *     model learns "formations where offset wells have historically lost mud are
 *     more dangerous here" as one more signal rather than as a hand-written
 *     rule. The prior can be inspected, and the model can be compared with and
 *     without it.
 */

import { round } from '../../seeds/generator/random.js';

export const FEATURE_VERSION = 'v1.0.0';

const ROLLING_WINDOW = 20; // samples ≈ 100 m at a 5 m depth increment
const SLOPE_WINDOW = 12; // samples ≈ 60 m for trend features

/**
 * The feature contract. Order matters: it is stored in every model artifact and
 * asserted at load time, so adding a feature requires a new FEATURE_VERSION.
 */
export const FEATURE_NAMES = [
  // Depth and hole geometry
  'depth_m',
  'depth_fraction_of_td',
  'inclination_deg',
  'dogleg_deg_per_30m',
  'azimuth_sin',
  'azimuth_cos',
  'hole_size_in',
  'section_no',
  'metres_into_formation',
  'metres_to_formation_top',

  // Mud balance
  'mud_weight_ppg',
  'ecd_ppg',
  'pore_pressure_gradient_ppg',
  'fracture_gradient_ppg',
  'overbalance_ppg',
  'fracture_margin_ppg',
  'is_underbalanced',
  'is_overbalanced_ecd',
  'mud_system_oil_based',
  'lcm_present',
  'lcm_ppb',

  // Downhole signals
  'd_exponent',
  'normalised_d_exponent',
  'd_exponent_trend',
  'lithology_index',
  'formation_pore_risk',

  // Surface dynamics
  'torque_knm',
  'drag_knm',
  'torque_ratio_local',
  'drag_ratio_local',
  'rop_mhr',
  'rop_ratio_local',
  'wob_ton',
  'hook_load_ton',
  'spp_psi',
  'torque_drag_ratio',
  'hook_load_ratio_local',

  // Fluid returns
  'flow_out_lpm',
  'flow_deficit_lpm',
  'pit_volume_m3',
  'pit_trend_m3_per_m',
  'gas_ratio_ppm',
  'gas_ratio_ratio_local',

  // Offset-well history (the NWIS signal)
  'prior_event_rate',
  'prior_loss_rate',
  'prior_kick_rate',
  'prior_stuck_rate',
  'prior_severity_p90',
  'prior_offset_wells_with_events',
];

const EPS = 1e-6;

// --- Small statistical helpers ------------------------------------------------

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Ordinary least squares slope of `values` against their index. */
function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < EPS) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

function trailingWindow(samples, index, key, window) {
  const values = [];
  const start = Math.max(0, index - window);
  for (let i = start; i < index; i += 1) {
    const value = samples[i][key];
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  return values;
}

/**
 * Ratio of the current value to the well's own recent behaviour, with an
 * absolute-value fallback when there is not yet enough history. Without the
 * fallback, the first 100 m of every well would produce NaN and be dropped,
 * silently biasing the training set toward deeper depths.
 */
function localRatio(current, history) {
  if (history.length < 3) return 1;
  const reference = median(history);
  if (Math.abs(reference) < EPS) return 1;
  return current / reference;
}

// --- Programme context --------------------------------------------------------

function buildDepthContext(well, sections) {
  // Current hole section at each depth: the deepest section already started.
  const boundaries = sections
    .filter((section) => section.hole_size_in)
    .map((section) => ({ ...section, startMd: section.top_md_m ?? 0 }));

  return (depth) => {
    let current = boundaries[0];
    for (const section of boundaries) {
      if (depth >= section.startMd) current = section;
      else break;
    }
    return current;
  };
}

// --- Main entry point ---------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.well     generator well (tops, sections, mudPrograms, td_md_m)
 * @param {Array}  input.samples  depth-indexed telemetry for this well
 * @param {Array}  input.sections casing sections
 * @param {Record<string, object>} [input.formationPriors] keyed by formation code
 * @returns {Array<{depthMd:number, formationCode:string, formationName:string, values:Record<string,number>}>}
 */
export function buildFeaturesForWell({ well, samples, sections, formationPriors = {} }) {
  const sectionAt = buildDepthContext(well, sections || well.sections || []);
  const mudPrograms = well.mudPrograms || [];
  const mudAt = (depth) =>
    mudPrograms.find((p) => depth >= p.interval_from_md_m && depth <= p.interval_to_md_m) ||
    mudPrograms[mudPrograms.length - 1] ||
    null;
  const topAt = (depth) =>
    well.tops.find((t) => depth >= t.top_md_m && depth <= t.base_md_m) ||
    well.tops.find((t) => t.base_md_m >= depth) ||
    well.tops[well.tops.length - 1];

  const td = Math.max(1, well.td_md_m);
  const emptyPrior = {
    eventRate: 0,
    lossRate: 0,
    kickRate: 0,
    stuckRate: 0,
    severityP90: 0,
    offsetWellsWithEvents: 0,
  };

  return samples.map((sample, index) => {
    const depth = sample.depth_md_m;
    const top = topAt(depth);
    const mud = mudAt(depth);
    const section = sectionAt(depth);

    const ppPpg = sample._ppPpg ?? top.ppPpg;
    const fgPpg = sample._fgPpg ?? top.fgPpg;
    const mudPpg = sample.mud_weight_ppg ?? mud?.density_ppg ?? 0;
    const ecd = sample.ecd_ppg ?? mudPpg;

    const torqueHistory = trailingWindow(samples, index, 'torque_knm', ROLLING_WINDOW);
    const dragHistory = trailingWindow(samples, index, 'drag_knm', ROLLING_WINDOW);
    const ropHistory = trailingWindow(samples, index, 'rop_mhr', ROLLING_WINDOW);
    const flowHistory = trailingWindow(samples, index, 'flow_out_lpm', ROLLING_WINDOW);
    const hookHistory = trailingWindow(samples, index, 'hook_load_ton', ROLLING_WINDOW);
    const gasHistory = trailingWindow(samples, index, 'gas_ratio_ppm', ROLLING_WINDOW);
    const pitHistory = trailingWindow(samples, index, 'pit_volume_m3', ROLLING_WINDOW);

    const dExpHistory = [];
    for (let i = Math.max(0, index - SLOPE_WINDOW); i < index; i += 1) {
      if (typeof samples[i]._dExponent === 'number') dExpHistory.push(samples[i]._dExponent);
    }

    const flowBaseline = flowHistory.length >= 3 ? median(flowHistory) : sample.flow_out_lpm;
    const prior = formationPriors[top.formationCode] || emptyPrior;

    const formationTopMd = top.top_md_m;
    const azimuth = sample.azimuth_deg ?? 0;

    const values = {
      depth_m: round(depth, 1),
      depth_fraction_of_td: round(depth / td, 4),
      inclination_deg: round(sample.inclination_deg ?? sample._inclination ?? 0, 2),
      dogleg_deg_per_30m: round(sample.dogleg_deg_per_30m ?? sample._dogleg ?? 0, 2),
      // Azimuth is circular; sin/cos encoding avoids a 359° → 1° discontinuity
      // that a linear feature would present to the model as a huge jump.
      azimuth_sin: round(Math.sin((azimuth * Math.PI) / 180), 4),
      azimuth_cos: round(Math.cos((azimuth * Math.PI) / 180), 4),
      hole_size_in: section?.hole_size_in ?? 12.25,
      section_no: section?.section_no ?? 1,
      metres_into_formation: round(depth - formationTopMd, 1),
      metres_to_formation_top: round(formationTopMd - depth, 1),

      mud_weight_ppg: round(mudPpg, 3),
      ecd_ppg: round(ecd, 3),
      pore_pressure_gradient_ppg: round(ppPpg, 3),
      fracture_gradient_ppg: round(fgPpg, 3),
      overbalance_ppg: round(mudPpg - ppPpg, 3),
      fracture_margin_ppg: round(fgPpg - ecd, 3),
      is_underbalanced: mudPpg - ppPpg < 0.2 ? 1 : 0,
      is_overbalanced_ecd: ecd > fgPpg - 0.4 ? 1 : 0,
      mud_system_oil_based: mud && (mud.system === 'OBM' || mud.system === 'PBM') ? 1 : 0,
      lcm_present: mud?.lcm_type ? 1 : 0,
      lcm_ppb: round(mud?.lcm_ration_ppb ?? 0, 2),

      d_exponent: round(sample._dExponent ?? 0, 3),
      normalised_d_exponent: round(sample._normalisedD ?? 0, 3),
      // A flat or falling d-exponent through a shale break is the textbook
      // overpressure signal; the slope captures it directly.
      d_exponent_trend: round(dExpHistory.length >= 3 ? slope(dExpHistory) * 20 : 0, 5),
      lithology_index: round(top.instabilityProneness ?? 0, 3),
      // Combines the unit's own instability with the pressure window it leaves:
      // a shale with little window between pore and fracture gradient is worse
      // than either extreme on its own.
      formation_pore_risk: round((top.instabilityProneness ?? 0) * ((top.fgGradient ?? 0) - (top.ppGradient ?? 0)), 3),

      torque_knm: round(sample.torque_knm ?? 0, 3),
      drag_knm: round(sample.drag_knm ?? 0, 3),
      torque_ratio_local: round(localRatio(sample.torque_knm ?? 0, torqueHistory), 4),
      drag_ratio_local: round(localRatio(sample.drag_knm ?? 0, dragHistory), 4),
      rop_mhr: round(sample.rop_mhr ?? 0, 3),
      rop_ratio_local: round(localRatio(sample.rop_mhr ?? 0, ropHistory), 4),
      wob_ton: round(sample.wob_ton ?? 0, 3),
      hook_load_ton: round(sample.hook_load_ton ?? 0, 3),
      spp_psi: round(sample.spp_psi ?? 0, 1),
      torque_drag_ratio: round((sample.torque_knm ?? 0) / Math.max(EPS, sample.drag_knm ?? 1), 4),
      hook_load_ratio_local: round(localRatio(sample.hook_load_ton ?? 0, hookHistory), 4),

      flow_out_lpm: round(sample.flow_out_lpm ?? 0, 2),
      // Positive means less returning than the well's own recent norm — the
      // signature of fluid leaving the system.
      flow_deficit_lpm: round(flowBaseline - (sample.flow_out_lpm ?? 0), 2),
      pit_volume_m3: round(sample.pit_volume_m3 ?? 0, 3),
      pit_trend_m3_per_m: round(pitHistory.length >= 4 ? slope(pitHistory) : 0, 5),
      gas_ratio_ppm: round(sample.gas_ratio_ppm ?? 0, 1),
      gas_ratio_ratio_local: round(localRatio(sample.gas_ratio_ppm ?? 0, gasHistory), 4),

      prior_event_rate: round(prior.eventRate, 4),
      prior_loss_rate: round(prior.lossRate, 4),
      prior_kick_rate: round(prior.kickRate, 4),
      prior_stuck_rate: round(prior.stuckRate, 4),
      prior_severity_p90: round(prior.severityP90, 3),
      prior_offset_wells_with_events: round(prior.offsetWellsWithEvents, 2),
    };

    return {
      depthMd: round(depth, 1),
      formationCode: top.formationCode,
      formationName: top.formationName,
      values,
    };
  });
}

/** Extracts the feature vector in FEATURE_NAMES order, filling gaps with 0. */
export function toVector(values) {
  return FEATURE_NAMES.map((name) => {
    const value = values[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });
}

/** Builds the named view of a vector, for model inspection and debugging. */
export function vectorToObject(vector) {
  return FEATURE_NAMES.reduce((acc, name, index) => ({ ...acc, [name]: vector[index] }), {});
}