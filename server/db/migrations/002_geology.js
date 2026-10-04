/**
 * 002 — Geology: formations, per-well formation tops, reservoirs, trajectory
 * surveys and derived downhole signals.
 *
 * `formation_tops` is the table that makes real depth-based correlation
 * possible. Without per-well stratigraphy, "same formation" can only ever be a
 * string comparison, which is exactly what the prototype was doing.
 */
export default {
  name: '002_geology',
  up: (db) => {
    db.exec(`
      CREATE TABLE formations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        field_id     INTEGER REFERENCES fields(id),
        age          TEXT,
        lithology    TEXT,
        description  TEXT,
        -- Which members/stages this unit is commonly correlated with. Used by
        -- the correlation engine to match "Formation X (upper member)" to
        -- "Formation X" when the tops actually agree.
        correlates_with TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_formations_field ON formations(field_id);

      CREATE TABLE formation_tops (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id            INTEGER NOT NULL REFERENCES wells(id),
        formation_id       INTEGER NOT NULL REFERENCES formations(id),
        top_md_m           REAL NOT NULL,
        top_tvd_m          REAL NOT NULL,
        tvd_ss_m           REAL NOT NULL,
        base_md_m          REAL,
        base_tvd_m         REAL,
        thickness_m        REAL,
        depth_reference    TEXT NOT NULL DEFAULT 'MD',
        confidence         REAL NOT NULL DEFAULT 0.5,
        method             TEXT NOT NULL CHECK (method IN ('MARKER','GR','LWD','CORRELATION','MANUAL','DERIVED')),
        source_document_id INTEGER,
        UNIQUE (well_id, formation_id)
      );
      CREATE INDEX idx_tops_formation ON formation_tops(formation_id);
      CREATE INDEX idx_tops_depth ON formation_tops(top_md_m);

      CREATE TABLE reservoirs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL UNIQUE,
        fluid_type      TEXT CHECK (fluid_type IN ('OIL','GAS','WATER','MULTI')),
        pressure_psi    REAL,
        pressure_gradient REAL,
        temperature_c   REAL,
        permeability_md REAL,
        porosity_pct    REAL,
        producer        TEXT,
        notes           TEXT
      );

      CREATE TABLE formation_reservoirs (
        formation_id INTEGER NOT NULL REFERENCES formations(id),
        reservoir_id INTEGER NOT NULL REFERENCES reservoirs(id),
        role         TEXT NOT NULL DEFAULT 'TARGET' CHECK (role IN ('TARGET','PARENT','SEAL','SOURCE')),
        PRIMARY KEY (formation_id, reservoir_id)
      );

      -- Directional survey stations. Vertical wells get a single derived row so
      -- the section view has a geometry for every well.
      CREATE TABLE trajectory_surveys (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id        INTEGER NOT NULL REFERENCES wells(id),
        md_m           REAL NOT NULL,
        inclination_deg REAL NOT NULL,
        azimuth_deg    REAL NOT NULL,
        tvd_m          REAL NOT NULL,
        north_m        REAL NOT NULL,
        east_m         REAL NOT NULL,
        atge_deg       REAL,
        dogleg_deg_per_30m REAL,
        UNIQUE (well_id, md_m)
      );
      CREATE INDEX idx_survey_well ON trajectory_surveys(well_id, md_m);

      -- Derived downhole signals computed per depth increment. d-exponent is
      -- the standard overpressure indicator and is required by the Kick /
      -- Overpressure model (M3).
      CREATE TABLE trajectory_features (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id           INTEGER NOT NULL REFERENCES wells(id),
        depth_md_m        REAL NOT NULL,
        formation_id      INTEGER,
        d_exponent        REAL,
        lithology_index   REAL,
        normalised_d_exponent REAL,
        overbalance_flag  INTEGER NOT NULL DEFAULT 0,
        underbalance_flag INTEGER NOT NULL DEFAULT 0,
        UNIQUE (well_id, depth_md_m)
      );
      CREATE INDEX idx_trajfeat_well ON trajectory_features(well_id, depth_md_m);
    `);
  },
};