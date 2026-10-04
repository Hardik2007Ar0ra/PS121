/**
 * 001 — Core: fields, wells, users, sessions, audit log.
 *
 * Depth reference policy (applies to every depth column in the schema):
 *   - `*_md_m` is measured depth along the borehole from the drilling reference
 *     depth defined by `wells.spud_kb_m`.
 *   - `*_tvd_m` is true vertical depth below the well reference datum.
 *   - `tvd_ss_m` is true vertical depth subsea.
 *   - Every row that stores a depth also carries `depth_reference` so the
 *     origin of the number is never implicit. Values must never be compared
 *     across wells without an explicit correlation step (see server/correlation).
 */
export default {
  name: '001_core',
  up: (db) => {
    db.exec(`
      CREATE TABLE fields (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        basin       TEXT,
        district    TEXT,
        operator    TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE wells (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        well_name             TEXT NOT NULL UNIQUE,
        field_id              INTEGER NOT NULL REFERENCES fields(id),
        uwi                   TEXT,
        well_type             TEXT NOT NULL CHECK (well_type IN ('DEVELOPMENT','EXPLORATION','APPD','INJECTOR','STRATIGRAPHIC')),
        spud_date             TEXT,
        completion_date       TEXT,
        status                TEXT NOT NULL CHECK (status IN ('PLANNED','DRILLING','SUSPENDED','COMPLETED','ABANDONED')),
        lat                   REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng                   REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
        kb_elevation_m        REAL,
        sea_level_elevation_m REAL,
        -- Drilling reference depth (KB / RKB). All MD values are measured from here.
        spud_kb_m             REAL NOT NULL DEFAULT 0,
        td_md_m               REAL NOT NULL,
        td_tvd_m              REAL,
        spud_pressure_psi     REAL,
        pore_pressure_gradient REAL,
        fracture_gradient     REAL,
        water_depth_m         REAL,
        -- Exactly one well is the live drilling target at a time.
        is_active             INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_wells_single_active ON wells(is_active) WHERE is_active = 1;
      CREATE INDEX idx_wells_field ON wells(field_id);
      CREATE INDEX idx_wells_status ON wells(status);

      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('viewer','engineer','admin')),
        field_scope   TEXT,
        active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );

      -- Refresh-token sessions. Access tokens stay stateless; refresh tokens are
      -- revocable here so logout and admin revocation actually work.
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        token_hash  TEXT NOT NULL,
        user_agent  TEXT,
        ip          TEXT,
        expires_at  TEXT NOT NULL,
        revoked_at  TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id    INTEGER,
        actor_email TEXT,
        action      TEXT NOT NULL,
        entity      TEXT,
        entity_id   TEXT,
        outcome     TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','denied','error')),
        detail_json TEXT,
        ip          TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
    `);
  },
};