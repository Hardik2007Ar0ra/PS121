import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { wells } from '../src/data/wells.js';
import { events } from '../src/data/events.js';
import { documents } from '../src/data/documents.js';
import { telemetry } from '../src/data/telemetry.js';

const now = () => new Date().toISOString();

function formationCode(formation = '') {
  if (formation.includes('Formation X')) return 3;
  if (formation.includes('Formation Y')) return 2;
  if (formation.includes('Formation W')) return 1;
  return 0;
}

function severityWeight(severity = '') {
  return { Low: 0.25, Medium: 0.55, High: 0.9 }[severity] ?? 0.35;
}

function trajectoryComplexity(trajectory = '') {
  const text = trajectory.toLowerCase();
  if (text.includes('directional')) return 0.8;
  if (text.includes('tangent') || text.includes('s-shaped')) return 0.65;
  return 0.3;
}

export function openDatabase() {
  const db = new Database(process.env.NWIS_DB_PATH || ':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  createSchema(db);
  seedDatabase(db);
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('engineer', 'admin', 'viewer')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wells (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      field TEXT NOT NULL,
      distance_km REAL NOT NULL,
      formation TEXT NOT NULL,
      trajectory TEXT NOT NULL,
      current_depth_m INTEGER NOT NULL,
      total_depth_m INTEGER NOT NULL,
      location TEXT NOT NULL,
      status TEXT,
      similarity INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      reservoir_pressure_psi INTEGER NOT NULL,
      pore_pressure_gradient REAL NOT NULL,
      fracture_gradient REAL NOT NULL,
      casing_program TEXT NOT NULL,
      cementing_practice TEXT NOT NULL,
      mud_program TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operational_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      well_id TEXT NOT NULL,
      well_name TEXT NOT NULL,
      depth_m INTEGER NOT NULL,
      formation TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      event_date TEXT NOT NULL,
      source TEXT NOT NULL,
      npt_hours REAL NOT NULL,
      mitigation TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      FOREIGN KEY (well_id) REFERENCES wells(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      well_id TEXT NOT NULL,
      well_name TEXT NOT NULL,
      type TEXT NOT NULL,
      pages INTEGER NOT NULL,
      year INTEGER NOT NULL,
      events_count INTEGER NOT NULL,
      parameters_count INTEGER NOT NULL,
      source TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      ocr_confidence REAL NOT NULL,
      nlp_entities_json TEXT NOT NULL,
      FOREIGN KEY (well_id) REFERENCES wells(id)
    );

    CREATE TABLE IF NOT EXISTS telemetry_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      depth_m INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      sample_time TEXT NOT NULL,
      torque_knm REAL NOT NULL,
      rop_mhr REAL NOT NULL,
      standpipe_pressure_psi INTEGER NOT NULL,
      mud_weight_sg REAL NOT NULL,
      wob_ton REAL NOT NULL,
      rpm INTEGER NOT NULL,
      flow_rate_lpm INTEGER NOT NULL,
      hook_load_ton REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_training_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      well_id TEXT NOT NULL,
      depth_m INTEGER NOT NULL,
      formation_code INTEGER NOT NULL,
      torque_knm REAL NOT NULL,
      rop_mhr REAL NOT NULL,
      standpipe_pressure_psi INTEGER NOT NULL,
      mud_weight_sg REAL NOT NULL,
      offset_event_density REAL NOT NULL,
      trajectory_complexity REAL NOT NULL,
      similarity_score REAL NOT NULL,
      label INTEGER NOT NULL,
      risk_type TEXT NOT NULL,
      FOREIGN KEY (well_id) REFERENCES wells(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_depth ON operational_events(depth_m);
    CREATE INDEX IF NOT EXISTS idx_events_well ON operational_events(well_id);
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
    CREATE INDEX IF NOT EXISTS idx_training_depth ON risk_training_samples(depth_m);
  `);
}

function seedDatabase(db) {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, created_at)
      VALUES (@name, @email, @password_hash, @role, @created_at)
    `);
    insertUser.run({
      name: 'Demo Drilling Engineer',
      email: 'engineer@nwis.demo',
      password_hash: bcrypt.hashSync('demo1234', 10),
      role: 'engineer',
      created_at: now(),
    });
    insertUser.run({
      name: 'NWIS Admin',
      email: 'admin@nwis.demo',
      password_hash: bcrypt.hashSync('admin1234', 10),
      role: 'admin',
      created_at: now(),
    });
  }

  const wellCount = db.prepare('SELECT COUNT(*) AS count FROM wells').get().count;
  if (wellCount === 0) seedWells(db);

  const eventCount = db.prepare('SELECT COUNT(*) AS count FROM operational_events').get().count;
  if (eventCount === 0) seedEvents(db);

  const documentCount = db.prepare('SELECT COUNT(*) AS count FROM documents').get().count;
  if (documentCount === 0) seedDocuments(db);

  const telemetryCount = db.prepare('SELECT COUNT(*) AS count FROM telemetry_samples').get().count;
  if (telemetryCount === 0) seedTelemetry(db);

  const trainingCount = db.prepare('SELECT COUNT(*) AS count FROM risk_training_samples').get().count;
  if (trainingCount === 0) seedRiskTraining(db);
}

function seedWells(db) {
  const insert = db.prepare(`
    INSERT INTO wells (
      id, name, field, distance_km, formation, trajectory, current_depth_m, total_depth_m,
      location, status, similarity, lat, lng, reservoir_pressure_psi, pore_pressure_gradient,
      fracture_gradient, casing_program, cementing_practice, mud_program
    ) VALUES (
      @id, @name, @field, @distance, @formation, @trajectory, @depth, @td,
      @location, @status, @similarity, @lat, @lng, @reservoir_pressure_psi,
      @pore_pressure_gradient, @fracture_gradient, @casing_program,
      @cementing_practice, @mud_program
    )
  `);

  const enrichments = {
    'A-17': ['9 5/8 in casing planned at 3,050 m', 'Lead-tail slurry with top-up contingency', 'WBM 1.14 SG, LCM sweep available'],
    B: ['9 5/8 in casing set at 3,020 m', 'Two-stage cement job after mud loss', 'WBM 1.13-1.16 SG with LCM pills'],
    C: ['13 3/8 in shoe at 1,900 m; 9 5/8 in at 3,140 m', 'Primary cement satisfactory; excess used across weak zone', 'Inhibitive WBM with torque-reduction additive'],
    D: ['9 5/8 in casing landed above unstable interval', 'Cement squeeze noted in WCR', 'KCl polymer mud with hole-cleaning focus'],
    E: ['Surface and intermediate casing only in prototype interval', 'Standard cementing summary', 'WBM 1.10 SG'],
  };

  const tx = db.transaction(() => {
    wells.forEach((well, index) => {
      const [casing_program, cementing_practice, mud_program] = enrichments[well.id];
      insert.run({
        ...well,
        status: well.status || 'Completed',
        reservoir_pressure_psi: 4200 + index * 165,
        pore_pressure_gradient: +(0.61 + index * 0.015).toFixed(3),
        fracture_gradient: +(0.82 + index * 0.012).toFixed(3),
        casing_program,
        cementing_practice,
        mud_program,
      });
    });
  });
  tx();
}

function seedEvents(db) {
  const insert = db.prepare(`
    INSERT INTO operational_events (
      well_id, well_name, depth_m, formation, event_type, severity, event_date, source,
      npt_hours, mitigation, parameters_json
    ) VALUES (
      @well_id, @well_name, @depth, @formation, @event, @severity, @date, @source,
      @npt_hours, @mitigation, @parameters_json
    )
  `);

  const mitigationByEvent = {
    'Mud Loss': 'Pump LCM pill, reduce ECD, review loss-zone offset history, and maintain trip margin.',
    'Stuck Pipe': 'Stop rotation, work string within limits, circulate bottoms-up, and review pack-off indicators.',
    'High Torque': 'Reduce WOB, improve hole cleaning, circulate high-vis sweep, and compare torque trend with offsets.',
    Kick: 'Flow check, shut-in if confirmed, calculate kill parameters, and follow well-control procedure.',
    'Formation Instability': 'Increase monitoring frequency, review mud weight window, and validate geomechanical model.',
    'Torque Spike': 'Check cuttings loading, review differential sticking risk, and condition hole before drilling ahead.',
    'Lost Circulation': 'Classify loss severity, pump LCM, and update equivalent circulating density envelope.',
    'Tight Hole': 'Ream and circulate, track overpull, and inspect cuttings/lithology correlation.',
    'Bit Balling': 'Adjust hydraulics and bit cleaning, reduce ROP if needed, and inspect mud properties.',
  };

  const tx = db.transaction(() => {
    events.forEach((event, index) => {
      const well = wells.find((candidate) => event.well === candidate.name) || wells[0];
      const baseTorque = 17 + index * 0.55 + severityWeight(event.severity) * 6;
      insert.run({
        ...event,
        well_id: well.id,
        well_name: event.well,
        npt_hours: +(1.5 + severityWeight(event.severity) * 12 + index * 0.25).toFixed(1),
        mitigation: mitigationByEvent[event.event] || 'Review historical evidence and validate with drilling engineer.',
        parameters_json: JSON.stringify({
          torque_knm: +baseTorque.toFixed(1),
          rop_mhr: +(20 - severityWeight(event.severity) * 7).toFixed(1),
          standpipe_pressure_psi: Math.round(2860 + index * 28 + severityWeight(event.severity) * 140),
          mud_weight_sg: +(1.11 + severityWeight(event.severity) * 0.05).toFixed(3),
        }),
      });
    });
  });
  tx();
}

function seedDocuments(db) {
  const insert = db.prepare(`
    INSERT INTO documents (
      name, well_id, well_name, type, pages, year, events_count, parameters_count,
      source, extracted_text, ocr_confidence, nlp_entities_json
    ) VALUES (
      @name, @well_id, @well, @type, @pages, @year, @events, @parameters,
      @source, @text, @ocr_confidence, @nlp_entities_json
    )
  `);

  const tx = db.transaction(() => {
    documents.forEach((document, index) => {
      const well = wells.find((candidate) => document.well === candidate.name || document.well === candidate.id) || wells[0];
      insert.run({
        ...document,
        well_id: well.id,
        ocr_confidence: +(0.88 + index * 0.015).toFixed(3),
        nlp_entities_json: JSON.stringify({
          wells: [document.well],
          depths_m: [...document.text.matchAll(/(\d,\d{3}) m/g)].map((match) => Number(match[1].replace(',', ''))),
          event_terms: events.filter((event) => document.text.includes(event.event)).map((event) => event.event),
          formations: ['Formation X', 'Formation Y'].filter((formation) => document.text.includes(formation)),
        }),
      });
    });
  });
  tx();
}

function seedTelemetry(db) {
  const insert = db.prepare(`
    INSERT INTO telemetry_samples (
      depth_m, minute, sample_time, torque_knm, rop_mhr, standpipe_pressure_psi,
      mud_weight_sg, wob_ton, rpm, flow_rate_lpm, hook_load_ton
    ) VALUES (
      @depth, @minute, @time, @torque, @rop, @pressure, @mudWeight, @wob, @rpm,
      @flow_rate_lpm, @hook_load_ton
    )
  `);

  const tx = db.transaction(() => {
    telemetry.forEach((sample, index) => {
      insert.run({
        ...sample,
        wob: +(13.8 + Math.sin(index / 3) * 0.8).toFixed(1),
        rpm: 118 + (index % 9),
        flow_rate_lpm: 2860 + (index % 6) * 22,
        hook_load_ton: +(174 + index * 0.35 + Math.sin(index / 2) * 2.1).toFixed(1),
      });
    });
  });
  tx();
}

function seedRiskTraining(db) {
  const insert = db.prepare(`
    INSERT INTO risk_training_samples (
      well_id, depth_m, formation_code, torque_knm, rop_mhr, standpipe_pressure_psi,
      mud_weight_sg, offset_event_density, trajectory_complexity, similarity_score, label, risk_type
    ) VALUES (
      @well_id, @depth_m, @formation_code, @torque_knm, @rop_mhr, @standpipe_pressure_psi,
      @mud_weight_sg, @offset_event_density, @trajectory_complexity, @similarity_score, @label, @risk_type
    )
  `);

  const tx = db.transaction(() => {
    wells.forEach((well) => {
      for (let depth = 2400; depth <= 3200; depth += 25) {
        const nearbyEvents = events.filter((event) => Math.abs(event.depth - depth) <= 65);
        const strongest = nearbyEvents.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))[0];
        const density = nearbyEvents.reduce((sum, event) => sum + severityWeight(event.severity), 0);
        const label = strongest && (strongest.severity === 'High' || density >= 1.2) ? 1 : 0;
        const riskType = strongest?.event || 'Normal';
        insert.run({
          well_id: well.id,
          depth_m: depth,
          formation_code: formationCode(well.formation),
          torque_knm: +(16 + (depth - 2400) * 0.012 + density * 2.8 + trajectoryComplexity(well.trajectory)).toFixed(2),
          rop_mhr: +(22 - (depth - 2400) * 0.006 - density * 2.3).toFixed(2),
          standpipe_pressure_psi: Math.round(2700 + (depth - 2400) * 0.42 + density * 115),
          mud_weight_sg: +(1.08 + formationCode(well.formation) * 0.015 + density * 0.012).toFixed(3),
          offset_event_density: +density.toFixed(3),
          trajectory_complexity: trajectoryComplexity(well.trajectory),
          similarity_score: well.similarity / 100,
          label,
          risk_type: riskType,
        });
      }
    });
  });
  tx();
}

