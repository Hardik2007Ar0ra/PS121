/**
 * Drilling dynamics for the synthetic corpus: mud programmes, cementing jobs,
 * depth-indexed surface telemetry, derived downhole signals, and the
 * operational events that follow from them.
 *
 * The critical design rule of this file is that **labels must be causally
 * derived from the features**. A mud loss is emitted because the generated ECD
 * actually crossed the generated fracture gradient in a loss-prone unit — not
 * because a random draw produced the label "mud loss". Without that, the ML
 * models would learn noise and every reported metric would be meaningless.
 */

import { round, gradientToPpg } from './random.js';

const STEP_M = 5; // telemetry depth increment
const MUD_SYSTEMS = ['WBM', 'WBM', 'WBM', 'WBM', 'OBM', 'PBM'];
const ADDITIVES = [
  'Barite (API 4.2)',
  'Bentonite low-solids',
  'PAC-L enhanced',
  'KCl-PAC inhibition package',
  'Sodium silicate',
  'Biocide / lubricant package',
];
const LCMS = [
  'Nut-based LCM',
  'Gilsonite / coke blend',
  'Cellulose + fibre LCM',
  'Activated carbon LCM',
  null,
];

// --- Mud programmes ---------------------------------------------------------

export function buildMudPrograms(rng, well) {
  const programs = [];
  // A per-well mud-weight bias. Positive is conservative, negative is
  // underbalanced and creates kick risk. This single parameter generates a
  // realistic spread of kick and loss behaviour across the fleet.
  const bias = rng.normal(0, 0.62);
  const aggressive = rng.chance(0.22);

  well.tops.forEach((top, index) => {
    const from = index === 0 ? 0 : round(well.tops[index - 1].base_md_m, 0);
    const to = round(top.base_md_m, 0);
    const ppPpg = gradientToPpg(top.ppGradient);

    let densityPpg = ppPpg + 0.55 + bias;
    if (aggressive) densityPpg += 0.9 + rng.float(0, 0.5);
    // Engineers weight up entering a shale above the target.
    if (top.instabilityProneness > 0.7) densityPpg += rng.float(0.2, 0.7);
    // ...and lighten up entering a depleted or fractured sand, because a heavy
    // mud there fractures the formation and starts a loss. This is the central
    // mud-weight dilemma: the same unit that takes fluid at one weight kicks at
    // another, so the corridor between pore and fracture gradient is often
    // narrower than the interval needs. Where the step-down is large enough the
    // interval ends up underbalanced, which is how kicks arise in practice —
    // not from a random draw but from a defensible programming decision.
    if (top.lossProneness > 0.55) densityPpg -= rng.float(0.35, 1.35);
    densityPpg = Math.max(8.6, round(densityPpg, 2));

    const system = rng.pick(MUD_SYSTEMS);
    const needsLcm = top.lossProneness > 0.5;
    const lcm = needsLcm && rng.chance(0.7) ? rng.pick(LCMS.filter(Boolean)) : rng.chance(0.25) ? rng.pick(LCMS.filter(Boolean)) : null;

    programs.push({
      well_name: well.well_name,
      interval_from_md_m: from,
      interval_to_md_m: to,
      depth_reference: 'MD',
      system,
      fluid_type: system === 'OBM' ? 'Oil based' : system === 'PBM' ? 'Polymer brine' : 'Water based',
      density_ppg: densityPpg,
      funnel_viscosity_s: system === 'OBM' ? rng.float(38, 52) : rng.float(38, 52),
      pv_cp: system === 'OBM' ? rng.float(14, 22) : rng.float(9, 18),
      yp_lbf_100ft2: rng.float(7, 17),
      ph: system === 'OBM' ? rng.float(8.4, 9.2) : rng.float(8.6, 10.2),
      filtration_ml_30min: round(rng.float(2, 12) * (system === 'OBM' ? 0.15 : 1), 1),
      lcm_type: lcm,
      lcm_ration_ppb: lcm ? round(rng.float(4, 18), 1) : 0,
      additive: rng.pick(ADDITIVES),
      inhibitiveness_note: top.instabilityProneness > 0.7
        ? `Inhibitive package required through ${top.formationName} (shale section).`
        : null,
      formationCode: top.formationCode,
      ppPpg: round(ppPpg, 2),
      fgPpg: round(gradientToPpg(top.fgGradient), 2),
    });
  });
  return programs;
}

