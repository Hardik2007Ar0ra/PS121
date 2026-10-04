/**
 * Synthetic well documents.
 *
 * These are written to be *messy on purpose*. Real reports are not clean data:
 * depths appear as "2,880 m", "2880 M", "2880.0m" and "2880M MD"; casing sizes
 * appear as 9 5/8", 9-5/8 inch and 9.625"; severities are spelled out or
 * abbreviated; sentences run on and headings are inconsistent. The extractor in
 * server/nlp is written against this kind of text, and the extraction metrics in
 * `npm run nlp:evaluate` are measured against the events recorded here.
 *
 * Every generated event is placed on a specific page so extraction precision
 * and recall can be computed honestly.
 */

import { round, ppgToSg, gradientToPpg } from './random.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- Prose variation --------------------------------------------------------

/** Renders a depth the way a real report would, with the format varying. */
function depthText(rng, metres) {
  const m = Math.round(metres);
  const withComma = `${Math.floor(m / 1000)},${String(m % 1000).padStart(3, '0')}`;
  const forms = [`${m} m`, `${m} m`, `${withComma} m`, `${withComma} M`, `${m} M`, `${withComma}m`, `${m}.0 m`];
  return rng.pick(forms);
}

function casingText(rng, inches) {
  const whole = Math.floor(inches);
  const eighths = Math.round((inches - whole) * 8);
  if (eighths === 0) return `${whole} in`;
  return rng.pick([`${whole} ${eighths}/8"`, `${whole}-${eighths}/8 in`, `${whole} ${eighths}/8 inch`, `${inches.toFixed(3)}"`]);
}

const SEVERITY_WORDS = {
  1: ['minor', 'slight', 'negligible'],
  2: ['minor to moderate', 'low'],
  3: ['moderate', 'significant but manageable'],
  4: ['severe', 'major'],
  5: ['very severe', 'critical'],
};

const OPERATIONS = ['Drilled ahead', 'Reamed and drilled ahead', 'Circulated bottoms-up', 'Tripped', 'Drilled cement', 'Conditioned mud', 'Logged and cored', 'Ran DST'];

// --- Document bodies --------------------------------------------------------

function wellHeaderBlock(rng, well, field) {
  const mud = well.mudPrograms?.[well.mudPrograms.length - 1];
  const casing = well.sections?.[well.sections.length - 1];
  return [
    `OIL INDIA LIMITED — ${field.name.toUpperCase()}`,
    `WELL COMPLETION / DRILLING DATA SUMMARY`,
    '',
    `Well Name            : ${well.well_name}`,
    `UWI                 : ${well.uwi}`,
    `Field / Block       : ${field.code} / ${well.blockName}`,
    `Operator            : ${well.operator}`,
    `Spud Date           : ${spudText(well.spud_date)}`,
    `Well Type           : ${well.well_type}`,
    `Total Depth (MD)    : ${depthText(rng, well.td_md_m)}`,
    `Total Depth (TVD)   : ${round(well.td_tvd_m, 0)} m TVD`,
    `KB Elevation        : ${well.kb_elevation_m} m amsl`,
    `Reference Datum     : ${well.spud_kb_m ? 'KB' : 'Ground level'}`,
    `Last Casing Shoe    : ${casing ? casingText(rng, casing.casing_size_in) : 'n/a'} at ${casing ? depthText(rng, casing.shoe_md_m) : 'n/a'}`,
    `Mud System at TD    : ${mud ? `${mud.system} ${ppgToSg(mud.density_ppg).toFixed(3)} SG (${mud.density_ppg} ppg)` : 'n/a'}`,
    `Pore Pressure Est.  : ${well.pore_pressure_gradient} psi/ft (${round(gradientToPpg(well.pore_pressure_gradient), 2)} ppg/ft)`,
    `Fracture Gradient   : ${well.fracture_gradient} psi/ft`,
    '',
  ].join('\n');
}

