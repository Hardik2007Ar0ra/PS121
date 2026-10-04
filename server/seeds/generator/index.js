/**
 * Synthetic corpus generator entry point.
 *
 * `buildCorpus(seed, options)` returns a complete, self-consistent corpus:
 * geology, well programmes, depth-indexed dynamics, events detected from those
 * dynamics, and the documents those events are narrated in. Nothing here talks
 * to the database — server/db/seed.js owns persistence.
 */

import { makeRandom } from './random.js';
import { buildGeology, buildSurveys, buildSections } from './geology.js';
import { buildMudPrograms, buildCementingJobs, buildDynamics } from './dynamics.js';
import { buildDocuments } from './documents.js';

export { makeRandom, gradientToPpg, ppgToSg } from './random.js';

export function buildCorpus(seed = 20260101, options = {}) {
  const {
    nWells = 48,
    nFields = 3,
    docsPerWell = 0.6,
    // Injection multiplier for the anomaly injectors. The default produces a
    // realistic minority of wells with a genuine problem in a given interval;
    // the ML models need both positive and negative examples.
    anomalyRate = 1,
  } = options;

  const started = Date.now();
  const rng = makeRandom(seed);

  const geology = buildGeology(rng, { nWells, nAreas: nFields });
  const { fields, wells } = geology;

  const surveysByWell = new Map();
  const dynamicsByWell = new Map();
  const mudProgramsByWell = new Map();
  const cementingJobsByWell = new Map();

  wells.forEach((well) => {
    const surveys = buildSurveys(rng, well);
    const mudPrograms = buildMudPrograms(rng, well);
    const sections = buildSections(rng, well);

    well.sections = sections;
    well.mudPrograms = mudPrograms;

    const cementingJobs = buildCementingJobs(rng, well);
    well.cementingJobs = cementingJobs;

    const dynamics = buildDynamics(rng, well, { mudPrograms, surveys });
    if (anomalyRate !== 1) scaleAnomalies(dynamics, anomalyRate, rng);

    surveysByWell.set(well.well_name, surveys);
    dynamicsByWell.set(well.well_name, dynamics);
    mudProgramsByWell.set(well.well_name, mudPrograms);
    cementingJobsByWell.set(well.well_name, cementingJobs);
  });

  const { documents, eventPlacement } = buildDocuments(rng, wells, fields, dynamicsByWell, { docsPerWell });

  // Flatten every well's events into one corpus-wide list, remembering which
  // well each came from. `eventPlacement` indices are well-relative, so the
  // lookup below is keyed by well name rather than by a running counter.
  const events = [];
  const eventsByWellIndex = new Map();
  wells.forEach((well) => {
    dynamicsByWell.get(well.well_name).events.forEach((event, wellIndex) => {
      const record = { ...event, well_name: well.well_name, id: events.length + 1 };
      events.push(record);
      eventsByWellIndex.set(`${well.well_name}:${wellIndex}`, record);
    });
  });

  // Attach each event to the document page that narrates it. This is the ground
  // truth the extraction pipeline is measured against.
  eventPlacement.forEach((placement) => {
    if (placement.syntheticEvent) {
      const synthetic = {
        ...placement.syntheticEvent,
        category: 'CEMENTING_ISSUE',
        subtype: 'Displacement / channeling',
        depth_reference: 'MD',
        volume_loss_bbl: null,
        detected_by: 'derived',
        well_name: placement.wellName,
        id: events.length + 1,
      };
      events.push(synthetic);
      eventsByWellIndex.set(`${placement.wellName}:${placement.eventIndex}`, synthetic);
      return;
    }
    const event = eventsByWellIndex.get(`${placement.wellName}:${placement.eventIndex}`);
    if (!event) return;
    const doc = documents[placement.documentIndex];
    if (!doc) return;
    event.source_label = `${doc.doc_type}-${String(placement.pageNo).padStart(2, '0')}`;
    event.source_document_index = placement.documentIndex;
    event.source_page_no = placement.pageNo;
  });

  // Lessons learned: one per significant event that had a recorded outcome.
  const lessons = events
    .filter((e) => e.severity >= 3 && e.action_taken)
    .map((event, index) => ({
      id: index + 1,
      title: `${event.event_type} in ${event.formation} at ${Math.round(event.start_md_m)} m`,
      well_name: event.well_name,
      event_id: event.id,
      category: event.category,
      formation: event.formation,
      depth_md_m: event.start_md_m,
      challenge: `${event.event_type} while drilling ${event.formation}. ${event.root_cause}`,
      root_cause: event.root_cause,
      action_taken: event.action_taken,
      effectiveness: event.action_outcome || 'UNKNOWN',
      transferable: ['MUD_LOSS', 'STUCK_PIPE', 'KICK'].includes(event.category) ? 1 : 0,
      applicability_note: transferableNote(event),
      tags: [event.category.toLowerCase(), (event.formation || '').toLowerCase().split(' ')[0]].filter(Boolean),
      author: 'Drilling Superintendent',
    }));

  const summary = {
    fields: fields.length,
    wells: wells.length,
    formations: geology.formationIndex.size,
    surveys: [...surveysByWell.values()].reduce((sum, list) => sum + list.length, 0),
    mudPrograms: [...mudProgramsByWell.values()].reduce((sum, list) => sum + list.length, 0),
    cementingJobs: [...cementingJobsByWell.values()].reduce((sum, list) => sum + list.length, 0),
    telemetrySamples: [...dynamicsByWell.values()].reduce((sum, d) => sum + d.samples.length, 0),
    events: events.length,
    eventsByCategory: countBy(events, (e) => e.category),
    lessons: lessons.length,
    documents: documents.length,
    documentPages: documents.reduce((sum, d) => sum + d.pages.length, 0),
    buildMs: Date.now() - started,
  };

  return {
    seed,
    fields,
    wells,
    formationIndex: geology.formationIndex,
    reservoirs: geology.reservoirs,
    surveysByWell,
    dynamicsByWell,
    mudProgramsByWell,
    cementingJobsByWell,
    events,
    lessons,
    documents,
    eventPlacement,
    summary,
  };
}