// --- Cementing jobs ---------------------------------------------------------

export function buildCementingJobs(rng, well) {
  const jobs = [];
  well.sections
    .filter((section) => section.casing_size_in)
    .forEach((section) => {
      const isProducer = section.section_no >= 4;
      const annularCapacity = round(section.shoe_md_m * 0.62 * (1 - (section.casing_size_in || 9.625) / 40), 1);
      const requiredVolume = round(annularCapacity * rng.float(1.15, 1.6), 1);

      // Deeper, tighter sections are where displacement problems happen.
      const difficulty = Math.min(1, section.section_no / 6) * (well.trajectoryPlan.type === 'VERTICAL' ? 0.6 : 1.25);
      const failureProb = 0.04 + difficulty * 0.22;
      const squeeze = rng.chance(failureProb * 0.6);
      const failed = !squeeze && rng.chance(failureProb * 0.55);

      jobs.push({
        well_name: well.well_name,
        section_no: section.section_no,
        job_date: shiftDate(well.spud_date, rng.int(3, 210)),
        job_type: squeeze || failed ? 'REMEDIAL' : 'PRIMARY',
        cement_system: isProducer ? 'Class G with extender blend' : 'Class A / Class G lead-tail',
        lead_volume_bbl: round(requiredVolume * rng.float(0.35, 0.5), 1),
        tail_volume_bbl: round(requiredVolume * rng.float(0.5, 0.72), 1),
        spacers_volume_bbl: round(rng.float(15, 60), 1),
        flush_volume_bbl: round(rng.float(8, 24), 1),
        u_tubing_bbl: round(Math.max(0, annularCapacity * rng.float(0.05, 0.35)), 1),
        displacement_efficiency_pct: round(Math.max(38, 96 - difficulty * 42 - rng.float(0, 14)), 1),
        annular_capacity_bbl: annularCapacity,
        wait_on_cement_min: rng.int(6, 22) * 60,
        squeeze_required: squeeze ? 1 : 0,
        outcome: failed ? 'FAILED' : squeeze ? 'SATISFACTORY' : rng.chance(0.88) ? 'SUCCESS' : 'SATISFACTORY',
        remarks: failed
          ? 'Channeling observed on cement log across the upper interval; remedial squeeze required.'
          : squeeze
            ? 'Displacement efficiency below programme target; remedial squeeze job performed.'
            : 'Cement log indicates bonding across the cemented interval.',
      });
    });
  return jobs;
}

function shiftDate(iso, days) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Depth-indexed telemetry ------------------------------------------------

/**
 * Produces the full downhole depth series for a well and, in the same pass, the
 * operational events implied by that series.
 */
