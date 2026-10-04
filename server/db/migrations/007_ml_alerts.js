/**
 * 007 — Feature store, training rows, model registry, alerts and alert rules.
 *
 * `feature_store` is materialised by server/ml/features so that training and
 * online inference read byte-identical feature vectors. That is the only way to
 * avoid the classic bug where a model is trained on one feature definition and
 * served another.
 */
export default {
  name: '007_ml_alerts',
  up: (db) => {
    db.exec(`
      CREATE TABLE feature_store (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id          INTEGER NOT NULL REFERENCES wells(id),
        depth_md_m       REAL NOT NULL,
        formation_id     INTEGER REFERENCES formations(id),
        feature_version  TEXT NOT NULL,
        features_json    TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        UNIQUE (well_id, depth_md_m, feature_version)
      );
      CREATE INDEX idx_features_version ON feature_store(feature_version);
      CREATE INDEX idx_features_well ON feature_store(well_id, depth_md_m);

      CREATE TABLE risk_training_samples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id         INTEGER NOT NULL REFERENCES wells(id),
        depth_md_m      REAL NOT NULL,
        risk_type       TEXT NOT NULL,
        label           INTEGER NOT NULL CHECK (label IN (0,1)),
        features_json   TEXT NOT NULL,
        -- 'extracted' = from a real report event. 'derived' = synthesised from
        -- the corpus generator's known mechanisms. 'labeler' = human tagged.
        label_source    TEXT NOT NULL CHECK (label_source IN ('extracted','derived','labeler')),
        -- Grouped splits by well. A random row split leaks the well identity
        -- into the training set and inflates every metric.
        split_group     TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        UNIQUE (well_id, depth_md_m, risk_type, feature_version)
      );
      CREATE INDEX idx_training_risk ON risk_training_samples(risk_type);
      CREATE INDEX idx_training_group ON risk_training_samples(split_group);
      CREATE INDEX idx_training_version ON risk_training_samples(feature_version);

      CREATE TABLE models (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        version        TEXT NOT NULL,
        risk_type      TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('classifier','regressor','anomaly','ranking')),
        algorithm      TEXT NOT NULL,
        artifact_json  TEXT NOT NULL,
        metrics_json   TEXT NOT NULL,
        model_card_json TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        feature_list_json TEXT NOT NULL,
        training_rows  INTEGER NOT NULL,
        is_active      INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
        trained_at     TEXT NOT NULL,
        notes          TEXT,
        UNIQUE (name, version)
      );
      CREATE INDEX idx_models_active ON models(is_active, risk_type);

      CREATE TABLE alerts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id          INTEGER NOT NULL REFERENCES wells(id),
        risk_type        TEXT NOT NULL,
        severity         TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        level            TEXT,
        score            REAL NOT NULL,
        threshold        REAL NOT NULL,
        model_name       TEXT,
        model_version    TEXT,
        feature_version  TEXT,
        trigger_depth_md_m REAL NOT NULL,
        window_from_md_m REAL NOT NULL,
        window_to_md_m   REAL NOT NULL,
        metres_ahead     REAL,
        hours_ahead      REAL,
        message          TEXT NOT NULL,
        features_json    TEXT,
        evidence_json    TEXT,
        recommendations_json TEXT,
        dedupe_key       TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
        acknowledged_by  INTEGER REFERENCES users(id),
        acknowledged_at  TEXT,
        ack_note         TEXT,
        resolved_at      TEXT,
        resolution_note  TEXT,
        outcome_event_id INTEGER REFERENCES operational_events(id),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_alerts_dedupe_open ON alerts(dedupe_key) WHERE status IN ('OPEN','ACKNOWLEDGED');
      CREATE INDEX idx_alerts_well ON alerts(well_id, status);
      CREATE INDEX idx_alerts_created ON alerts(created_at DESC);

      CREATE TABLE alert_rules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        field_id      INTEGER REFERENCES fields(id),
        formation_id  INTEGER REFERENCES formations(id),
        risk_type     TEXT NOT NULL,
        look_ahead_m  REAL NOT NULL DEFAULT 250,
        trigger_score REAL NOT NULL DEFAULT 0.5,
        severity      TEXT NOT NULL DEFAULT 'MEDIUM',
        min_evidence  INTEGER NOT NULL DEFAULT 1,
        cooldown_min  INTEGER NOT NULL DEFAULT 180,
        enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        updated_by    INTEGER REFERENCES users(id),
        updated_at    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_rules_risk ON alert_rules(risk_type, enabled);
    `);
  },
};