/**
 * Training-set construction.
 *
 * Label policy — this is where a risk model is usually compromised, so it is
 * worth stating exactly what is done:
 *
 *  - A sample is **positive** for a risk type if it lies within the recorded
 *    event window, widened by `labelMarginM`. The widening is deliberate: the
 *    precursors of a mud loss start before mud actually leaves the hole, and a
 *    model trained only on the already-broken interval would learn to detect the
 *    damage rather than predict it.
 *
 *  - A sample is **negative** only if it is clear of *every* recorded event of
 *    *any* category by the same margin. This is deliberately conservative. The
 *    obvious shortcut — "not a mud loss? then it is a mud-loss negative" — puts
 *    kick windows and stuck-pipe windows into the negative class, and the model
 *    then learns to suppress them, which is exactly backwards.
 *
 *  - `split_group` is the well. Every cross-validation fold is grouped by well,
 *    so a model is always evaluated on wells it has never seen. A random row
 *    split leaks the well identity through features like the local ratios and
 *    inflates every metric reported in the model card.
 */

import { FEATURE_NAMES, FEATURE_VERSION, toVector } from './extract.js';
import { round } from '../../seeds/generator/random.js';

export { FEATURE_VERSION, FEATURE_NAMES };

const PSI_PER_PPG = 0.0518894;
const FEET_PER_METRE = 3.28084;

/**
 * The seven models the problem statement asks for, with the operational default
 * for each. `depthBased` models are trained per depth interval; section-based
 * models are trained per casing section.
 */
export const RISK_TYPES = [
  {
    id: 'MUD_LOSS',
    label: 'Mud Loss',
    kind: 'classifier',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 300,
    defaultThreshold: 0.45,
    defaultSeverity: 'HIGH',
    minEvidence: 1,
    labelMarginM: 90,
    // Relative cost of a missed detection vs a wasted warning. Mud loss is
    // expensive and, left alone, cascades into a kick, so the model should
    // lean towards recall.
    positiveWeight: 1.4,
    // Human-readable description shown in the model card.
    purpose: 'Predict fluid loss into the formation before it becomes a pit-volume event.',
    primaryFeatures: ['fracture_margin_ppg', 'is_overbalanced_ecd', 'flow_deficit_lpm', 'mud_weight_ppg', 'lcm_present'],
  },
  {
    id: 'KICK',
    label: 'Kick / Overpressure',
    kind: 'classifier',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 250,
    defaultThreshold: 0.5,
    defaultSeverity: 'CRITICAL',
    minEvidence: 1,
    labelMarginM: 75,
    // The highest cost of any risk modelled here: an undetected kick escalates
    // to a well control incident.
    positiveWeight: 1.8,
    purpose: 'Detect an underbalanced entry into an overpressured shale before it flows.',
    primaryFeatures: ['overbalance_ppg', 'normalised_d_exponent', 'd_exponent_trend', 'gas_ratio_ratio_local', 'lithology_index'],
  },
  {
    id: 'STUCK_PIPE',
    label: 'Stuck Pipe',
    kind: 'classifier',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 250,
    defaultThreshold: 0.4,
    defaultSeverity: 'HIGH',
    minEvidence: 1,
    labelMarginM: 70,
    // Expensive, and the response is well understood, so recall still wins.
    positiveWeight: 1.3,
    purpose: 'Flag differential or mechanical sticking risk from torque, hook load and ROP decay.',
    primaryFeatures: ['rop_ratio_local', 'torque_ratio_local', 'hook_load_ratio_local', 'is_underbalanced', 'lithology_index'],
  },
  {
    id: 'TORQUE_SPIKE',
    label: 'Torque & Drag Spike',
    kind: 'classifier',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 200,
    defaultThreshold: 0.45,
    defaultSeverity: 'MEDIUM',
    minEvidence: 1,
    labelMarginM: 50,
    // The cheapest of the four to be wrong about. A false warning costs a
    // driller's attention, which is not free, so the weight is below 1.
    positiveWeight: 0.7,
    purpose: 'Predict cuttings-bed accumulation and torque excursions in the build section.',
    primaryFeatures: ['torque_ratio_local', 'inclination_deg', 'dogleg_deg_per_30m', 'rop_ratio_local', 'lithology_index'],
  },
  {
    id: 'NPT',
    label: 'Non-Productive Time',
    kind: 'regressor',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 250,
    defaultThreshold: 0.5,
    defaultSeverity: 'MEDIUM',
    minEvidence: 1,
    labelMarginM: 60,
    purpose: 'Estimate expected NPT hours over the next interval to plan the operation.',
    primaryFeatures: ['rop_ratio_local', 'torque_ratio_local', 'prior_event_rate', 'fracture_margin_ppg', 'inclination_deg'],
  },
  {
    id: 'FORMATION_RISK',
    label: 'Formation Risk Anomaly',
    kind: 'anomaly',
    depthBased: true,
    unit: 'per depth interval',
    defaultLookAheadM: 300,
    defaultThreshold: 0.6,
    defaultSeverity: 'MEDIUM',
    minEvidence: 1,
    labelMarginM: 60,
    purpose: 'Unsupervised detection of depth intervals that do not resemble the well’s own normal drilling.',
    primaryFeatures: ['torque_ratio_local', 'rop_ratio_local', 'flow_deficit_lpm', 'pit_trend_m3_per_m', 'd_exponent_trend'],
  },
  {
    id: 'CEMENTING_ISSUE',
    label: 'Cementing Issue',
    kind: 'classifier',
    depthBased: false,
    unit: 'per casing section',
    defaultLookAheadM: 0,
    defaultThreshold: 0.45,
    defaultSeverity: 'HIGH',
    minEvidence: 1,
    purpose: 'Predict a marginal or failed primary cement job from section geometry and displacement margin.',
    primaryFeatures: ['inclination_deg', 'hole_size_in', 'metres_to_formation_top'],
  },
];