export function buildDynamics(rng, well, { mudPrograms, surveys }) {
  const samples = [];
  const mudAt = (depth) => {
    const program =
      mudPrograms.find((p) => depth >= p.interval_from_md_m && depth <= p.interval_to_md_m) ||
      mudPrograms[mudPrograms.length - 1];
    return program;
  };
  const topAt = (depth) =>
    well.tops.find((t) => depth >= t.top_md_m && depth <= t.base_md_m) ||
    well.tops.find((t) => t.base_md_m >= depth) ||
    well.tops[well.tops.length - 1];
  const surveyAt = (depth) => {
    const md = Math.max(0, depth);
    let lo = 0;
    let hi = surveys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (surveys[mid].md_m < md) lo = mid + 1;
      else hi = mid;
    }
    return surveys[lo];
  };

  // How badly this well is balanced. Set once so it is stable down the hole.
  const balanceBias = rng.normal(0, 0.55);
  const holeCondition = rng.float(0.72, 1.28); // >1 means a rougher hole
  let torqueState = rng.float(0.9, 1.15);
  let gasState = rng.float(0.8, 1.2);
  let dExpState = rng.float(0.95, 1.05);

  // Slow random walk so the series looks like a real log rather than noise.
  const walk = (value, step, min, max) => {
    value += rng.normal(0, step);
    return Math.min(max, Math.max(min, value));
  };

  const startDepth = 120;
  const dtHours = 0.35; // ≈ 12.5 m/day of drilling at 5 m depth increments
  for (let depth = startDepth; depth <= well.td_md_m; depth += STEP_M) {
    const mud = mudAt(depth);
    const top = topAt(depth);
    const survey = surveyAt(depth);
    const depthFt = depth * 3.28084;
    const inclination = survey ? survey.inclination_deg : 0;
    const dogleg = survey ? survey.dogleg_deg_per_30m : 0;

    const mudPpg = mud.density_ppg + walk(0, 0.012, -0.18, 0.18);
    // Formation tops carry gradients in psi/ft; equivalent mud weight is
    // psi/ft / 0.0518894. Converting here (once) keeps every downstream feature
    // in ppg, which is the unit the mud programme and telemetry are in.
    const ppPpg = gradientToPpg(top.ppGradient);
    const fgPpg = gradientToPpg(top.fgGradient);

    // Friction and tilt both grow with hole length and inclination.
    const frictionPpg = 0.28 + depth * 0.00062 + (mud.system === 'OBM' ? -0.12 : 0.08);
    const tiltPpg = 0.24 * Math.sin((inclination * Math.PI) / 180);
    const ecdPpg = mudPpg + frictionPpg + tiltPpg;

    const overbalancePpg = mudPpg - ppPpg;
    const fractureMarginPpg = fgPpg - ecdPpg;

    const shaleFactor = top.instabilityProneness;
    torqueState = walk(torqueState, 0.018, 0.75, 1.5);
    gasState = walk(gasState, 0.03, 0.6, 1.8);

    // Torque rises with depth, hole angle, dogleg severity and hole roughness.
    const torqueBase = 7.5 + depth * 0.0042;
    const angleFactor = 1 + (inclination / 45) * 1.35;
    const doglegFactor = 1 + Math.min(0.9, dogleg * 0.055);
    const torque = torqueBase * angleFactor * doglegFactor * torqueState * holeCondition * rng.float(0.95, 1.06);
    const drag = torque * rng.float(1.02, 1.18) * (1 + inclination / 160);

    const ropBase = 26 - depth * 0.0038 - shaleFactor * 7;
    const rop = Math.max(2.2, ropBase * rng.float(0.86, 1.14) * (shaleFactor > 0.75 ? 0.72 : 1));
    const wob = round(Math.max(2, 9 + depth * 0.0022 + inclination * 0.06), 2);
    const rpm = Math.round(80 + rng.float(0, 45));
    const flowRate = round(640 + rop * 24 + rng.float(-40, 40), 0);

    const spp = round(
      Math.max(0, ecdPpg * 0.0518894 * depthFt - mudPpg * 0.0518894 * depthFt + 340 + depth * 0.55 + rng.float(-22, 22)),
      0,
    );
    const flowBit = round((flowRate / 60 / Math.PI / (12.25 / 24) ** 2) * 1000 * 0.82, 0);
    const hookLoad = round(wob * 1.9 + 120 + depth * 0.012, 1);

    // d-exponent rises in shale, falls on sand, and fails to rise through an
    // overpressured transition — the classic overpressure signature.
    const expectedD = 1 + shaleFactor * 0.55;
    const dExponent = round(expectedD * dExpState * (0.72 + overbalancePpg * 0.42) + rng.normal(0, 0.03), 3);
    const normalisedD = round(dExponent / (0.72 + overbalancePpg * 0.42), 3);

    const gasRatio = Math.round((45 + rng.float(0, 60)) * gasState * (1 + shaleFactor * 0.9));
    const pitVolume = round(142 + rng.float(-2, 2), 1);
    const flowOut = round(640 + rop * 24 + rng.float(-30, 30), 0);

    // One sample every `dtHours` of drilling, anchored at the well's spud date,
    // so telemetry timestamps are consistent with the well's drilling window
    // rather than all wells sharing a single arbitrary epoch.
    const spud = well.spud_date ? Date.parse(`${well.spud_date}T06:00:00Z`) : Date.UTC(2024, 0, 1);
    const elapsedHours = samples.length * dtHours;

    samples.push({
      well_name: well.well_name,
      ts: new Date(spud + elapsedHours * 3_600_000).toISOString(),
      depth_md_m: round(depth, 1),
      bit_depth_md_m: round(Math.max(0, depth - rng.float(4, 18)), 1),
      torque_knm: round(torque, 2),
      drag_knm: round(drag, 2),
      rop_mhr: round(rop, 2),
      wob_ton: wob,
      rpm,
      hook_load_ton: hookLoad,
      spp_psi: Math.round(spp),
      flow_out_lpm: flowOut,
      pit_volume_m3: pitVolume,
      mud_weight_ppg: round(mudPpg, 3),
      ecd_ppg: round(ecdPpg, 3),
      flow_bit_ms: flowBit,
      gas_ratio_ppm: gasRatio,
      source: 'generator',
      // Not stored in the telemetry table; carried for feature building and
      // event detection, then stripped before insert.
      _formation: top.formationCode,
      _formationName: top.formationName,
      _top: top,
      _inclination: round(inclination, 2),
      _dogleg: round(dogleg, 2),
      _ppPpg: ppPpg,
      _fgPpg: fgPpg,
      _fractureMargin: round(fractureMarginPpg, 3),
      _overbalance: round(overbalancePpg, 3),
      _dExponent: dExponent,
      _normalisedD: normalisedD,
      _lossProneness: top.lossProneness,
      _instabilityProneness: top.instabilityProneness,
    });
  }

  // Anomalies that must be *detected*, not injected as labels: the detector
  // below finds them the same way a rule-based real-time system would.
  injectLossEpisodes(rng, samples);
  injectKickEpisodes(rng, samples);
  injectTorqueSpikes(rng, samples);
  injectPackOffEpisodes(rng, samples);

  const events = detectEvents(rng, well, samples);
  const trajectoryFeatures = samples.map((s) => ({
    well_name: well.well_name,
    depth_md_m: s.depth_md_m,
    formationCode: s._formation,
    d_exponent: s._dExponent,
    lithology_index: round(s._instabilityProneness, 3),
    normalised_d_exponent: s._normalisedD,
    overbalance_flag: s._overbalance < 0 ? 1 : 0,
    underbalance_flag: s._overbalance < 0.15 ? 1 : 0,
  }));

  return { samples, events, trajectoryFeatures, mudAt, topAt, surveyAt };
}