function transferableNote(event) {
  switch (event.category) {
    case 'MUD_LOSS':
      return 'Applicable to any well entering a fractured or vuggy unit above a thicker overburden.';
    case 'STUCK_PIPE':
      return 'Applicable where static time exceeds the differential sticking window in permeable shale.';
    case 'KICK':
      return 'Applicable where pore pressure increases faster than the mud programme steps.';
    case 'TORQUE_SPIKE':
      return 'Applicable to wells with a comparable build section and hole angle.';
    case 'CEMENTING_ISSUE':
      return 'Applicable where displacement volume is marginal against annular capacity.';
    case 'FISHING':
      return 'Applicable where a free pipe or unreamable joint risk is identified.';
    default:
      return null;
  }
}

function countBy(list, fn) {
  return list.reduce((acc, item) => {
    const key = fn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

/**
 * Scales anomaly episodes up or down by removing detected events (for < 1) or
 * duplicating wells into more problem-prone variants (for > 1).
 */
function scaleAnomalies(dynamics, rate, rng) {
  if (rate === 1) return;
  if (rate < 1) {
    const keep = Math.max(0, Math.round(dynamics.events.length * rate));
    dynamics.events = dynamics.events.slice(0, keep);
  } else {
    const extra = [];
    const source = dynamics.events;
    const extraCount = Math.round(source.length * (rate - 1));
    for (let i = 0; i < extraCount && source.length; i += 1) {
      const template = rng.pick(source);
      extra.push({ ...template, start_md_m: round(template.start_md_m * rng.float(0.7, 1.25)) });
    }
    dynamics.events = source.concat(extra);
  }
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}