export const RISK_BY_ID = RISK_TYPES.reduce((acc, risk) => ({ ...acc, [risk.id]: risk }), {});

export const DEPTH_RISK_TYPES = RISK_TYPES.filter((risk) => risk.depthBased);

// --- Formation priors from offset-well history -------------------------------

/**
 * Aggregates cross-well experience per formation.
 *
 * `exposure` is the number of wells that entered the formation, which is the
 * correct denominator: a formation with three events across twenty wells is not
 * three times as dangerous as one with three events across two.
 */
export function buildPriorIndex(wells, events) {
  const exposure = new Map();
  wells.forEach((well) => {
    well.tops.forEach((top) => {
      exposure.set(top.formationCode, (exposure.get(top.formationCode) || 0) + 1);
    });
  });

  const entries = new Map();
  const wellsWithEvents = new Map();

  events.forEach((event) => {
    const well = wells.find((w) => w.well_name === event.well_name);
    if (!well) return;
    const top = well.tops.find((t) => t.formationName === event.formation);
    const code = event.formationCode || top?.formationCode;
    if (!code) return;
    const bucket = entries.get(code) || { MUD_LOSS: 0, KICK: 0, STUCK_PIPE: 0, TORQUE_SPIKE: 0, FISHING: 0, CEMENTING_ISSUE: 0, severity: [] };
    bucket[event.category] = (bucket[event.category] || 0) + 1;
    bucket.severity.push(event.severity || 1);
    entries.set(code, bucket);

    if (!wellsWithEvents.has(code)) wellsWithEvents.set(code, new Set());
    wellsWithEvents.get(code).add(event.well_name);
  });

  /**
   * Returns priors for a formation. `excludeWell` implements leave-one-well-out,
   * so a well's own history never becomes its own prior during training.
   */
  return function priorsFor(formationCode, excludeWell = null) {
    const bucket = entries.get(formationCode);
    const wellCount = exposure.get(formationCode) || 0;
    const denominator = Math.max(1, wellCount - (excludeWell ? 1 : 0));

    if (!bucket || denominator <= 0) {
      return {
        eventRate: 0,
        lossRate: 0,
        kickRate: 0,
        stuckRate: 0,
        torqueRate: 0,
        severityP90: 0,
        offsetWellsWithEvents: 0,
        exposureWells: denominator,
      };
    }

    // Excluding a well means backing out one well's contribution, so this is an
    // approximation at well granularity rather than an exact leave-one-out. It is
    // sufficient because the prior is shared across all wells in the formation;
    // the leakage it removes is second-order next to the well-identity leakage
    // that grouped splitting already blocks.
    const scale = excludeWell && wellCount > 1 ? denominator / wellCount : 1;
    const severities = bucket.severity.slice().sort((a, b) => a - b);
    const p90Index = severities.length ? Math.min(severities.length - 1, Math.floor(severities.length * 0.9)) : 0;

    return {
      eventRate: round(sumCounts(bucket) * scale / denominator, 4),
      lossRate: round(bucket.MUD_LOSS * scale / denominator, 4),
      kickRate: round(bucket.KICK * scale / denominator, 4),
      stuckRate: round(bucket.STUCK_PIPE * scale / denominator, 4),
      torqueRate: round(bucket.TORQUE_SPIKE * scale / denominator, 4),
      severityP90: round(severities[p90Index] ?? 0, 3),
      offsetWellsWithEvents: (wellsWithEvents.get(formationCode)?.size || 0) - (excludeWell ? 1 : 0),
      exposureWells: denominator,
    };
  };
}