// --- Anomaly injection ------------------------------------------------------
// Each injector edits the telemetry only. Nothing marks "this is an event" —
// detection has to find it.

/**
 * Chooses `count` episode anchors that do not overlap, returned as
 * `[sampleIndex, sample]` pairs.
 *
 * Sampling independently would let two incidents land on the same metres of
 * hole, which superimposes their effects and leaves the ground truth ambiguous:
 * the detector would then have to guess which of the overlapping channels drove
 * the log entry. Non-overlapping placement keeps every event attributable.
 *
 * Returns fewer anchors than asked for when there are not enough separated
 * candidate positions — a well with one short loss-prone interval gets one
 * episode, not a fabricated five.
 */
function pickEpisodeAnchors(rng, samples, predicate, count, minGap) {
  if (count <= 0) return [];

  // Positions in `samples`, not in the filtered list, so the overlap test is
  // expressed in the same units as the injector loop below.
  const positions = [];
  samples.forEach((sample, index) => {
    if (predicate(sample)) positions.push(index);
  });
  if (!positions.length) return [];

  const chosen = [];
  let nextAllowed = -1;
  // Bounded retries rather than unbounded: with the gap enforced most draws are
  // rejected once the well fills up, and an unbounded loop would spin.
  for (let attempt = 0; attempt < count * 60 && chosen.length < count; attempt += 1) {
    const position = positions[rng.int(0, positions.length - 1)];
    if (position < nextAllowed) continue;
    chosen.push({ sample: samples[position], sampleIndex: position });
    nextAllowed = position + minGap;
  }
  return chosen;
}