function spudText(iso) {
  if (!iso) return 'n/a';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function lithologyParagraph(rng, top) {
  const shades = ['light grey', 'buff', 'greyish brown', 'dark grey', 'greenish grey', 'off-white'];
  return [
    `${top.formationName} — ${top.lithology}`,
    `Top at ${depthText(rng, top.top_md_m)} MD / ${round(top.top_tvd_m, 0)} m TVD. Base at ${depthText(rng, top.base_md_m)} MD.`,
    `Interval thickness ${round(top.thickness_m, 1)} m. Correlation confidence ${Math.round(top.confidence * 100)}%.`,
    `Predominantly ${rng.pick(shades)} ${top.lithology.toLowerCase()}, ${rng.pick([
      'medium to coarse grained',
      'fine to medium grained',
      'silty',
      'calcareous',
      'ferruginous',
    ])}, ${rng.pick([
      'with occasional pebble size clasts',
      'with plant fragments',
      'with thin coal seams',
      'with glauconitic grains',
      'with thin bentonite beds',
    ])}. RHOB range ${round(rng.float(2.1, 2.85), 2)} - ${round(rng.float(2.2, 2.9), 2)} g/cc.`,
    `Estimated pore pressure gradient ${top.ppGradient} psi/ft; fracture gradient ${top.fgGradient} psi/ft.`,
    '',
  ].join('\n');
}

function mudProgrammePage(rng, well) {
  const lines = ['MUD PROGRAMME SUMMARY', ''];
  (well.mudPrograms || []).forEach((mud) => {
    lines.push(
      `${depthText(rng, mud.interval_from_md_m)} - ${depthText(rng, mud.interval_to_md_m)}  ${mud.system}${mud.fluid_type ? ` (${mud.fluid_type})` : ''}`,
    );
    lines.push(
      `    Mud weight ${mud.density_ppg} ppg (${ppgToSg(mud.density_ppg).toFixed(3)} SG), FV ${mud.funnel_viscosity_s} s, PV ${mud.pv_cp} cP, YP ${mud.yp_lbf_100ft2} lbf/100ft2, pH ${mud.ph}`,
    );
    if (mud.lcm_type) lines.push(`    LCM: ${mud.lcm_type} at ${mud.lcm_ration_ppb} ppb`);
    if (mud.additive) lines.push(`    Additive: ${mud.additive}`);
    if (mud.inhibitiveness_note) lines.push(`    Note: ${mud.inhibitiveness_note}`);
    lines.push('');
  });
  return lines.join('\n');
}

function casingPage(rng, well) {
  const lines = ['CASING AND CEMENTING RECORD', ''];
  (well.sections || []).forEach((section) => {
    lines.push(
      `Section ${section.section_no} — ${section.section_name}: ${section.hole_size_in} in hole / ${casingText(rng, section.casing_size_in)} ${section.casing_grade}`,
    );
    lines.push(
      `    Shoe at ${depthText(rng, section.shoe_md_m)} MD / ${round(section.shoe_tvd_m, 0)} m TVD. Design ECD ${section.design_ecd_ppg} ppg, MAASP ${section.design_maasp_psi} psi.`,
    );
    const job = (well.cementingJobs || []).find((j) => j.section_no === section.section_no);
    if (job) {
      lines.push(
        `    Cement job ${job.job_type}: ${job.cement_system}. Displacement efficiency ${job.displacement_efficiency_pct}%.`,
      );
      if (job.squeeze_required) lines.push('    REMEDIAL SQUEEZE REQUIRED — channeling observed on the cement log.');
      if (job.remarks) lines.push(`    Remarks: ${job.remarks}`);
      lines.push(`    Outcome: ${job.outcome}.`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function trajectoryPage(rng, well, surveys) {
  const step = Math.max(1, Math.floor(surveys.length / 22));
  const lines = ['DIRECTIONAL SURVEY — STATION LISTING', ''];
  lines.push('MD(m)      Incl(deg)   Azim(deg)   TVD(m)     Dogleg(deg/30m)');
  surveys
    .filter((_, i) => i % step === 0)
    .forEach((s) => {
      lines.push(
        `${String(Math.round(s.md_m)).padStart(8)}   ${String(round(s.inclination_deg, 2)).padStart(10)}   ${String(round(s.azimuth_deg, 1)).padStart(10)}   ${String(round(s.tvd_m, 1)).padStart(9)}   ${String(round(s.dogleg_deg_per_30m, 2)).padStart(10)}`,
      );
    });
  lines.push('');
  lines.push(
    `Total deviation ${round(well.trajectoryPlan.holdAngle, 1)} deg. Build section ${Math.round(well.trajectoryPlan.buildStart)} m - ${Math.round(well.trajectoryPlan.buildEnd)} m. Final azimuth ${round(well.trajectoryPlan.azimuth, 1)} deg.`,
  );
  lines.push('');
  return lines.join('\n');
}

function eventNarrative(rng, event) {
  // Deliberately varied sentence shapes so the extractor's relation rules get
  // exercised: "at X m", "between X and Y m", "while drilling", "upon reaching".
  const sev = rng.pick(SEVERITY_WORDS[event.severity] || ['moderate']);
  const opener = rng.pick([
    `During the ${rng.pick(OPERATIONS)} of the shift`,
    `While drilling ahead at ${depthText(rng, event.start_md_m)}`,
    `Upon reaching ${depthText(rng, event.start_md_m)} in ${event.formation}`,
    `Between ${depthText(rng, event.start_md_m)} and ${depthText(rng, event.end_md_m)}`,
  ]);
  const body = rng.pick([
    `a ${event.event_type.toLowerCase()} was encountered. The incident was ${sev}.`,
    `${event.event_type} occurred. Severity assessed as ${sev}.`,
    `the crew reported ${event.event_type.toLowerCase()}; this was graded ${sev} on the daily report.`,
  ]);
  const cause = rng.pick([`Probable cause: ${event.root_cause}`, `Root cause recorded as: ${event.root_cause}`, event.root_cause]);
  const npt = event.npt_hours ? ` NPT for this event was booked at ${round(event.npt_hours, 1)} hours.` : '';
  const loss =
    event.volume_loss_bbl != null ? ` Estimated mud volume lost: ${round(event.volume_loss_bbl, 1)} bbl.` : '';
  const action = `${event.action_taken}${event.action_outcome ? ` Outcome of the intervention was ${event.action_outcome.replace('_', ' ').toLowerCase()}.` : ''}`;

  return `${opener} ${body}\n${cause}${npt}${loss}\n${action}\n`;
}

/**
 * Daily report header. Depths come from the events actually narrated on the
 * report rather than a random draw, so the header agrees with the body. A
 * mismatch here would teach the extractor that headers are unreliable, which is
 * not the lesson we want it to learn.
 */
function dailyHeader(rng, well, date, pageNo, pageCount, eventsOnPage = []) {
  const depths = eventsOnPage.length
    ? eventsOnPage.map((event) => event.start_md_m)
    : [well.tops[Math.min(well.tops.length - 1, pageNo)].base_md_m * 0.9];
  const dayStart = Math.max(120, Math.round(Math.min(...depths) - rng.float(30, 90)));
  const dayEnd = Math.min(well.td_md_m, Math.round(Math.max(...depths) + rng.float(10, 45)));
  const mudWeight = round(rng.float(9, 16), 2);
  const formation = well.tops.find((t) => dayEnd >= t.top_md_m && dayEnd <= t.base_md_m) || well.tops[well.tops.length - 1];
  return [
    `OIL INDIA LIMITED — DAILY DRILLING REPORT`,
    `Well: ${well.well_name}        Date: ${spudText(date)}        Report No: DDR-        Page ${pageNo} of ${pageCount}`,
    '',
    'DEPTH',
    `Depth at start of day (MD)  : ${depthText(rng, dayStart)}`,
    `Depth at end of day (MD)    : ${depthText(rng, dayEnd)}`,
    `Hole size                   : ${casingText(rng, rng.pick([12.25, 8.5, 6, 17.5]))}`,
    `Mud weight                  : ${mudWeight} ppg (${ppgToSg(mudWeight).toFixed(3)} SG)`,
    `ROP                         : ${round(rng.float(4, 24), 1)} m/hr`,
    `WOB                         : ${round(rng.float(4, 18), 1)} ton`,
    `RPM                         : ${rng.int(60, 140)}`,
    `Formation                   : ${formation.formationName}`,
    '',
    'OPERATIONS SUMMARY',
    ...rng.sample(OPERATIONS, rng.int(2, 5)).map((op) => `  - ${op}`),
    '',
    '---',
    '',
  ].join('\n');
}

/** Filler page that carries no events but makes the corpus realistic. */
function fillerPage(rng, well, topic) {
  const topics = {
    'ENGINEERING': [
      'ENGINEERING / MECHANICAL REPORT',
      '',
      `Drillstring used from ${depthText(rng, Math.round(well.td_md_m * 0.4))}:`,
      '  Bit        : 8 1/2 in PDC, medium parabolic, 16 in/ft',
      '  Drill pipe : 5 in x 19.5 ft, Grade G-105',
      `  BHA        : 6 1/2 in LWD, MWD, 8 1/2 in stabilizer`,
      '',
      `Motor ran out of cavings: ${rng.chance(0.4) ? 'Yes, motor stalled at ' + depthText(rng, well.td_md_m * rng.float(0.5, 0.8)) : 'No cavings observed.'}`,
      `Bit dulled: ${rng.chance(0.5) ? 'Yes — dull grading 3/4 in the crown and gauge' : 'No, bit condition acceptable'}.`,
      `Vibration: ${rng.pick(['Acceptable', 'Elevated, monitoring', 'High — BHA modified'])}.`,
      `Torque and drag trend: ${rng.pick(['Stable', 'Gradual increase with depth', 'Elevated in the build section'])}.`,
      '',
    ].join('\n'),
    'HSE': [
      'HEALTH, SAFETY AND ENVIRONMENT SUMMARY',
      '',
      `HSE audits completed: ${rng.int(0, 2)}. Toolbox talks held: ${rng.int(1, 3)}.`,
      `Total Recordable Incident Rate (TRIR) to date: ${round(rng.float(0, 1.8), 2)}.`,
      `Rig floor housekeeping: ${rng.pick(['Satisfactory', 'Needs improvement — oil spill at the shaker house', 'Satisfactory'])}.`,
      `Well control equipment tested: ${rng.pick(['Weekly pressure test passed', 'Monthly test passed', 'Not due'])}.`,
      '',
    ].join('\n'),
    'GEOLOGY': [
      'DAILY GEOLOGICAL / MUD LOG SUMMARY',
      '',
      `Lithology description for the interval ${depthText(rng, well.td_md_m * rng.float(0.4, 0.7))} - ${depthText(rng, well.td_md_m * rng.float(0.7, 0.95))}:`,
      `  Predominantly ${rng.pick(['grey to dark grey shale', 'buff sandstone', 'greyish brown siltstone', 'off-white limestone'])}, ${rng.pick(['slightly calcareous', 'glauconitic', 'silty', 'ferruginous'])}.`,
      `  RHOB: ${round(rng.float(2.05, 2.9), 2)} g/cc. SONR: ${round(rng.float(20, 55), 0)}.`,
      `  Gas ratio: ${rng.int(40, 900)} ppm. Cut: ${rng.pick(['nil', 'trace', 'slight', 'good'])}.`,
      `  Shows: ${rng.pick(['no shows', 'good shows in the sand', 'fair shows', 'trace shows']) }.`,
      `  ROP: ${round(rng.float(3, 22), 1)} m/hr.`,
      '',
    ].join('\n'),
    'BIT': [
      'BIT AND BHA RECORD',
      '',
      `Bit run ${rng.int(1, 9)} — footage drilled ${depthText(rng, well.td_md_m * rng.float(0.2, 0.6))}.`,
      `  ROP achieved: ${round(rng.float(4, 25), 1)} m/hr. Dull condition: ${rng.pick(['IADC 2-2-1', 'IADC 3-2-1', 'IADC 5-2-3'])}.`,
      `  Rerun: ${rng.pick(['not required', 'required', 'successful on the second run'])}.`,
      `  Motor on bottom: ${rng.chance(0.4) ? 'cavings noticed, off-bottom motor drilling used' : 'no cavings'}.`,
      `  Next bit: ${rng.pick(['8 1/2 in PDC', '8 1/2 in roller cone', '6 1/4 in PDC'])} ${rng.pick(['new', 'rerun', 'used'])}.`,
      '',
    ].join('\n'),
    'FORMATION_TEST': [
      'FORMATION TEST RECORD',
      '',
      `Depth tested: ${depthText(rng, well.td_md_m * rng.float(0.5, 0.9))}.`,
      `Mud weight before test: ${round(rng.float(9, 15), 2)} ppg.`,
      `Initial flow rate: ${round(rng.float(2, 40), 1)} bbl/min, ${round(rng.float(180, 420), 0)} psi.`,
      `Mud to surface after ${round(rng.float(8, 40), 0)} minutes.`,
      `Result: ${rng.pick(['positive — influx confirmed', 'negative — transient interpreted as swell', 'ambiguous, flow check repeated'])}.`,
      `Formation pressure estimated from the repeat test: ${Math.round(rng.float(1800, 4200))} psi.`,
      '',
    ].join('\n'),
  };
  return topics[topic] || topics.GEOLOGY;
}

// --- Document assembly ------------------------------------------------------

/**
 * Builds the full document corpus. Returns documents whose pages each carry
 * their ground-truth event indices, so extraction can be scored.
 */
export function buildDocuments(rng, wells, fields, dynamicsByWell, { docsPerWell = 0.6 } = {}) {
  const documents = [];
  // Event → (document, page) placements, accumulated across all wells so the
  // caller can score extraction against the ground truth for the whole corpus.
  const attach = [];
  const fieldByCode = new Map(fields.map((f) => [f.code, f]));

  wells.forEach((well) => {
    const field = fieldByCode.get(well.fieldCode);
    const dynamics = dynamicsByWell.get(well.well_name);
    if (!dynamics) return;

    const events = dynamics.events;

    // --- Daily Drilling Reports: one document per cluster of events --------
    const ddrClusters = clusterEvents(events, rng, 1 + Math.floor(rng.float(0, 2.2)));
    ddrClusters.forEach((cluster, i) => {
      const date = shiftDate(well.spud_date, rng.int(4, Math.max(6, Math.round(well.td_md_m / 9))));
      const pageCount = Math.max(2, cluster.length + rng.int(1, 3));
      const pages = [];
      const pageEvents = [];
      for (let p = 1; p <= pageCount; p += 1) {
        const chunk = cluster.filter((_, idx) => idx % pageCount === p - 1);
        const text = [dailyHeader(rng, well, date, p, pageCount, chunk)];
        chunk.forEach((event) => {
          text.push(`EVENT ${p}.${chunk.indexOf(event) + 1}`);
          text.push(eventNarrative(rng, event));
          pageEvents.push({ eventIndex: events.indexOf(event), pageNo: p });
        });
        if (chunk.length === 0) text.push(fillerPage(rng, well, rng.pick(['GEOLOGY', 'ENGINEERING', 'BIT', 'HSE'])));
        pages.push(makePage(rng, p, text.join('\n')));
      }
      const doc = {
        filename: `${well.well_name}_DDR_${date.replace(/-/g, '')}.pdf`,
        doc_type: 'DDR',
        well_name: well.well_name,
        filed_date: date,
        pages,
        pageEvents,
      };
      documents.push(doc);
      pageEvents.forEach(({ eventIndex, pageNo }) =>
        attach.push({ wellName: well.well_name, eventIndex, documentIndex: documents.length - 1, pageNo }),
      );
    });

    // --- Well Completion Report --------------------------------------------
    if (rng.chance(Math.min(1, docsPerWell + 0.5))) {
      const pageCount = Math.round(rng.float(14, 34));
      const pages = [];
      const pageEvents = [];
      const narrativeSectionStart = 3;
      const narrativePages = Math.max(4, Math.round(pageCount * 0.28));
      for (let p = 1; p <= pageCount; p += 1) {
        let text;
        if (p === 1) {
          text = wellHeaderBlock(rng, well, field);
        } else if (p === 2) {
          text = 'STRATIGRAPHIC SUMMARY\n\n' + well.tops.map((t) => lithologyParagraph(rng, t)).join('\n');
        } else if (p >= narrativeSectionStart && p < narrativeSectionStart + narrativePages) {
          const chunk = events.filter((_, idx) => idx % narrativePages === p - narrativeSectionStart);
          text = ['DRILLING OPERATIONS SUMMARY', ''];
          if (!chunk.length) text.push(fillerPage(rng, well, 'ENGINEERING'));
          chunk.forEach((event) => {
            text.push(eventNarrative(rng, event));
            pageEvents.push({ eventIndex: events.indexOf(event), pageNo: p });
          });
        } else {
          const topic =
            p % 5 === 0 ? 'ENGINEERING' : p % 7 === 0 ? 'MUD_LOG_CUMULATIVE' : p % 4 === 0 ? 'HSE' : 'GEOLOGY';
          if (topic === 'MUD_LOG_CUMULATIVE') {
            text = ['CUMULATIVE MUD LOG', '', ...well.tops.map((t) => lithologyParagraph(rng, t))].join('\n');
          } else {
            text = fillerPage(rng, well, topic);
          }
        }
        pages.push(makePage(rng, p, text));
      }
      const date = shiftDate(well.spud_date, rng.int(30, Math.max(40, Math.round(well.td_md_m / 6))));
      const doc = {
        filename: `${well.well_name}_WCR_${date.slice(0, 4)}.pdf`,
        doc_type: 'WCR',
        well_name: well.well_name,
        filed_date: date,
        pages,
        pageEvents,
      };
      documents.push(doc);
      pageEvents.forEach(({ eventIndex, pageNo }) =>
        attach.push({ wellName: well.well_name, eventIndex, documentIndex: documents.length - 1, pageNo }),
      );
    }

    // --- Mud log -----------------------------------------------------------
    if (rng.chance(docsPerWell * 0.7)) {
      const pageCount = Math.round(rng.float(8, 20));
      const pages = [];
      const pageEvents = [];
      for (let p = 1; p <= pageCount; p += 1) {
        const text = [
          `MUD LOG — ${well.well_name} — PAGE ${p} OF ${pageCount}`,
          '',
          ...well.tops.map((t) => lithologyParagraph(rng, t)),
          fillerPage(rng, well, 'GEOLOGY'),
        ].join('\n');
        pages.push(makePage(rng, p, text));
      }
      const date = shiftDate(well.spud_date, rng.int(2, Math.max(5, Math.round(well.td_md_m / 12))));
      documents.push({
        filename: `${well.well_name}_MUDLOG_${date.replace(/-/g, '')}.pdf`,
        doc_type: 'MUD_LOG',
        well_name: well.well_name,
        filed_date: date,
        pages,
        pageEvents,
      });
    }

    // --- Cementing report ---------------------------------------------------
    if (well.cementingJobs?.length && rng.chance(docsPerWell * 0.8)) {
      const pageCount = Math.round(rng.float(4, 9));
      const pages = [];
      const pageEvents = [];
      for (let p = 1; p <= pageCount; p += 1) {
        let text = `CEMENTING REPORT — ${well.well_name} — PAGE ${p} OF ${pageCount}\n\n${casingPage(rng, well)}\n`;
        if (p === pageCount - 1) {
          const problemJob = well.cementingJobs.find((j) => j.squeeze_required || j.outcome === 'FAILED');
          if (problemJob) {
            const pseudoEvent = {
              start_md_m: well.sections.find((s) => s.section_no === problemJob.section_no)?.shoe_md_m || 0,
              end_md_m: (well.sections.find((s) => s.section_no === problemJob.section_no)?.shoe_md_m || 0) + 60,
              formation: well.tops[well.tops.length - 1].formationName,
              event_type: problemJob.squeeze_required ? 'Cementing Issue (squeeze required)' : 'Cementing Issue (failed primary job)',
              severity: problemJob.outcome === 'FAILED' ? 4 : 3,
              npt_hours: round(problemJob.wait_on_cement_min / 60 + 6, 1),
              root_cause: `Displacement efficiency of ${problemJob.displacement_efficiency_pct}% left cement in the annulus; ${problemJob.remarks}`,
              action_taken:
                'Remedial squeeze job designed and executed; cement bond verified on a bond log before drilling ahead.',
              action_outcome: 'WORKED',
            };
            text += `REMEDIAL CEMENTING SUMMARY\n\n${eventNarrative(rng, pseudoEvent)}`;
            const syntheticIndex = -1 - documents.length;
            pageEvents.push({ eventIndex: syntheticIndex, pageNo: p, syntheticEvent: pseudoEvent });
            attach.push({
              wellName: well.well_name,
              eventIndex: syntheticIndex,
              documentIndex: documents.length,
              pageNo: p,
              syntheticEvent: pseudoEvent,
            });
          }
        }
        pages.push(makePage(rng, p, text));
      }
      const job = well.cementingJobs[0];
      documents.push({
        filename: `${well.well_name}_CEMENTING_${(job.job_date || well.spud_date).replace(/-/g, '')}.pdf`,
        doc_type: 'CEMENTING_REPORT',
        well_name: well.well_name,
        filed_date: job.job_date,
        pages,
        pageEvents,
      });
    }
  });

  return { documents, eventPlacement: attach };
}

function makePage(rng, pageNo, content) {
  // Accepts a string or an array of blocks. Callers assemble pages as arrays
  // while building them and join once here, so no caller has to remember to.
  const text = Array.isArray(content) ? content.join('\n') : String(content ?? '');
  // ~6% of pages are model images with no text layer, which is exactly the
  // situation the OCR fallback and the human review queue exist for.
  const isImageOnly = rng.chance(0.06) && pageNo > 1;
  return {
    page_no: pageNo,
    text: isImageOnly ? '' : text,
    char_count: isImageOnly ? 0 : text.length,
    text_source: isImageOnly ? 'none' : 'pdf_text_layer',
    // Scanned pages carry lower OCR confidence than born-digital ones.
    ocr_confidence: isImageOnly ? null : round(rng.float(0.93, 0.999), 3),
  };
}

function clusterEvents(events, rng, maxClusters) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.start_md_m - b.start_md_m);
  const buckets = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start_md_m - sorted[i - 1].start_md_m < 220 && current.length < 4) current.push(sorted[i]);
    else {
      buckets.push(current);
      current = [sorted[i]];
    }
  }
  buckets.push(current);
  const shuffled = rng.shuffle(buckets);
  return shuffled.slice(0, Math.max(1, Math.min(maxClusters, buckets.length)));
}

function shiftDate(iso, days) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(1, days));
  return d.toISOString().slice(0, 10);
}