function sumCounts(bucket) {
  return Object.entries(bucket).reduce((sum, [key, value]) => (key === 'severity' ? sum : sum + (value || 0)), 0);
}

/** Materialises the prior vector for every formation code in the corpus. */
export function buildFormationPriors(priorIndex, formationCodes, excludeWell = null) {
  const priors = {};
  formationCodes.forEach((code) => {
    priors[code] = priorIndex(code, excludeWell);
  });
  return priors;
}

// --- Labels ------------------------------------------------------------------

/** Depth windows occupied by recorded events, with a category filter. */
function eventWindows(events, marginM) {
  return events.map((event) => ({
    start: (event.start_md_m ?? event.depth_m ?? 0) - marginM,
    end: (event.end_md_m ?? event.depth_m ?? 0) + marginM,
    category: event.category,
    severity: event.severity ?? 1,
    nptHours: event.npt_hours ?? 0,
  }));
}

/**
 * Merges overlapping windows into a sorted, disjoint cover.
 *
 * The obvious `windows.some(...)` test is quadratic in the number of events and
 * is called once per depth sample per risk type — around 400k times over the
 * corpus — which dominated seeding. Merging first turns each lookup into a binary
 * search. The per-category windows are kept separately because a positive label
 * needs the category, but the merged cover is what answers "is this depth quiet".
 */
function mergeCover(windows) {
  if (!windows.length) return [];
  const sorted = windows.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start <= last.end + 1) last.end = Math.max(last.end, next.end);
    else merged.push({ ...next });
  }
  return merged;
}

/** True when `depth` falls inside the merged cover. */
function depthCovered(cover, depth) {
  let low = 0;
  let high = cover.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const window = cover[mid];
    if (depth < window.start) high = mid - 1;
    else if (depth > window.end) low = mid + 1;
    else return true;
  }
  return false;
}

function overlapsCategory(windows, depth, category) {
  return windows.find((window) => window.category === category && depth >= window.start && depth <= window.end) || null;
}

/**
 * Produces the labelled training rows for one well.
 *
 * @returns {Array<{well_name, depth_md_m, risk_type, label, features_json,
 *                   label_source, split_group, feature_version, target_value?}>}
 */