function injectLossEpisodes(rng, samples) {
  const isCandidate = (s) => s._fractureMargin < 0.55 && s._lossProneness > 0.35 && s.depth_md_m > 600;
  const candidateCount = samples.filter(isCandidate).length;
  // ~3 losses per well where the geology supports them. Real wells do lose mud
  // repeatedly; a single event per well would leave too few positives to train
  // or evaluate a classifier honestly.
  const episodeCount = Math.min(9, Math.floor(candidateCount / 40));

  pickEpisodeAnchors(rng, samples, isCandidate, episodeCount, 45).forEach(({ sampleIndex: idx }) => {
    const length = rng.int(8, 26);
    // Above the detector's 0.45 trigger, so every injected episode is recovered
    // by detection. The base rate then comes from the injector rather than from
    // the threshold, and the two can be checked against each other.
    const severity = rng.float(0.5, 1);
    for (let k = 0; k < length && idx + k < samples.length; k += 1) {
      const s = samples[idx + k];
      const taper = Math.sin((Math.PI * (k + 1)) / (length + 1));
      s._lossIntensity = Math.max(s._lossIntensity || 0, severity * taper);
      // Mud volume leaves the system: flow-out drops and the pit drops.
      s.flow_out_lpm = round(s.flow_out_lpm - s._lossIntensity * rng.float(14, 46), 1);
      s.pit_volume_m3 = round(s.pit_volume_m3 - s._lossIntensity * rng.float(0.5, 3.4), 2);
      s.spp_psi = Math.round(s.spp_psi - s._lossIntensity * rng.float(20, 90));
      s.rop_mhr = round(Math.max(1, s.rop_mhr - s._lossIntensity * rng.float(3, 9)), 2);
    }
  });
}

function injectKickEpisodes(rng, samples) {
  const isCandidate = (s) => s._overbalance < 0.28 && s._instabilityProneness > 0.4 && s.depth_md_m > 500;
  const candidateCount = samples.filter(isCandidate).length;
  const episodeCount = Math.min(8, Math.floor(candidateCount / 20));

  pickEpisodeAnchors(rng, samples, isCandidate, episodeCount, 40).forEach(({ sampleIndex: idx }) => {
    const length = rng.int(5, 18);
    // Above the detector's 0.50 trigger for the same reason as mud loss.
    const severity = rng.float(0.55, 1);
    for (let k = 0; k < length && idx + k < samples.length; k += 1) {
      const s = samples[idx + k];
      const ramp = Math.min(1, (k + 1) / Math.max(2, length * 0.4));
      s._kickIntensity = Math.max(s._kickIntensity || 0, severity * ramp);
      s.gas_ratio_ppm = Math.round(s.gas_ratio_ppm * (1 + s._kickIntensity * rng.float(3, 12)));
      s.flow_out_lpm = round(s.flow_out_lpm + s._kickIntensity * rng.float(20, 70), 1);
      s.pit_volume_m3 = round(s.pit_volume_m3 + s._kickIntensity * rng.float(0.6, 3.8), 2);
      // d-exponent stops rising or falls — the overpressure signature.
      s._dExponent = round(s._dExponent * (1 - s._kickIntensity * rng.float(0.1, 0.28)), 3);
      s._normalisedD = round(s._dExponent / (0.72 + s._overbalance * 0.42), 3);
    }
  });
}

