/**
 * 004 — Operational events, provenance and lessons learned.
 *
 * Three things the prototype lacked:
 *   1. A controlled event taxonomy (PS asks for mud losses, kicks, stuck pipe,
 *      fishing operations and NPT events specifically).
 *   2. Numeric severity instead of a 'Low/Medium/High' string.
 *   3. Provenance — every extracted fact must point back at the document and
 *      page it came from, and at the extractor version that produced it.
 */
export default {
  name: '004_events',
  up: (db) => {
    db.exec(`
      CREATE TABLE operational_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id         INTEGER NOT NULL REFERENCES wells(id),
        well_name       TEXT NOT NULL,
        category        TEXT NOT NULL CHECK (category IN (
                          'MUD_LOSS','KICK','STUCK_PIPE','TORQUE_SPIKE','HOLE_INSTABILITY',
                          'CEMENTING_ISSUE','FISHING','NPT','TRIPPING','BIT_BALLING',
                          'HOLE_CLEANING','EQUIPMENT_FAILURE','OTHER')),
        event_type      TEXT NOT NULL,
        subtype         TEXT,
        formation_id    INTEGER REFERENCES formations(id),
        formation       TEXT,
        depth_reference TEXT NOT NULL DEFAULT 'MD',
        start_md_m      REAL,
        end_md_m        REAL,
        depth_m         REAL,
        event_date      TEXT,
        severity        INTEGER CHECK (severity BETWEEN 1 AND 5),
        npt_hours       REAL,
        volume_loss_bbl REAL,
        root_cause      TEXT,
        action_taken    TEXT,
        action_outcome  TEXT,
        detected_by     TEXT NOT NULL DEFAULT 'manual' CHECK (detected_by IN ('manual','document_extraction','telemetry_rule','model')),
        detection_confidence REAL,
        source_label    TEXT,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','verified','rejected')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_events_well ON operational_events(well_id);
      CREATE INDEX idx_events_category ON operational_events(category);
      CREATE INDEX idx_events_depth ON operational_events(depth_m);
      CREATE INDEX idx_events_severity ON operational_events(severity DESC);
      CREATE INDEX idx_events_formation ON operational_events(formation_id);
      CREATE INDEX idx_events_window ON operational_events(start_md_m, end_md_m);

      CREATE TABLE event_provenance (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id          INTEGER NOT NULL REFERENCES operational_events(id) ON DELETE CASCADE,
        source_type       TEXT NOT NULL CHECK (source_type IN ('document','telemetry','manual','model')),
        document_id       INTEGER,
        page_no           INTEGER,
        bbox_json         TEXT,
        char_start        INTEGER,
        char_end          INTEGER,
        snippet           TEXT,
        ocr_confidence    REAL,
        extractor_version TEXT,
        method            TEXT,
        reviewed_by       INTEGER REFERENCES users(id),
        reviewed_at       TEXT,
        review_state      TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','corrected','rejected'))
      );
      CREATE INDEX idx_prov_event ON event_provenance(event_id);
      CREATE INDEX idx_prov_review ON event_provenance(review_state);

      -- The explicit lessons-learned object the PS asks for: what went wrong,
      -- why, what was done, and did it work.
      CREATE TABLE lessons_learned (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        title             TEXT NOT NULL,
        well_id           INTEGER REFERENCES wells(id),
        formation_id      INTEGER REFERENCES formations(id),
        event_id          INTEGER REFERENCES operational_events(id),
        category          TEXT,
        depth_md_m        REAL,
        challenge         TEXT NOT NULL,
        root_cause        TEXT,
        action_taken      TEXT,
        effectiveness     TEXT CHECK (effectiveness IN ('WORKED','PARTLY_WORKED','FAILED','NOT_APPLIED','UNKNOWN')),
        transferable      INTEGER NOT NULL DEFAULT 1 CHECK (transferable IN (0,1)),
        applicability_note TEXT,
        tags              TEXT,
        author            TEXT,
        source_document_id INTEGER,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_lessons_category ON lessons_learned(category);
      CREATE INDEX idx_lessons_well ON lessons_learned(well_id);
    `);
  },
};