export function listWells(db, { radiusKm } = {}) {
  if (radiusKm) {
    return db.prepare('SELECT * FROM wells WHERE distance_km <= ? ORDER BY distance_km ASC').all(radiusKm);
  }
  return db.prepare('SELECT * FROM wells ORDER BY distance_km ASC').all();
}

export function listEvents(db, filters = {}) {
  const clauses = [];
  const params = {};
  if (filters.well) {
    clauses.push('well_name = @well');
    params.well = filters.well;
  }
  if (filters.eventType) {
    clauses.push('event_type = @eventType');
    params.eventType = filters.eventType;
  }
  if (filters.formation) {
    clauses.push('formation = @formation');
    params.formation = filters.formation;
  }
  if (filters.severity) {
    clauses.push('severity = @severity');
    params.severity = filters.severity;
  }
  if (filters.minDepth) {
    clauses.push('depth_m >= @minDepth');
    params.minDepth = Number(filters.minDepth);
  }
  if (filters.maxDepth) {
    clauses.push('depth_m <= @maxDepth');
    params.maxDepth = Number(filters.maxDepth);
  }
  if (filters.q) {
    clauses.push('(well_name LIKE @q OR event_type LIKE @q OR formation LIKE @q OR source LIKE @q OR mitigation LIKE @q)');
    params.q = `%${filters.q}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM operational_events ${where} ORDER BY depth_m ASC`).all(params);
}

export function listDocuments(db, filters = {}) {
  const clauses = [];
  const params = {};
  if (filters.well) {
    clauses.push('well_name = @well');
    params.well = filters.well;
  }
  if (filters.q) {
    clauses.push('(name LIKE @q OR well_name LIKE @q OR type LIKE @q OR extracted_text LIKE @q OR source LIKE @q)');
    params.q = `%${filters.q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM documents ${where} ORDER BY year DESC, name ASC`).all(params);
}

export function latestTelemetry(db, range = 30) {
  const rows = db.prepare(`
    SELECT * FROM telemetry_samples
    ORDER BY minute DESC
    LIMIT ?
  `).all(Number(range) + 1);
  return rows.reverse();
}

export function parseJsonColumns(row, columns) {
  if (!row) return row;
  const output = { ...row };
  columns.forEach((column) => {
    if (output[column]) output[column] = JSON.parse(output[column]);
  });
  return output;
}
