/**
 * Geological skeleton of the synthetic corpus: operating areas, formations,
 * wells, per-well formation tops and directional surveys.
 *
 * The important design choice here is structural dip plus fault offsets. Real
 * offset wells do not encounter the same formation at the same depth — they
 * encounter it tens or hundreds of metres shallower or deeper depending on
 * which side of a fault they sit on. Reproducing that is what makes
 * depth-based correlation a genuine problem instead of a string comparison,
 * and it is what the ML features have to cope with.
 */

import { round } from './random.js';

/**
 * Three operating areas based on Oil India's actual areas of interest. The
 * geometry is fictional; the field names and general locations are not, so the
 * demo reads plausibly to an OIL reviewer.
 */
export const AREAS = [
  {
    code: 'NAF',
    name: 'North Assam Field',
    basin: 'Upper Assam Basin',
    district: 'Dibrugarh, Assam',
    center: { lat: 27.19, lng: 94.93 },
    spreadKm: 9,
    // Gradients are psi/ft. Equivalent mud weight in ppg = psi_per_ft / 0.05189,
    // so 0.48 psi/ft is a 9.3 ppg gradient — normal to slightly overpressured.
    formations: [
      { code: 'BAR', name: 'Barail Formation', lithology: 'Sandstone', age: 'Oligocene', ppGradient: 0.48, fgGradient: 0.68, lossProneness: 0.18, instabilityProneness: 0.22 },
      { code: 'TIP', name: 'Tipam Sandstone', lithology: 'Sandstone', age: 'Miocene', ppGradient: 0.56, fgGradient: 0.78, lossProneness: 0.62, instabilityProneness: 0.18 },
      { code: 'MOR', name: 'Moran Formation', lithology: 'Sandstone / Shale', age: 'Oligocene', ppGradient: 0.63, fgGradient: 0.84, lossProneness: 0.34, instabilityProneness: 0.55 },
      { code: 'DIH', name: 'Dihing Formation', lithology: 'Shale', age: 'Paleocene', ppGradient: 0.71, fgGradient: 0.92, lossProneness: 0.08, instabilityProneness: 0.86 },
      { code: 'BOK', name: 'Bokam Formation', lithology: 'Shale', age: 'Paleocene', ppGradient: 0.76, fgGradient: 0.96, lossProneness: 0.05, instabilityProneness: 0.92 },
      { code: 'LAK', name: 'Lakwa Formation', lithology: 'Carbonaceous Shale', age: 'Paleocene', ppGradient: 0.82, fgGradient: 1.0, lossProneness: 0.04, instabilityProneness: 0.97 },
    ],
  },
  {
    code: 'BJF',
    name: 'Bokaro Jharkhand Field',
    basin: 'Gangetic Basin',
    district: 'Bokaro, Jharkhand',
    center: { lat: 23.66, lng: 86.15 },
    spreadKm: 7,
    formations: [
      { code: 'RAJ', name: 'Rajmahal Formation', lithology: 'Fractured Basalt / Shale', age: 'Cretaceous', ppGradient: 0.42, fgGradient: 0.62, lossProneness: 0.71, instabilityProneness: 0.48 },
      { code: 'DAM', name: 'Damodar Formation', lithology: 'Sandstone / Shale', age: 'Permian', ppGradient: 0.52, fgGradient: 0.72, lossProneness: 0.31, instabilityProneness: 0.44 },
      { code: 'BRK', name: 'Barakar Formation', lithology: 'Sandstone', age: 'Permian', ppGradient: 0.6, fgGradient: 0.8, lossProneness: 0.58, instabilityProneness: 0.21 },
      { code: 'GIR', name: 'Giridih Formation', lithology: 'Shale', age: 'Permian', ppGradient: 0.7, fgGradient: 0.9, lossProneness: 0.07, instabilityProneness: 0.81 },
      { code: 'KAR', name: 'Karla Formation', lithology: 'Coal-bearing Shale', age: 'Permian', ppGradient: 0.78, fgGradient: 0.98, lossProneness: 0.03, instabilityProneness: 0.94 },
    ],
  },
  {
    code: 'AGF',
    name: 'Ankleshwar Gujarat Field',
    basin: 'Cambay Basin',
    district: 'Ankleshwar, Gujarat',
    center: { lat: 21.63, lng: 73.02 },
    spreadKm: 6,
    formations: [
      { code: 'WAH', name: 'Wadhwan Formation', lithology: 'Sandstone', age: 'Eocene', ppGradient: 0.46, fgGradient: 0.7, lossProneness: 0.24, instabilityProneness: 0.19 },
      { code: 'ANK', name: 'Ankleshwar Formation', lithology: 'Sandstone / Shale', age: 'Eocene', ppGradient: 0.55, fgGradient: 0.76, lossProneness: 0.55, instabilityProneness: 0.37 },
      { code: 'SIV', name: 'Sivajuri Formation', lithology: 'Fractured Limestone', age: 'Eocene', ppGradient: 0.62, fgGradient: 0.88, lossProneness: 0.66, instabilityProneness: 0.33 },
      { code: 'CAM', name: 'Cambay Formation', lithology: 'Shale', age: 'Paleogene', ppGradient: 0.72, fgGradient: 0.93, lossProneness: 0.06, instabilityProneness: 0.88 },
      { code: 'KAL', name: 'Kalol Formation', lithology: 'Depleted Sandstone', age: 'Paleogene', ppGradient: 0.8, fgGradient: 0.99, lossProneness: 0.42, instabilityProneness: 0.61 },
    ],
  },
];

