/**
 * Persists the generated corpus into the database.
 *
 * Ordering matters because foreign keys are enforced: parents before children,
 * and the search index last so IDF weights are computed against the final
 * corpus. The whole seed runs in a single transaction so a failure leaves the
 * database empty rather than half-populated.
 *
 * Ground-truth events are written with `detected_by = 'derived'` and a
 * provenance row pointing at the document page that narrates them. The NLP
 * pipeline later extracts events independently from the same text, and
 * `npm run nlp:evaluate` scores the extraction against these rows.
 */

import bcrypt from 'bcryptjs';
import { buildCorpus } from './generator/index.js';
import { chunkText } from '../search/embed.js';
import { indexKnowledgeItems } from '../search/store.js';
import { createIdfSource } from '../search/embed.js';
import logger from '../util/logger.js';
import { buildFeaturesForWell } from '../ml/features/extract.js';
import {
  FEATURE_VERSION,
  RISK_TYPES,
  buildCementingTrainingRows,
  buildFormationPriors,
  buildPriorIndex,
  buildTrainingRows,
} from '../ml/features/dataset.js';

// Every row in a seed run genuinely shares one instant — the corpus describes one
// snapshot of the field, not a history — and calling new Date() per row was a
// measurable share of seed time for no informational gain.
const SEED_TIME = new Date().toISOString();
const now = () => SEED_TIME;

const DEMO_USERS = [
  { name: 'Demo Engineer', email: 'engineer@nwis.demo', password: 'demo1234', role: 'engineer' },
  { name: 'Demo Admin', email: 'admin@nwis.demo', password: 'admin1234', role: 'admin' },
  { name: 'Demo Viewer', email: 'viewer@nwis.demo', password: 'viewer1234', role: 'viewer' },
];

export function isSeeded(db) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wells'")
    .get();
  if (!table) return false;
  const count = db.prepare('SELECT COUNT(*) AS c FROM wells').get().c;
  return count > 0;
}