function injectTorqueSpikes(rng, samples) {
  const isCandidate = (s) => s._inclination > 6 && s.depth_md_m > 700;
  const spikeCount = Math.min(10, Math.floor(samples.filter(isCandidate).length / 40));

  pickEpisodeAnchors(rng, samples, isCandidate, spikeCount, 18).forEach(({ sampleIndex: idx }) => {
    // A spike below 0.55 would be logged as routine and is therefore not an
    // event; the floor keeps injection and detection consistent.
    const magnitude = rng.float(0.55, 1.05);
    const width = rng.int(3, 11);
    for (let k = 0; k < width && idx + k < samples.length; k += 1) {
      const s = samples[idx + k];
      const taper = Math.exp(-((k - width / 2) ** 2) / (2 * (width / 3) ** 2));
      s._torqueAnomaly = Math.max(s._torqueAnomaly || 0, magnitude * taper);
      s.torque_knm = round(s.torque_knm * (1 + magnitude * taper * rng.float(0.25, 0.7)), 2);
      s.drag_knm = round(s.drag_knm * (1 + magnitude * taper * rng.float(0.3, 0.8)), 2);
      s.rop_mhr = round(Math.max(1.5, s.rop_mhr * (1 - taper * rng.float(0.15, 0.5))), 2);
      s.hook_load_ton = round(s.hook_load_ton * (1 + taper * rng.float(0.02, 0.12)), 1);
    }
  });
}

function injectPackOffEpisodes(rng, samples) {
  // Differential sticking: high torque plus low ROP plus an underbalanced,
  // filter-plugging mud. Detected by combining conditions, not by one channel.
  const isCandidate = (s) => s._instabilityProneness > 0.45 && s._overbalance > 0.1 && s.depth_md_m > 900;
  const count = Math.min(7, Math.floor(samples.filter(isCandidate).length / 70));

  pickEpisodeAnchors(rng, samples, isCandidate, count, 70).forEach(({ sampleIndex: idx }) => {
    const length = rng.int(14, 40);
    // Above the detector's 0.60 trigger.
    const severity = rng.float(0.65, 1);
    for (let k = 0; k < length && idx + k < samples.length; k += 1) {
      const s = samples[idx + k];
      const ramp = Math.min(1, (k + 1) / (length * 0.35));
      s._packOff = Math.max(s._packOff || 0, severity * ramp);
      s.rop_mhr = round(Math.max(0.4, s.rop_mhr * (1 - s._packOff * rng.float(0.45, 0.9))), 2);
      s.torque_knm = round(s.torque_knm * (1 + s._packOff * rng.float(0.1, 0.35)), 2);
      s.hook_load_ton = round(s.hook_load_ton * (1 + s._packOff * rng.float(0.03, 0.18)), 1);
    }
  });
}

// --- Detection --------------------------------------------------------------

/**
 * Rule-based detection over the generated telemetry. These thresholds are the
 * "ground truth" definition of an event; the ML models later have to recover
 * the same signal from a *subset* of features, which is what makes the
 * evaluation meaningful.
 *
 * Episodes are claimed as whole sample ranges. Deduplicating on the start index
 * alone is not enough: an injected anomaly spans 14-40 consecutive samples, so
 * without range claiming every sample inside one physical incident opens its own
 * "event". That inflated one stuck-pipe episode into ~30 rows and taught the
 * models a base rate roughly two orders of magnitude too high.
 */