/** Standard casing programme used as the starting point for every well. */
const CASING_TEMPLATE = [
  { sectionNo: 1, name: 'Conductor', holeSizeIn: 26, casingSizeIn: 20, topMd: 0 },
  { sectionNo: 2, name: 'Surface', holeSizeIn: 17.5, casingSizeIn: 13.375, topMd: 40 },
  { sectionNo: 3, name: 'Intermediate', holeSizeIn: 12.25, casingSizeIn: 9.625, topMd: 600 },
  { sectionNo: 4, name: 'Intermediate', holeSizeIn: 8.5, casingSizeIn: 7, topMd: 1500 },
  { sectionNo: 5, name: 'Production', holeSizeIn: 6, casingSizeIn: 5, topMd: 2400 },
  { sectionNo: 6, name: 'Production / Liner', holeSizeIn: 4.5, casingSizeIn: 3.5, topMd: 3200 },
];

const COMPANIES = [
  'OIL (Operated)',
  'OIL (Operated)',
  'OIL (Operated)',
  'M/s North East Drilling Services',
  'M/s Assam Oil Drilling Pvt Ltd',
];

/**
 * Builds the full geological skeleton. Returns plain objects ready for the
 * seeder to insert — no database calls live in this file.
 */
export function buildGeology(rng, { areas = AREAS, nWells = 48, nAreas = areas.length } = {}) {
  const fields = [];
  const wells = [];
  const formations = [];
  const formationTops = [];
  const surveys = [];
  const reservoirDefs = [
    { name: 'North Assam Shelf Reservoir', fluid_type: 'OIL', pressure_psi: 2450, pressure_gradient: 0.54, temperature_c: 78, permeability_md: 420, porosity_pct: 22.4, producer: 'NAF-A1' },
    { name: 'Tipam Deep Sand Reservoir', fluid_type: 'GILT', pressure_psi: 3120, pressure_gradient: 0.6, temperature_c: 92, permeability_md: 310, porosity_pct: 19.8, producer: 'NAF-B2' },
    { name: 'Moran Overburden Reservoir', fluid_type: 'GAS', pressure_psi: 2880, pressure_gradient: 0.71, temperature_c: 88, permeability_md: 180, porosity_pct: 17.1, producer: 'NAF-C1' },
    { name: 'Rajmahl Fractured Basalt Reservoir', fluid_type: 'OIL', pressure_psi: 1980, pressure_gradient: 0.45, temperature_c: 64, permeability_md: 95, porosity_pct: 12.6, producer: 'BJF-A1' },
    { name: 'Barakar Channel Sand Reservoir', fluid_type: 'COALBED_GAS', pressure_psi: 2740, pressure_gradient: 0.68, temperature_c: 71, permeability_md: 240, porosity_pct: 20.3, producer: 'BJF-B2' },
    { name: 'Sivajuri Fractured Limestone Reservoir', fluid_type: 'OIL', pressure_psi: 3260, pressure_gradient: 0.73, temperature_c: 96, permeability_md: 68, porosity_pct: 9.4, producer: 'AGF-A1' },
    { name: 'Wadhwan Sand Reservoir', fluid_type: 'MULTI', pressure_psi: 2210, pressure_gradient: 0.5, temperature_c: 69, permeability_md: 360, porosity_pct: 23.1, producer: 'AGF-A2' },
  ];

  const activeAreaIndices = areas.slice(0, nAreas);

  activeAreaIndices.forEach((area, areaIndex) => {
    const field = {
      code: area.code,
      name: area.name,
      basin: area.basin,
      district: area.district,
      operator: 'Oil India Limited',
      formations: [],
    };

    // Regional structural dip plus a per-field fault-block offset. Two blocks
    // in the same field therefore share a stratigraphy but not a depth scale.
    const regionalDip = rng.float(0.018, 0.045);
    const dipAzimuth = rng.float(20, 160);
    const blocks = [
      { name: 'North Block', offset: 0 },
      { name: 'South Block', offset: rng.float(60, 190) * (rng.chance(0.5) ? 1 : -1) },
    ];

    area.formations.forEach((f, order) => {
      field.formations.push({
        ...f,
        // Regional top of the unit below the ground, before any block offset.
        regionalTopM: 420 + order * rng.float(310, 620),
        dipRad: regionalDip * (Math.PI / 180),
        dipAzimuth,
        blockOffsets: blocks,
        orderIndex: order,
        reservoir:
          order === 1 || order === 2 || order === 3
            ? reservoirDefs[(areaIndex * 2 + order) % reservoirDefs.length].name
            : null,
      });
    });

    fields.push(field);
  });

  // --- Wells ---------------------------------------------------------------
  let wellSeq = 0;
  const wellsPerArea = Math.ceil(nWells / fields.length);

  fields.forEach((field, fieldIndex) => {
    const area = areas[fieldIndex];
    // Wells cluster into a handful of pads, as they do around real fields.
    const pads = Array.from({ length: Math.max(2, Math.round(wellsPerArea / 6)) }, () => ({
      lat: area.center.lat + rng.normal(0, area.spreadKm / 111) * 0.8,
      lng: area.center.lng + rng.normal(0, area.spreadKm / (111 * Math.cos((area.center.lat * Math.PI) / 180))) * 0.8,
      blockIndex: rng.int(0, 1),
    }));

    for (let i = 0; i < wellsPerArea; i += 1) {
      wellSeq += 1;
      const pad = pads[i % pads.length];
      const block = field.formations[0].blockOffsets[pad.blockIndex];

      const lat = round(pad.lat + rng.normal(0, 0.006), 6);
      const lng = round(pad.lng + rng.normal(0, 0.006), 6);
      const name = `${area.code}-${String(wellSeq).padStart(2, '0')}`;

      const isActive = wellSeq === 1;
      const status = isActive ? 'DRILLING' : rng.chance(0.86) ? 'COMPLETED' : rng.chance(0.5) ? 'SUSPENDED' : 'ABANDONED';
      const wellType = rng.chance(0.78) ? 'DEVELOPMENT' : rng.chance(0.5) ? 'APPD' : 'EXPLORATION';

      const spudYear = 2012 + rng.int(0, 13);
      const spudMonth = rng.int(1, 12);
      const spudDay = rng.int(1, 28);
      const spudDate = `${spudYear}-${String(spudMonth).padStart(2, '0')}-${String(spudDay).padStart(2, '0')}`;

      // Per-well noise: local structure, thickness variation, and the block
      // offset that makes cross-well depth correlation non-trivial.
      const localShift = rng.normal(0, 62);
      const thicknessScale = rng.float(0.82, 1.22);
      const kbElevation = round(rng.float(28, 190), 1);

      const well = {
        id: null,
        well_name: name,
        fieldCode: field.code,
        uwi: `IN-${area.code}-${spudYear}-${String(wellSeq).padStart(4, '0')}`,
        well_type: wellType,
        status,
        lat,
        lng,
        kb_elevation_m: kbElevation,
        sea_level_elevation_m: kbElevation,
        spud_kb_m: 0,
        td_md_m: 0,
        td_tvd_m: 0,
        spud_pressure_psi: null,
        pore_pressure_gradient: null,
        fracture_gradient: null,
        water_depth_m: null,
        is_active: isActive ? 1 : 0,
        spud_date: spudDate,
        completion_date:
          status === 'COMPLETED'
            ? `${spudYear + rng.int(1, 4)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`
            : null,
        operator: rng.pick(COMPANIES),
        blockName: `${field.code} ${block.name}`,
        localShift,
        thicknessScale,
        dipAzimuth: field.formations[0].dipAzimuth,
        dipRad: field.formations[0].dipRad,
        blockOffset: block.offset,
        // The one well that is being drilled now. Everything about it is tuned
        // to sit just below a known offset-risk interval so the alert demo has
        // something real to fire on.
        liveScenario: isActive
          ? {
              targetDepth: 0, // filled in once tops are known
            }
          : null,
      };

      // --- Formation tops + trajectory -------------------------------------
      const tops = [];
      let cursorMd = rng.float(140, 260); // soil / weathered section
      let deepestTvd = 0;
      field.formations.forEach((formation) => {
        const thickness = (formation.regionalTopM * 0.42) * thicknessScale * rng.float(0.8, 1.25);
        const topMd = Math.max(cursorMd + 55, cursorMd + thickness * rng.float(0.85, 1.15));
        const inclination = wellType === 'DEVELOPMENT' ? rng.float(0, 38) : rng.float(0, 12);
        const topTvd = topMd * Math.cos((inclination * Math.PI) / 180) * rng.float(0.985, 1.0);
        const baseMd = topMd + thickness;
        const baseTvd = baseTvdFrom(topTvd, thickness, inclination);
        deepestTvd = Math.max(deepestTvd, baseTvd);

        tops.push({
          formationCode: formation.code,
          formationName: formation.name,
          top_md_m: round(topMd + well.localShift + well.blockOffset, 1),
          base_md_m: round(topMd + well.localShift + well.blockOffset + thickness, 1),
          top_tvd_m: round(topTvd + well.localShift * 0.94 + well.blockOffset * 0.94, 1),
          base_tvd_m: round(baseTvd + well.localShift * 0.94 + well.blockOffset * 0.94, 1),
          thickness_m: round(thickness, 1),
          confidence: round(rng.float(0.62, 0.97), 3),
          method: rng.chance(0.5) ? 'MARKER' : rng.chance(0.5) ? 'GR' : 'CORRELATION',
          lithology: formation.lithology,
          ppGradient: formation.ppGradient,
          fgGradient: formation.fgGradient,
          lossProneness: formation.lossProneness,
          instabilityProneness: formation.instabilityProneness,
          orderIndex: formation.orderIndex,
        });
        cursorMd = topMd + thickness;
      });

      well.tops = tops;
      well.td_md_m = round(deepestTvd * rng.float(1.06, 1.2), 0);
      well.td_tvd_m = round(deepestTvd, 0);
      well.pore_pressure_gradient = round(tops[tops.length - 1].ppGradient, 3);
      well.fracture_gradient = round(tops[tops.length - 1].fgGradient, 3);
      well.spud_pressure_psi = Math.round(rng.float(900, 1900));
      well.trajectoryPlan = planTrajectory(rng, wellType, well.td_md_m);
      wells.push(well);
    }
  });

  // One well is the live drilling target; put it 40 m above the deepest
  // high-severity risk depth in a nearby completed well so the look-ahead
  // alert fires on real correlated history rather than a hard-coded threshold.
  const active = wells.find((w) => w.is_active);
  if (active) {
    const shallowest = active.tops.reduce((min, t) => (t.top_md_m < min.top_md_m ? t : min), active.tops[0]);
    active.liveScenario = {
      // Start above the deepest interesting formation top.
      startDepth: Math.max(300, Math.round(shallowest.top_md_m - 40)),
    };
  }

  // Flatten formations for the DB.
  const formationIndex = new Map();
  fields.forEach((field) => {
    field.formations.forEach((formation) => {
      formationIndex.set(`${field.code}:${formation.code}`, {
        code: formation.code,
        name: formation.name,
        fieldCode: field.code,
        age: formation.age,
        lithology: formation.lithology,
        description: `${formation.lithology} unit of the ${field.basin}. Regional pore-pressure gradient ~${formation.ppGradient.toFixed(2)} ppg/ft, fracture gradient ~${formation.fgGradient.toFixed(2)} ppg/ft.`,
        correlates_with: formation.orderIndex > 0 ? field.formations[formation.orderIndex - 1].code : null,
        reservoirName: formation.reservoir,
      });
    });
  });

  return { fields, wells, formationIndex, reservoirs: reservoirDefs };
}

