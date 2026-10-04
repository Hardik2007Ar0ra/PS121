/**
 * 003 — Well programmes, normalised.
 *
 * The prototype stored `casing_program`, `cementing_practice` and
 * `mud_program` as free-text blobs on the wells row. That makes casing-point
 * comparison and mud-programme diffing impossible. These three tables replace
 * them with queryable structures.
 */
export default {
  name: '003_programs',
  up: (db) => {
    db.exec(`
      CREATE TABLE well_sections (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id            INTEGER NOT NULL REFERENCES wells(id),
        section_no         INTEGER NOT NULL,
        section_name       TEXT,
        hole_size_in       REAL NOT NULL,
        casing_size_in     REAL,
        casing_grade       TEXT,
        shoe_md_m          REAL NOT NULL,
        shoe_tvd_m         REAL NOT NULL,
        top_md_m           REAL,
        grouted_md_m       REAL,
        depth_reference    TEXT NOT NULL DEFAULT 'MD',
        design_ecd_ppg     REAL,
        design_maasp_psi   REAL,
        planned_date       TEXT,
        source_document_id INTEGER,
        UNIQUE (well_id, section_no)
      );
      CREATE INDEX idx_sections_shoe ON well_sections(shoe_md_m);

      CREATE TABLE cementing_jobs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id            INTEGER NOT NULL REFERENCES wells(id),
        section_id         INTEGER REFERENCES well_sections(id),
        job_date           TEXT,
        job_type           TEXT CHECK (job_type IN ('PRIMARY','SQUEEZE','REMEDIAL','ABANDONMENT')),
        cement_system      TEXT,
        lead_volume_bbl    REAL,
        tail_volume_bbl    REAL,
        spacers_volume_bbl REAL,
        flush_volume_bbl   REAL,
        u_tubing_bbl       REAL,
        displacement_efficiency_pct REAL,
        annular_capacity_bbl REAL,
        wait_on_cement_min REAL,
        squeeze_required   INTEGER NOT NULL DEFAULT 0 CHECK (squeeze_required IN (0,1)),
        remarks            TEXT,
        outcome            TEXT CHECK (outcome IN ('SUCCESS','SATISFACTORY','FAILED','UNKNOWN')),
        source_document_id INTEGER
      );
      CREATE INDEX idx_cement_well ON cementing_jobs(well_id);

      CREATE TABLE mud_programs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id            INTEGER NOT NULL REFERENCES wells(id),
        interval_from_md_m REAL NOT NULL,
        interval_to_md_m   REAL NOT NULL,
        depth_reference    TEXT NOT NULL DEFAULT 'MD',
        system             TEXT NOT NULL CHECK (system IN ('WBM','OBM','PBM','HIC')),
        fluid_type         TEXT,
        density_ppg        REAL NOT NULL,
        funnel_viscosity_s REAL,
        pv_cp              REAL,
        yp_lbf_100ft2      REAL,
        ph                 REAL,
        filtration_ml_30min REAL,
        lcm_type           TEXT,
        lcm_ration_ppb     REAL,
        additive           TEXT,
        inhibitiveness_note TEXT,
        source_document_id INTEGER,
        UNIQUE (well_id, interval_from_md_m, interval_to_md_m)
      );
      CREATE INDEX idx_mud_well ON mud_programs(well_id, interval_from_md_m);
    `);
  },
};