function detectEvents(rng, well, samples) {
  const events = [];
  // Disjoint, sorted [start, end) ranges already attributed to an event.
  const claimed = [];

  const isClaimed = (index) => claimed.some(([start, end]) => index >= start && index < end);
  const claimRange = (start, end) => {
    claimed.push([start, end]);
    claimed.sort((a, b) => a[0] - b[0]);
  };

  samples.forEach((sample, idx) => {
    if (isClaimed(idx)) return;

    if (sample._lossIntensity >= 0.45) {
      const intensity = peakOf(samples, idx, '_lossIntensity', 16);
      // Claim the full anomaly footprint so neighbouring samples cannot re-open
      // the same loss as a fresh incident.
      claimRange(idx, idx + Math.round(8 + intensity * 34));
    }

    if (sample._lossIntensity >= 0.45) {
      const intensity = peakOf(samples, idx, '_lossIntensity', 14);
      const severity = Math.min(5, Math.max(1, Math.round(intensity * 5)));
      const from = round(sample.depth_md_m, 0);
      const to = round(sample.depth_md_m + intensity * 90, 0);
      events.push({
        well_name: well.well_name,
        category: 'MUD_LOSS',
        event_type: intensity > 0.8 ? 'Mud Loss (severe)' : intensity > 0.6 ? 'Mud Loss' : 'Mud Loss (minor)',
        subtype: sample._lossProneness > 0.6 ? 'Fractured / vuggy zone' : 'Depleted sand',
        formation: sample._formationName,
        formationCode: sample._formation,
        start_md_m: from,
        end_md_m: to,
        depth_m: from,
        depth_reference: 'MD',
        severity,
        npt_hours: round(2 + intensity * 34, 1),
        volume_loss_bbl: round(intensity * rng.float(18, 130), 1),
        root_cause:
          sample._fractureMargin < 0.2
            ? 'ECD exceeded the estimated fracture gradient while circulating out of a loss-prone unit.'
            : 'Thief zone / fractured formation taking mud; ECD margin below programme limit.',
        action_taken:
          intensity > 0.7
            ? 'Circulated bottoms-up, pumped a high-concentration LCM pill, reduced ECD by conditioning the mud and drilling ahead at reduced ROP.'
            : 'Reduced ROP, monitored pit volume and flow-out for one circulation and continued drilling ahead after the pit stabilised.',
        action_outcome:
          intensity > 0.7 ? (rng.chance(0.7) ? 'WORKED' : 'PARTLY_WORKED') : 'WORKED',
        source_label: null, // assigned once documents exist
      });
    }

    if (sample._kickIntensity >= 0.5) {
      const intensity = peakOf(samples, idx, '_kickIntensity', 12);
      const severity = Math.min(5, Math.max(2, Math.round(intensity * 4.6)));
      claimRange(idx, idx + Math.round(6 + intensity * 16));
      events.push({
        well_name: well.well_name,
        category: 'KICK',
        event_type: intensity > 0.85 ? 'Kick (significant influx)' : 'Kick',
        subtype: 'Underbalanced shale entry',
        formation: sample._formationName,
        formationCode: sample._formation,
        start_md_m: round(sample.depth_md_m, 0),
        end_md_m: round(sample.depth_md_m + intensity * 45, 0),
        depth_m: round(sample.depth_md_m, 0),
        depth_reference: 'MD',
        severity,
        npt_hours: round(3 + intensity * 26, 1),
        volume_loss_bbl: null,
        root_cause: `Mud weight was ${Math.abs(round(sample._overbalance, 2))} ppg under the estimated pore pressure entering ${sample._formationName}. d-exponent failed to increase through the shale break.`,
        action_taken:
          'Flow check was positive; well shut in, kick tolerance and kill weight calculated, and the influx circulated out with the appropriate LCM pill.',
        action_outcome: rng.chance(0.82) ? 'WORKED' : 'PARTLY_WORKED',
        source_label: null,
      });
    }

    if (sample._torqueAnomaly >= 0.55) {
      const magnitude = peakOf(samples, idx, '_torqueAnomaly', 9);
      claimRange(idx, idx + 9);
      events.push({
        well_name: well.well_name,
        category: 'TORQUE_SPIKE',
        event_type: magnitude > 0.8 ? 'Torque Spike' : 'High Torque',
        subtype: sample._dogleg > 2 ? 'Dogleg / build section' : 'Hole angle related',
        formation: sample._formationName,
        formationCode: sample._formation,
        start_md_m: round(sample.depth_md_m, 0),
        end_md_m: round(sample.depth_md_m + 40, 0),
        depth_m: round(sample.depth_md_m, 0),
        depth_reference: 'MD',
        severity: Math.min(5, Math.max(1, Math.round(magnitude * 4.2))),
        npt_hours: round(0.5 + magnitude * 7, 1),
        volume_loss_bbl: null,
        root_cause: `Cuttings bed accumulation through a ${sample._inclination.toFixed(0)}° section with ${sample._dogleg.toFixed(1)}°/30 m dogleg.`,
        action_taken:
          'Reduced WOB, circulated a high-viscosity sweep, increased rotation to clean the annulus and reamed back to the last clean depth.',
        action_outcome: rng.chance(0.85) ? 'WORKED' : 'PARTLY_WORKED',
        source_label: null,
      });
    }

    if (sample._packOff >= 0.6) {
      const intensity = peakOf(samples, idx, '_packOff', 18);
      claimRange(idx, idx + Math.round(14 + intensity * 30));
      events.push({
        well_name: well.well_name,
        category: 'STUCK_PIPE',
        event_type: intensity > 0.82 ? 'Stuck Pipe (differential)' : 'Differential Sticking',
        subtype: 'Filter cake / differential pressure sticking',
        formation: sample._formationName,
        formationCode: sample._formation,
        start_md_m: round(sample.depth_md_m, 0),
        end_md_m: round(sample.depth_md_m + intensity * 60, 0),
        depth_m: round(sample.depth_md_m, 0),
        depth_reference: 'MD',
        severity: Math.min(5, Math.max(2, Math.round(intensity * 4.8))),
        npt_hours: round(6 + intensity * 46, 1),
        volume_loss_bbl: null,
        root_cause: 'Filter cake plugging the annulus against a permeable shale while the string sat static.',
        action_taken:
          'Stopped rotation, circulated the string within operating limits, released overpull, then worked the pipe free after soaking with an anti-differential-sticking treatment.',
        action_outcome: rng.chance(0.78) ? 'WORKED' : rng.chance(0.6) ? 'PARTLY_WORKED' : 'FAILED',
        source_label: null,
      });

      // A stuck-pipe failure is followed by a fishing job, which is one of the
      // event classes the problem statement names explicitly.
      if (events[events.length - 1].action_outcome === 'FAILED' && rng.chance(0.75)) {
        const depth = round(sample.depth_md_m + intensity * 60, 0);
        events.push({
          well_name: well.well_name,
          category: 'FISHING',
          event_type: 'Fishing Job',
          subtype: 'String recovered by mule / overshot',
          formation: sample._formationName,
          formationCode: sample._formation,
          start_md_m: depth,
          end_md_m: depth + 35,
          depth_m: depth,
          depth_reference: 'MD',
          severity: Math.min(5, Math.max(2, Math.round(intensity * 4.2))),
          npt_hours: round(14 + intensity * 70, 1),
          volume_loss_bbl: null,
          root_cause: 'Free pipe left in hole after the differential sticking could not be worked free.',
          action_taken:
            'Ran a mule and overshot on the fishing string, milled the fish and recovered the free pipe in three trips.',
          action_outcome: rng.chance(0.86) ? 'WORKED' : 'PARTLY_WORKED',
          source_label: null,
        });
      }
    }
  });

  // Fishing from stuck pipe covers only one route to a fishing job; wells also
  // lose bottom-hole assemblies. These are independent events, not follow-ons.
  samples.forEach((sample, idx) => {
    if (sample.depth_md_m < 1500 || idx % 37 !== 5) return;
    if (rng.chance(0.06)) {
      events.push({
        well_name: well.well_name,
        category: 'FISHING',
        event_type: 'Fishing Job (BHA)',
        subtype: 'Turbine / drill string parted or unreamable joint',
        formation: sample._formationName,
        formationCode: sample._formation,
        start_md_m: round(sample.depth_md_m, 0),
        end_md_m: round(sample.depth_md_m + 25, 0),
        depth_m: round(sample.depth_md_m, 0),
        depth_reference: 'MD',
        severity: rng.int(2, 4),
        npt_hours: round(rng.float(8, 46), 1),
        volume_loss_bbl: null,
        root_cause: 'Premature thread failure / bit and drill string unreamable in the open hole.',
        action_taken: 'Fished with a string grab and recovered the assembly; reamed and resumed operations.',
        action_outcome: rng.chance(0.9) ? 'WORKED' : 'PARTLY_WORKED',
        source_label: null,
      });
    }
  });

  return events;
}

function peakOf(samples, idx, key, window) {
  let peak = 0;
  for (let k = idx; k < Math.min(samples.length, idx + window); k += 1) {
    peak = Math.max(peak, samples[k][key] || 0);
  }
  return peak;
}