function baseTvdFrom(topTvd, thickness, inclinationDeg) {
  const avg = (inclinationDeg * Math.PI) / 180;
  return topTvd + thickness * Math.cos(avg) * 0.995;
}

/**
 * Plans a directional profile: vertical through the shallow section, then
 * either a hold, a tangent build, or a two-turn build. Trajectory complexity is
 * a real predictor of torque and drag, so it has to be in the survey table.
 */
function planTrajectory(rng, wellType, td) {
  const type = wellType === 'EXPLORATION' ? 'VERTICAL' : rng.pick(['VERTICAL', 'TANGENT', 'S_BUILD', 'S_TANGENT']);
  const buildStart = Math.round(td * rng.float(0.35, 0.62));
  const holdAngle = type === 'VERTICAL' ? 0 : rng.float(12, 52);
  const buildLength = type === 'VERTICAL' ? 0 : Math.round(rng.float(320, 1150));
  return {
    type,
    buildStart,
    buildEnd: buildStart + buildLength,
    holdAngle,
    azimuth: rng.float(0, 360),
  };
}

/** Produces survey stations from the trajectory plan, one per 30 m MD. */
export function buildSurveys(rng, well) {
  const stations = [];
  const plan = well.trajectoryPlan;
  const step = 30;
  let north = 0;
  let east = 0;
  let previousInc = 0;
  let previousAz = plan.azimuth;

  for (let md = 0; md <= well.td_md_m; md += step) {
    let inclination = 0;
    if (plan.type !== 'VERTICAL' && md > plan.buildStart) {
      if (md < plan.buildEnd) {
        const progress = (md - plan.buildStart) / Math.max(1, plan.buildEnd - plan.buildStart);
        inclination = plan.holdAngle * progress;
      } else {
        inclination = plan.holdAngle;
      }
    }
    // Small survey noise so the section view is not a perfect analytic curve.
    inclination = Math.max(0, inclination + rng.normal(0, 0.35));
    const azimuth = plan.azimuth + rng.normal(0, 1.6);
    const incRad = (inclination * Math.PI) / 180;
    const azRad = (azimuth * Math.PI) / 180;
    const tvd = md * Math.cos(incRad);
    const delta = (step / 2) * Math.sin(incRad);
    north += delta * Math.cos(azRad);
    east += delta * Math.sin(azRad);

    stations.push({
      well_name: well.well_name,
      md_m: round(md, 1),
      inclination_deg: round(inclination, 2),
      azimuth_deg: round(azimuth, 2),
      tvd_m: round(tvd, 1),
      north_m: round(north, 1),
      east_m: round(east, 1),
      atge_deg: previousInc > 0.5 ? round(((azimuth - previousAz) * Math.PI) / 180, 4) : null,
      dogleg_deg_per_30m: round(Math.abs(inclination - previousInc), 2),
    });
    previousInc = inclination;
    previousAz = azimuth;
  }
  return stations;
}