export function seed(db, options = {}) {
  const started = Date.now();
  const corpus = buildCorpus(options.seed, {
    nWells: options.nWells,
    nFields: options.nFields,
    docsPerWell: options.docsPerWell,
  });

  const idf = createIdfSource(db);
  const knowledgeItems = [];

  // Offset-well experience aggregated per formation, used as a model feature.
  const priorIndex = buildPriorIndex(corpus.wells, corpus.events);

  const run = db.transaction(() => {
    // --- Fields ------------------------------------------------------------
    const insertField = db.prepare(`
      INSERT INTO fields (code, name, basin, district, operator, created_at)
      VALUES (@code, @name, @basin, @district, @operator, @created_at)
    `);
    const fieldIds = new Map();
    corpus.fields.forEach((field) => {
      const result = insertField.run({ ...field, created_at: now() });
      fieldIds.set(field.code, Number(result.lastInsertRowid));
    });

    // --- Formations --------------------------------------------------------
    const insertFormation = db.prepare(`
      INSERT INTO formations (code, name, field_id, age, lithology, description, correlates_with, created_at)
      VALUES (@code, @name, @field_id, @age, @lithology, @description, @correlates_with, @created_at)
    `);
    const formationIds = new Map();
    corpus.formationIndex.forEach((formation, key) => {
      const result = insertFormation.run({
        code: formation.code,
        name: formation.name,
        field_id: fieldIds.get(formation.fieldCode),
        age: formation.age,
        lithology: formation.lithology,
        description: formation.description,
        // Formations are catalogued per field, so the correlation key is
        // "field:code" rather than the bare code.
        correlates_with: formation.correlates_with
          ? `${formation.fieldCode}:${formation.correlates_with}`
          : null,
        created_at: now(),
      });
      formationIds.set(key, Number(result.lastInsertRowid));
    });

    // --- Reservoirs --------------------------------------------------------
    const insertReservoir = db.prepare(`
      INSERT INTO reservoirs (name, fluid_type, pressure_psi, pressure_gradient, temperature_c,
                             permeability_md, porosity_pct, producer, notes)
      VALUES (@name, @fluid_type, @pressure_psi, @pressure_gradient, @temperature_c,
              @permeability_md, @porosity_pct, @producer, @notes)
    `);
    const reservoirIds = new Map();
    corpus.reservoirs.forEach((reservoir) => {
      const result = insertReservoir.run({
        ...reservoir,
        // The generator uses descriptive fluid labels; the column is constrained
        // to OIL/GAS/WATER/MULTI, so anything else maps to MULTI.
        fluid_type: ['OIL', 'GAS', 'WATER', 'MULTI'].includes(reservoir.fluid_type) ? reservoir.fluid_type : 'MULTI',
        notes: `${reservoir.fluid_type} accumulation. ${reservoir.producer ? `Produced by ${reservoir.producer}.` : ''}`.trim(),
      });
      reservoirIds.set(reservoir.name, Number(result.lastInsertRowid));
    });

    const insertFormationReservoir = db.prepare(`
      INSERT OR IGNORE INTO formation_reservoirs (formation_id, reservoir_id, role)
      VALUES (?, ?, ?)
    `);
    corpus.formationIndex.forEach((formation, key) => {
      if (!formation.reservoirName) return;
      const reservoirId = reservoirIds.get(formation.reservoirName);
      if (!reservoirId) return;
      const field = corpus.fields.find((f) => f.code === formation.fieldCode);
      const order = field?.formations.findIndex((f) => f.code === formation.code) ?? -1;
      insertFormationReservoir.run(formationIds.get(key), reservoirId, order <= 2 ? 'TARGET' : 'PARENT');
    });

    // --- Wells -------------------------------------------------------------
    const insertWell = db.prepare(`
      INSERT INTO wells (
        well_name, field_id, uwi, well_type, spud_date, completion_date, status,
        lat, lng, kb_elevation_m, sea_level_elevation_m, spud_kb_m, td_md_m, td_tvd_m,
        spud_pressure_psi, pore_pressure_gradient, fracture_gradient, water_depth_m,
        is_active, created_at, updated_at
      ) VALUES (
        @well_name, @field_id, @uwi, @well_type, @spud_date, @completion_date, @status,
        @lat, @lng, @kb_elevation_m, @sea_level_elevation_m, @spud_kb_m, @td_md_m, @td_tvd_m,
        @spud_pressure_psi, @pore_pressure_gradient, @fracture_gradient, @water_depth_m,
        @is_active, @created_at, @updated_at
      )
    `);
    const wellIds = new Map();
    corpus.wells.forEach((well) => {
      const result = insertWell.run({
        well_name: well.well_name,
        field_id: fieldIds.get(well.fieldCode),
        uwi: well.uwi,
        well_type: well.well_type,
        spud_date: well.spud_date,
        completion_date: well.completion_date,
        status: well.status,
        lat: well.lat,
        lng: well.lng,
        kb_elevation_m: well.kb_elevation_m,
        sea_level_elevation_m: well.sea_level_elevation_m,
        spud_kb_m: well.spud_kb_m,
        td_md_m: well.td_md_m,
        td_tvd_m: well.td_tvd_m,
        spud_pressure_psi: well.spud_pressure_psi,
        pore_pressure_gradient: well.pore_pressure_gradient,
        fracture_gradient: well.fracture_gradient,
        water_depth_m: well.water_depth_m,
        is_active: well.is_active,
        created_at: now(),
        updated_at: now(),
      });
      wellIds.set(well.well_name, Number(result.lastInsertRowid));
    });

    // --- Formation tops ----------------------------------------------------
    const insertTop = db.prepare(`
      INSERT INTO formation_tops (
        well_id, formation_id, top_md_m, top_tvd_m, tvd_ss_m, base_md_m, base_tvd_m,
        thickness_m, depth_reference, confidence, method
      ) VALUES (
        @well_id, @formation_id, @top_md_m, @top_tvd_m, @tvd_ss_m, @base_md_m, @base_tvd_m,
        @thickness_m, @depth_reference, @confidence, @method
      )
    `);
    corpus.wells.forEach((well) => {
      const wellId = wellIds.get(well.well_name);
      const ssOffset = well.sea_level_elevation_m ?? 0;
      well.tops.forEach((top) => {
        insertTop.run({
          well_id: wellId,
          formation_id: formationIds.get(`${well.fieldCode}:${top.formationCode}`),
          top_md_m: top.top_md_m,
          top_tvd_m: top.top_tvd_m,
          tvd_ss_m: top.top_tvd_m - ssOffset,
          base_md_m: top.base_md_m,
          base_tvd_m: top.base_tvd_m,
          thickness_m: top.thickness_m,
          depth_reference: 'MD',
          confidence: top.confidence,
          method: top.method,
        });
      });
    });

    // --- Trajectory --------------------------------------------------------
    const insertSurvey = db.prepare(`
      INSERT INTO trajectory_surveys (
        well_id, md_m, inclination_deg, azimuth_deg, tvd_m, north_m, east_m,
        atge_deg, dogleg_deg_per_30m
      ) VALUES (@well_id, @md_m, @inclination_deg, @azimuth_deg, @tvd_m, @north_m, @east_m, @atge_deg, @dogleg)
    `);
    corpus.surveysByWell.forEach((surveys, wellName) => {
      const wellId = wellIds.get(wellName);
      surveys.forEach((station) => {
        insertSurvey.run({
          well_id: wellId,
          md_m: station.md_m,
          inclination_deg: station.inclination_deg,
          azimuth_deg: station.azimuth_deg,
          tvd_m: station.tvd_m,
          north_m: station.north_m,
          east_m: station.east_m,
          atge_deg: station.atge_deg,
          dogleg: station.dogleg_deg_per_30m,
        });
      });
    });

    // --- Casing / cementing / mud programmes --------------------------------
    const insertSection = db.prepare(`
      INSERT INTO well_sections (
        well_id, section_no, section_name, hole_size_in, casing_size_in, casing_grade,
        shoe_md_m, shoe_tvd_m, top_md_m, grouted_md_m, depth_reference,
        design_ecd_ppg, design_maasp_psi
      ) VALUES (
        @well_id, @section_no, @section_name, @hole_size_in, @casing_size_in, @casing_grade,
        @shoe_md_m, @shoe_tvd_m, @top_md_m, @grouted_md_m, @depth_reference,
        @design_ecd_ppg, @design_maasp_psi
      )
    `);
    const insertCementing = db.prepare(`
      INSERT INTO cementing_jobs (
        well_id, section_id, job_date, job_type, cement_system, lead_volume_bbl,
        tail_volume_bbl, spacers_volume_bbl, flush_volume_bbl, u_tubing_bbl,
        displacement_efficiency_pct, annular_capacity_bbl, wait_on_cement_min,
        squeeze_required, remarks, outcome
      ) VALUES (
        @well_id, @section_id, @job_date, @job_type, @cement_system, @lead_volume_bbl,
        @tail_volume_bbl, @spacers_volume_bbl, @flush_volume_bbl, @u_tubing_bbl,
        @displacement_efficiency_pct, @annular_capacity_bbl, @wait_on_cement_min,
        @squeeze_required, @remarks, @outcome
      )
    `);
    const insertMud = db.prepare(`
      INSERT INTO mud_programs (
        well_id, interval_from_md_m, interval_to_md_m, depth_reference, system, fluid_type,
        density_ppg, funnel_viscosity_s, pv_cp, yp_lbf_100ft2, ph, filtration_ml_30min,
        lcm_type, lcm_ration_ppb, additive, inhibitiveness_note
      ) VALUES (
        @well_id, @interval_from_md_m, @interval_to_md_m, @depth_reference, @system, @fluid_type,
        @density_ppg, @funnel_viscosity_s, @pv_cp, @yp_lbf_100ft2, @ph, @filtration_ml_30min,
        @lcm_type, @lcm_ration_ppb, @additive, @inhibitiveness_note
      )
    `);

    corpus.wells.forEach((well) => {
      const wellId = wellIds.get(well.well_name);
      const sectionIds = new Map();
      well.sections.forEach((section) => {
        const result = insertSection.run({
          well_id: wellId,
          section_no: section.section_no,
          section_name: section.section_name,
          hole_size_in: section.hole_size_in,
          casing_size_in: section.casing_size_in,
          casing_grade: section.casing_grade,
          shoe_md_m: section.shoe_md_m,
          shoe_tvd_m: section.shoe_tvd_m,
          top_md_m: section.top_md_m,
          grouted_md_m: section.grouted_md_m,
          depth_reference: section.depth_reference,
          design_ecd_ppg: section.design_ecd_ppg,
          design_maasp_psi: section.design_maasp_psi,
        });
        sectionIds.set(section.section_no, Number(result.lastInsertRowid));
      });
      well.cementingJobs.forEach((job) => {
        insertCementing.run({
          well_id: wellId,
          section_id: sectionIds.get(job.section_no),
          job_date: job.job_date,
          job_type: job.job_type,
          cement_system: job.cement_system,
          lead_volume_bbl: job.lead_volume_bbl,
          tail_volume_bbl: job.tail_volume_bbl,
          spacers_volume_bbl: job.spacers_volume_bbl,
          flush_volume_bbl: job.flush_volume_bbl,
          u_tubing_bbl: job.u_tubing_bbl,
          displacement_efficiency_pct: job.displacement_efficiency_pct,
          annular_capacity_bbl: job.annular_capacity_bbl,
          wait_on_cement_min: job.wait_on_cement_min,
          squeeze_required: job.squeeze_required,
          remarks: job.remarks,
          outcome: job.outcome,
        });
      });
      well.mudPrograms.forEach((mud) => {
        insertMud.run({
          well_id: wellId,
          interval_from_md_m: mud.interval_from_md_m,
          interval_to_md_m: mud.interval_to_md_m,
          depth_reference: mud.depth_reference,
          system: mud.system,
          fluid_type: mud.fluid_type,
          density_ppg: mud.density_ppg,
          funnel_viscosity_s: mud.funnel_viscosity_s,
          pv_cp: mud.pv_cp,
          yp_lbf_100ft2: mud.yp_lbf_100ft2,
          ph: mud.ph,
          filtration_ml_30min: mud.filtration_ml_30min,
          lcm_type: mud.lcm_type,
          lcm_ration_ppb: mud.lcm_ration_ppb,
          additive: mud.additive,
          inhibitiveness_note: mud.inhibitiveness_note,
        });
      });
    });

    // --- Documents + pages + chunks ----------------------------------------
    const insertDocument = db.prepare(`
      INSERT INTO documents (
        filename, doc_type, well_id, well_name, filed_date, year, page_count,
        file_size_bytes, ocr_status, ocr_confidence, text_source, pages_ocr_total,
        pages_ocr_text, extracted_count, processed_at, created_at
      ) VALUES (
        @filename, @doc_type, @well_id, @well_name, @filed_date, @year, @page_count,
        @file_size_bytes, @ocr_status, @ocr_confidence, @text_source, @pages_ocr_total,
        @pages_ocr_text, @extracted_count, @processed_at, @created_at
      )
    `);
    const insertPage = db.prepare(`
      INSERT INTO document_pages (
        document_id, page_no, text, char_count, text_source, ocr_confidence, ocr_engine
      ) VALUES (@document_id, @page_no, @text, @char_count, @text_source, @ocr_confidence, @ocr_engine)
    `);
    const insertChunk = db.prepare(`
      INSERT INTO document_chunks (
        document_id, page_no, chunk_no, section_type, text, token_count, well_id,
        depth_md_m, created_at
      ) VALUES (
        @document_id, @page_no, @chunk_no, @section_type, @text, @token_count, @well_id,
        @depth_md_m, @created_at
      )
    `);

    const documentIds = new Map();
    corpus.documents.forEach((document) => {
      const wellId = wellIds.get(document.well_name);
      const imagePages = document.pages.filter((p) => p.text_source === 'none').length;
      const confidences = document.pages.filter((p) => p.ocr_confidence != null).map((p) => p.ocr_confidence);
      const avgConfidence = confidences.length
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      const result = insertDocument.run({
        filename: document.filename,
        doc_type: document.doc_type,
        well_id: wellId,
        well_name: document.well_name,
        filed_date: document.filed_date,
        year: document.filed_date ? Number(document.filed_date.slice(0, 4)) : null,
        page_count: document.pages.length,
        file_size_bytes: document.pages.reduce((sum, p) => sum + p.text.length, 0) * 3,
        ocr_status: imagePages > 0 ? (imagePages === document.pages.length ? 'partial' : 'text') : 'text',
        ocr_confidence: avgConfidence != null ? Number(avgConfidence.toFixed(4)) : null,
        text_source: imagePages > 0 ? 'mixed' : 'pdf_text_layer',
        pages_ocr_total: imagePages,
        pages_ocr_text: document.pages.length - imagePages,
        extracted_count: document.pageEvents.length,
        processed_at: now(),
        created_at: now(),
      });
      const documentId = Number(result.lastInsertRowid);
      documentIds.set(document.filename, documentId);

      document.pages.forEach((page) => {
        try {
          insertPage.run({
            document_id: documentId,
            page_no: page.page_no,
            text: page.text,
            char_count: page.char_count,
            text_source: page.text_source,
            ocr_confidence: page.ocr_confidence,
            ocr_engine: page.text_source === 'none' ? null : 'pdf_text_layer',
          });
        } catch (error) {
          throw new Error(
            `document_pages insert failed for ${document.filename} page ${page.page_no}: ${error.message}\n` +
              `payload types ${Object.entries(page).map(([k, v]) => `${k}=${typeof v}`).join(', ')}`,
          );
        }
        if (!page.text) return;
        const chunks = chunkText(page.text);
        chunks.forEach((text, chunkNo) => {
          const chunkResult = insertChunk.run({
            document_id: documentId,
            page_no: page.page_no,
            chunk_no: chunkNo + 1,
            section_type: sectionTypeOf(text),
            text,
            token_count: text.split(/\s+/).filter(Boolean).length,
            well_id: wellId,
            depth_md_m: null,
            created_at: now(),
          });
          knowledgeItems.push({
            kind: 'document_chunk',
            ref: `chunk:${documentId}:${page.page_no}:${chunkNo + 1}`,
            wellId,
            wellName: document.well_name,
            title: `${document.filename} p.${page.page_no}`,
            body: text,
            depthMd: null,
            documentId,
            pageNo: page.page_no,
            citations: [{ documentId, page: page.page_no, filename: document.filename }],
          });
          void chunkResult;
        });
      });
    });

    // --- Events + provenance + lessons -------------------------------------
    const insertEvent = db.prepare(`
      INSERT INTO operational_events (
        well_id, well_name, category, event_type, subtype, formation_id, formation,
        depth_reference, start_md_m, end_md_m, depth_m, event_date, severity, npt_hours,
        npt_hours_total, volume_loss_bbl, root_cause, action_taken, action_outcome, detected_by,
        detection_confidence, source_label, status, created_at, updated_at
      ) VALUES (
        @well_id, @well_name, @category, @event_type, @subtype, @formation_id, @formation,
        @depth_reference, @start_md_m, @end_md_m, @depth_m, @event_date, @severity, @npt_hours,
        @npt_hours_total, @volume_loss_bbl, @root_cause, @action_taken, @action_outcome, @detected_by,
        @detection_confidence, @source_label, @status, @created_at, @updated_at
      )
    `);
    const insertProvenance = db.prepare(`
      INSERT INTO event_provenance (
        event_id, source_type, document_id, page_no, snippet, ocr_confidence,
        extractor_version, method, review_state
      ) VALUES (@event_id, @source_type, @document_id, @page_no, @snippet, @ocr_confidence,
                @extractor_version, @method, @review_state)
    `);
    const insertLesson = db.prepare(`
      INSERT INTO lessons_learned (
        title, well_id, formation_id, event_id, category, depth_md_m, challenge,
        root_cause, action_taken, effectiveness, transferable, applicability_note,
        tags, author, source_document_id, created_at, updated_at
      ) VALUES (
        @title, @well_id, @formation_id, @event_id, @category, @depth_md_m, @challenge,
        @root_cause, @action_taken, @effectiveness, @transferable, @applicability_note,
        @tags, @author, @source_document_id, @created_at, @updated_at
      )
    `);

    const eventIds = new Map();
    corpus.events.forEach((event) => {
      const well = corpus.wells.find((w) => w.well_name === event.well_name);
      const formationKey = `${well?.fieldCode}:${event.formationCode}`;
      const result = insertEvent.run({
        well_id: wellIds.get(event.well_name),
        well_name: event.well_name,
        category: event.category,
        event_type: event.event_type,
        subtype: event.subtype,
        formation_id: formationIds.get(formationKey) ?? null,
        formation: event.formation,
        depth_reference: event.depth_reference || 'MD',
        start_md_m: event.start_md_m,
        end_md_m: event.end_md_m,
        depth_m: event.depth_m,
        event_date: well?.spud_date ?? null,
        severity: event.severity,
        npt_hours: event.npt_hours,
        npt_hours_total: event.npt_hours ?? 0,
        volume_loss_bbl: event.volume_loss_bbl,
        root_cause: event.root_cause,
        action_taken: event.action_taken,
        action_outcome: event.action_outcome,
        detected_by: 'telemetry_rule',
        // Rule detection over injected physics, so confidence is high but not
        // a flat 1.0 — a reviewer should still be able to challenge these.
        detection_confidence: 0.94,
        source_label: event.source_label,
        status: 'verified',
        created_at: now(),
        updated_at: now(),
      });
      const eventId = Number(result.lastInsertRowid);
      eventIds.set(event.id, eventId);

      const documentId = documentIds.get(corpus.documents[event.source_document_index]?.filename) ?? null;
      insertProvenance.run({
        event_id: eventId,
        source_type: documentId ? 'document' : 'telemetry',
        document_id: documentId,
        page_no: event.source_page_no ?? null,
        snippet: `${event.event_type} at ${Math.round(event.start_md_m)} m in ${event.formation}. ${event.root_cause ?? ''}`.slice(0, 400),
        ocr_confidence: documentId ? 0.96 : null,
        extractor_version: 'generator:ground-truth',
        method: 'deterministic-simulation',
        review_state: 'accepted',
      });

      knowledgeItems.push({
        kind: 'event',
        ref: `event:${eventId}`,
        wellId: wellIds.get(event.well_name),
        wellName: event.well_name,
        title: `${event.event_type} — ${event.formation} at ${Math.round(event.start_md_m)} m`,
        body: [event.root_cause, event.action_taken, event.action_outcome ? `Outcome: ${event.action_outcome}.` : null]
          .filter(Boolean)
          .join(' '),
        depthMd: event.start_md_m,
        formationId: formationIds.get(formationKey) ?? null,
        formation: event.formation,
        eventId,
        documentId,
        pageNo: event.source_page_no ?? null,
      });
    });

    corpus.lessons.forEach((lesson) => {
      const eventId = eventIds.get(lesson.event_id) ?? null;
      const event = corpus.events.find((e) => e.id === lesson.event_id);
      const well = corpus.wells.find((w) => w.well_name === lesson.well_name);
      const result = insertLesson.run({
        title: lesson.title,
        well_id: wellIds.get(lesson.well_name) ?? null,
        formation_id: formationIds.get(`${well?.fieldCode}:${event?.formationCode}`) ?? null,
        event_id: eventId,
        category: lesson.category,
        depth_md_m: lesson.depth_md_m,
        challenge: lesson.challenge,
        root_cause: lesson.root_cause,
        action_taken: lesson.action_taken,
        effectiveness: lesson.effectiveness || 'UNKNOWN',
        transferable: lesson.transferable,
        applicability_note: lesson.applicability_note,
        tags: (lesson.tags || []).join(','),
        author: lesson.author,
        source_document_id: eventId ? documentIds.get(corpus.documents[event?.source_document_index]?.filename) ?? null : null,
        created_at: now(),
        updated_at: now(),
      });
      knowledgeItems.push({
        kind: 'lesson',
        ref: `lesson:${Number(result.lastInsertRowid)}`,
        wellId: wellIds.get(lesson.well_name) ?? null,
        wellName: lesson.well_name,
        title: lesson.title,
        body: [lesson.challenge, lesson.root_cause, lesson.action_taken, lesson.applicability_note]
          .filter(Boolean)
          .join(' '),
        depthMd: lesson.depth_md_m,
        eventId,
        formationId: formationIds.get(`${well?.fieldCode}:${event?.formationCode}`) ?? null,
      });
    });

    // Casing and mud programme rows are searchable knowledge objects too, so a
    // query like "shoe depth above 1500 m" reaches programme data as well as
    // report prose.
    corpus.wells.forEach((well) => {
      well.sections
        .filter((s) => s.casing_size_in)
        .forEach((section) => {
          const job = well.cementingJobs?.find((j) => j.section_no === section.section_no);
          knowledgeItems.push({
            kind: 'well_section',
            ref: `section:${well.well_name}:${section.section_no}`,
            wellId: wellIds.get(well.well_name),
            wellName: well.well_name,
            title: `${section.section_name} casing ${section.casing_size_in}" shoe at ${section.shoe_md_m} m`,
            body: `${section.hole_size_in} in hole with ${section.casing_size_in} in ${section.casing_grade} casing, shoe at ${section.shoe_md_m} m MD / ${section.shoe_tvd_m} m TVD. ${job ? `Cement job ${job.job_type} with ${job.displacement_efficiency_pct}% displacement efficiency, outcome ${job.outcome}.` : ''}`,
            depthMd: section.shoe_md_m,
          });
        });
      well.mudPrograms.forEach((mud) => {
        knowledgeItems.push({
          kind: 'mud_program',
          ref: `mud:${well.well_name}:${mud.interval_from_md_m}`,
          wellId: wellIds.get(well.well_name),
          wellName: well.well_name,
          title: `${mud.system} mud ${mud.density_ppg} ppg from ${mud.interval_from_md_m} to ${mud.interval_to_md_m} m`,
          body: `${mud.system} (${mud.fluid_type}) ${mud.density_ppg} ppg programmed from ${mud.interval_from_md_m} m to ${mud.interval_to_md_m} m. FV ${mud.funnel_viscosity_s} s, PV ${mud.pv_cp} cP, YP ${mud.yp_lbf_100ft2} lbf/100ft2. ${mud.lcm_type ? `LCM ${mud.lcm_type} at ${mud.lcm_ration_ppb} ppb. ` : ''}${mud.inhibitiveness_note ?? ''}`,
            depthMd: mud.interval_from_md_m,
          });
        });
    });

    // --- Telemetry + trajectory features ------------------------------------
    const insertTelemetry = db.prepare(`
      INSERT INTO telemetry_samples (
        well_id, ts, depth_md_m, bit_depth_md_m, torque_knm, drag_knm, rop_mhr, wob_ton,
        rpm, hook_load_ton, spp_psi, flow_out_lpm, pit_volume_m3, mud_weight_ppg, ecd_ppg,
        flow_bit_ms, gas_ratio_ppm, source
      ) VALUES (
        @well_id, @ts, @depth_md_m, @bit_depth_md_m, @torque_knm, @drag_knm, @rop_mhr, @wob_ton,
        @rpm, @hook_load_ton, @spp_psi, @flow_out_lpm, @pit_volume_m3, @mud_weight_ppg, @ecd_ppg,
        @flow_bit_ms, @gas_ratio_ppm, @source
      )
    `);
    const insertTrajectoryFeature = db.prepare(`
      INSERT INTO trajectory_features (
        well_id, depth_md_m, formation_id, d_exponent, lithology_index,
        normalised_d_exponent, overbalance_flag, underbalance_flag
      ) VALUES (@well_id, @depth_md_m, @formation_id, @d_exponent, @lithology_index,
                @normalised_d_exponent, @overbalance_flag, @underbalance_flag)
    `);

    corpus.dynamicsByWell.forEach((dynamics, wellName) => {
      const well = corpus.wells.find((w) => w.well_name === wellName);
      const wellId = wellIds.get(wellName);
      dynamics.samples.forEach((sample) => {
        insertTelemetry.run({
          well_id: wellId,
          ts: sample.ts,
          depth_md_m: sample.depth_md_m,
          bit_depth_md_m: sample.bit_depth_md_m,
          torque_knm: sample.torque_knm,
          drag_knm: sample.drag_knm,
          rop_mhr: sample.rop_mhr,
          wob_ton: sample.wob_ton,
          rpm: sample.rpm,
          hook_load_ton: sample.hook_load_ton,
          spp_psi: sample.spp_psi,
          flow_out_lpm: sample.flow_out_lpm,
          pit_volume_m3: sample.pit_volume_m3,
          mud_weight_ppg: sample.mud_weight_ppg,
          ecd_ppg: sample.ecd_ppg,
          flow_bit_ms: sample.flow_bit_ms,
          gas_ratio_ppm: sample.gas_ratio_ppm,
          source: 'generator',
        });
      });
      dynamics.trajectoryFeatures.forEach((feature) => {
        insertTrajectoryFeature.run({
          well_id: wellId,
          depth_md_m: feature.depth_md_m,
          formation_id: formationIds.get(`${well.fieldCode}:${feature.formationCode}`) ?? null,
          d_exponent: feature.d_exponent,
          lithology_index: feature.lithology_index,
          normalised_d_exponent: feature.normalised_d_exponent,
          overbalance_flag: feature.overbalance_flag,
          underbalance_flag: feature.underbalance_flag,
        });
      });
    });

    // --- Users -------------------------------------------------------------
    const insertUser = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, created_at)
      VALUES (@name, @email, @password_hash, @role, @created_at)
    `);
    DEMO_USERS.forEach((user) => {
      insertUser.run({
        name: user.name,
        email: user.email,
        password_hash: bcrypt.hashSync(user.password, 10),
        role: user.role,
        created_at: now(),
      });
    });

    // --- Alert rules -------------------------------------------------------
    const insertRule = db.prepare(`
      INSERT INTO alert_rules (
        name, risk_type, look_ahead_m, trigger_score, severity, min_evidence,
        cooldown_min, enabled, created_at, updated_at
      ) VALUES (@name, @risk_type, @look_ahead_m, @trigger_score, @severity, @min_evidence,
                @cooldown_min, @enabled, @created_at, @updated_at)
    `);
    RISK_TYPES.forEach((risk) => {
      insertRule.run({
        name: `${risk.label} look-ahead`,
        risk_type: risk.id,
        look_ahead_m: risk.defaultLookAheadM,
        trigger_score: risk.defaultThreshold,
        severity: risk.defaultSeverity,
        min_evidence: risk.minEvidence,
        cooldown_min: 180,
        enabled: 1,
        created_at: now(),
        updated_at: now(),
      });
    });

    // --- ML feature store + training rows ----------------------------------
    // Feature vectors are materialised once here and reused unchanged by both
    // training and online inference, which is what keeps the two in agreement.
    const insertFeatureRow = db.prepare(`
      INSERT OR REPLACE INTO feature_store (
        well_id, depth_md_m, formation_id, feature_version, features_json, created_at
      ) VALUES (@well_id, @depth_md_m, @formation_id, @feature_version, @features_json, @created_at)
    `);
    const insertTrainingRow = db.prepare(`
      INSERT OR REPLACE INTO risk_training_samples (
        well_id, depth_md_m, risk_type, label, target_value, features_json, label_source,
        split_group, feature_version, created_at
      ) VALUES (@well_id, @depth_md_m, @risk_type, @label, @target_value, @features_json, @label_source,
                @split_group, @feature_version, @created_at)
    `);

    let featureCount = 0;
    let trainingCount = 0;

    corpus.wells.forEach((well) => {
      const wellId = wellIds.get(well.well_name);
      const samples = corpus.dynamicsByWell.get(well.well_name).samples;
      // Leave-one-well-out priors: a well's own history never becomes its own
      // prior, so the model cannot learn "this formation is dangerous because I
      // already had trouble in it".
      const priors = buildFormationPriors(priorIndex, formationCodesFor(well), well.well_name);

      const features = buildFeaturesForWell({ well, samples, sections: well.sections, formationPriors: priors });
      featureCount += features.length;

      features.forEach((feature) => {
        insertFeatureRow.run({
          well_id: wellId,
          depth_md_m: feature.depthMd,
          formation_id: formationIds.get(`${well.fieldCode}:${feature.formationCode}`) ?? null,
          feature_version: FEATURE_VERSION,
          features_json: JSON.stringify(feature.values),
          created_at: now(),
        });
      });

      buildTrainingRows({
        well,
        features,
        events: corpus.events.filter((e) => e.well_name === well.well_name),
      }).forEach((row) => {
        insertTrainingRow.run({ ...row, well_id: wellId, created_at: now() });
        trainingCount += 1;
      });

      buildCementingTrainingRows({
        well,
        sections: well.sections,
        jobs: well.cementingJobs,
        topAt: (depth) => well.tops.find((t) => depth >= t.top_md_m && depth <= t.base_md_m) || well.tops[well.tops.length - 1],
      }).forEach((row) => {
        insertTrainingRow.run({ ...row, well_id: wellId, created_at: now() });
        trainingCount += 1;
      });
    });

    // --- Search index ------------------------------------------------------
    indexKnowledgeItems(db, idf, knowledgeItems);

    return { featureCount, trainingCount, knowledgeCount: knowledgeItems.length };
  });

  const stats = run();

  const summary = {
    ...corpus.summary,
    knowledgeItems: stats.knowledgeCount,
    featureRows: stats.featureCount,
    trainingRows: stats.trainingCount,
    seedMs: Date.now() - started,
  };

  logger.info(
    {
      fields: summary.fields,
      wells: summary.wells,
      formations: summary.formations,
      events: summary.events,
      eventsByCategory: summary.eventsByCategory,
      lessons: summary.lessons,
      documents: summary.documents,
      documentPages: summary.documentPages,
      telemetrySamples: summary.telemetrySamples,
      featureRows: summary.featureRows,
      trainingRows: summary.trainingRows,
      seedMs: summary.seedMs,
    },
    'corpus seeded',
  );
  return summary;
}

function formationCodesFor(well) {
  return well.tops.map((top) => top.formationCode);
}

function sectionTypeOf(text) {
  const head = text.slice(0, 400).toLowerCase();
  if (/daily drilling report/.test(head)) return 'daily_operations';
  if (/drilling operations summary|engineering/.test(head)) return 'operations_summary';
  if (/stratigraphic summary/.test(head)) return 'stratigraphy';
  if (/cumulative mud log/.test(head)) return 'mud_log';
  if (/mud programme summary/.test(head)) return 'mud_program';
  if (/casing and cementing record/.test(head)) return 'casing_cementing';
  if (/directional survey/.test(head)) return 'trajectory';
  if (/health, safety/.test(head)) return 'hse';
  if (/bit and bha/.test(head)) return 'engineering';
  if (/formation test/.test(head)) return 'formation_test';
  if (/well completion/.test(head)) return 'well_summary';
  return 'narrative';
}