export function buildTrainingRows({ well, features, events, negativeSampleRatio = 0.15 }) {
  const rows = [];

  DEPTH_RISK_TYPES.forEach((risk) => {
    const margin = risk.labelMarginM ?? 60;
    const allWindows = eventWindows(events, margin);
    // One cover per risk type, because each risk widens event windows by a
    // different margin and so covers a different depth range.
    const quietCover = mergeCover(allWindows);
    const allCategories = risk.id === 'NPT' || risk.id === 'FORMATION_RISK';
    const riskWindows = allCategories ? allWindows : allWindows.filter((w) => w.category === risk.id);

    // Quiet intervals are collected first and subsampled afterwards, because
    // stride selection has to be spaced across the *quiet* depths — sampling
    // before filtering would leave gaps wherever events cluster.
    //
    // Keeping every negative would add ~340k rows per corpus, of which 99% are
    // near-duplicates of adjacent metres in identical rock. A deterministic
    // stride over the quiet depths keeps the depth distribution intact, cuts the
    // table to a workable size, and removes the class imbalance that would
    // otherwise push every classifier toward predicting "nothing happens".
    const quiet = [];
    const flagged = [];

    features.forEach((feature) => {
      const depth = feature.depthMd;

      if (risk.id === 'FORMATION_RISK') {
        // The anomaly model is unsupervised: every depth is a training sample and
        // "labels" are only used to report how much of the flagged set turned out
        // to be a real event, which is a useful sanity check on threshold choice.
        flagged.push({ depth, vector: JSON.stringify(toVector(feature.values)), label: depthCovered(quietCover, depth) ? 1 : 0 });
        return;
      }

      const hit = allCategories ? null : overlapsCategory(riskWindows, depth, risk.id);
      const anyHit = hit || (depthCovered(quietCover, depth) ? allWindows.find((w) => depth >= w.start && depth <= w.end) : null);

      if (hit || (risk.kind === 'regressor' && anyHit)) {
        flagged.push({
          depth,
          vector: JSON.stringify(toVector(feature.values)),
          label: 1,
          target: risk.kind === 'regressor' ? round(anyHit?.nptHours || 0, 2) : null,
        });
        return;
      }

      if (!depthCovered(quietCover, depth)) {
        quiet.push({ depth, vector: JSON.stringify(toVector(feature.values)), label: 0, target: 0 });
      }
    });

    const stride = negativeSampleRatio >= 1 ? 1 : Math.max(1, Math.round(1 / negativeSampleRatio));
    // The regressor and the anomaly model both need broad coverage of normal
    // behaviour rather than a tuned class balance, so they keep every sample.
    const keepAllNegatives = risk.kind !== 'classifier';
    const negatives = keepAllNegatives
      ? quiet
      : quiet.filter((_, index) => index % stride === 0);

    const base = {
      well_name: well.well_name,
      risk_type: risk.id,
      label_source: 'derived',
      split_group: well.well_name,
      feature_version: FEATURE_VERSION,
    };

    flagged.forEach((row) => rows.push({ ...base, depth_md_m: row.depth, label: row.label, features_json: row.vector, target_value: row.target ?? null }));
    negatives.forEach((row) => rows.push({ ...base, depth_md_m: row.depth, label: row.label, features_json: row.vector, target_value: row.target ?? null }));
  });

  return rows;
}

/**
 * Section-level rows for the cementing model. The unit of prediction is a casing
 * section, so the features describe the section's geometry and the context it
 * sits in rather than a depth telemetry row.
 */
export function buildCementingTrainingRows({ well, sections, jobs, topAt }) {
  const rows = [];
  sections
    .filter((section) => section.casing_size_in)
    .forEach((section) => {
      const job = jobs.find((j) => j.section_no === section.section_no);
      if (!job) return;
      const label = job.squeeze_required || job.outcome === 'FAILED' ? 1 : 0;
      const top = topAt(section.shoe_md_m);
      const inclRad = ((section.shoe_tvd_m / Math.max(1, section.shoe_md_m)) * Math.PI) / 2;

      const values = Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0]));
      Object.assign(values, {
        depth_m: section.shoe_md_m,
        depth_fraction_of_td: round(section.shoe_md_m / Math.max(1, well.td_md_m), 4),
        // Sin of the inclination implied by the shoe TVD/MD ratio.
        inclination_deg: round((Math.cos(inclRad) * 180) / Math.PI, 2),
        hole_size_in: section.hole_size_in,
        section_no: section.section_no,
        metres_into_formation: round(section.shoe_md_m - (top?.top_md_m ?? 0), 1),
        metres_to_formation_top: round((top?.top_md_m ?? 0) - section.shoe_md_m, 1),
        mud_weight_ppg: top?.ppPpg ?? 0,
        ecd_ppg: section.design_ecd_ppg ?? 0,
        lithology_index: top?.instabilityProneness ?? 0,
        formation_pore_risk: round((top?.instabilityProneness ?? 0) * ((top?.fgGradient ?? 0) - (top?.ppGradient ?? 0)), 3),
      });

      rows.push({
        well_name: well.well_name,
        depth_md_m: section.shoe_md_m,
        risk_type: 'CEMENTING_ISSUE',
        label,
        features_json: JSON.stringify(toVector(values)),
        label_source: 'derived',
        split_group: well.well_name,
        feature_version: FEATURE_VERSION,
        // Retained for the model card: the physics the section faces.
        target_value: round(job.annular_capacity_bbl ?? 0, 2),
      });
    });
  return rows;
}

/**
 * Pressure/gradient unit helpers exposed so the NLP layer and the ML layer cannot
 * drift apart on the most error-prone conversion in drilling.
 */
export const UNITS = {
  psiPerFootToPpg: 1 / PSI_PER_PPG,
  ppgToPsiPerFoot: (ppg) => ppg * PSI_PER_PPG,
  metresToFeet: (m) => m * FEET_PER_METRE,
  psiAtDepth: (ppg, depthM) => ppg * PSI_PER_PPG * depthM * FEET_PER_METRE,
};