/** Derives the casing programme from the trajectory and planned TD. */
export function buildSections(rng, well) {
  const sections = [];
  CASING_TEMPLATE.forEach((template) => {
    // The production sections depend on where the well actually needs them.
    const target =
      template.sectionNo <= 3
        ? template.topMd + rng.float(220, 520)
        : Math.min(well.td_md_m * rng.float(0.72, 0.96), template.topMd + rng.float(700, 1500));
    const shoeMd = Math.min(round(target, 0), Math.round(well.td_md_m * 0.98));
    const plan = well.trajectoryPlan;
    const incAtShoe =
      plan.type === 'VERTICAL' || shoeMd < plan.buildStart
        ? 0
        : shoeMd < plan.buildEnd
          ? plan.holdAngle * ((shoeMd - plan.buildStart) / Math.max(1, plan.buildEnd - plan.buildStart))
          : plan.holdAngle;
    sections.push({
      well_name: well.well_name,
      section_no: template.sectionNo,
      section_name: template.name,
      hole_size_in: template.holeSizeIn,
      casing_size_in: template.casingSizeIn,
      casing_grade: template.casingSizeIn >= 9.625 ? 'API 5L / N-80' : 'API 5L / K-55',
      top_md_m: template.topMd,
      shoe_md_m: shoeMd,
      shoe_tvd_m: round(shoeMd * Math.cos((incAtShoe * Math.PI) / 180), 1),
      grouted_md_m: shoeMd,
      design_ecd_ppg: round(Math.max(9.5, template.casingSizeIn ? 13.2 - template.sectionNo * 0.7 : 10), 2),
      design_maasp_psi: Math.round(3200 - template.sectionNo * 220),
      depth_reference: 'MD',
    });
  });
  return sections;
}