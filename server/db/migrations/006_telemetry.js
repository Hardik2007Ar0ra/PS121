/**
 * 006 — Surface telemetry, one row per well per timestamp.
 *
 * The prototype had 31 rows with no `well_id` and no relation to depth, so the
 * live chart and the ML features could not agree with each other. Telemetry is
 * now keyed by (well_id, ts) and carries the derived ECD channel that the
 * mud-loss model needs.
 */
export default {
  name: '006_telemetry',
  up: (db) => {
    db.exec(`
      CREATE TABLE telemetry_samples (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        well_id        INTEGER NOT NULL REFERENCES wells(id),
        ts             TEXT NOT NULL,
        depth_md_m     REAL NOT NULL,
        bit_depth_md_m REAL,
        torque_knm     REAL,
        drag_knm       REAL,
        rop_mhr        REAL,
        wob_ton        REAL,
        rpm            INTEGER,
        hook_load_ton  REAL,
        spp_psi        REAL,
        flow_out_lpm   REAL,
        pit_volume_m3  REAL,
        mud_weight_ppg REAL,
        ecd_ppg        REAL,
        flow_bit_ms    REAL,
        gas_ratio_ppm  REAL,
        source         TEXT NOT NULL DEFAULT 'simulator',
        UNIQUE (well_id, ts)
      );
      CREATE INDEX idx_telemetry_well_ts ON telemetry_samples(well_id, ts DESC);
      CREATE INDEX idx_telemetry_well_depth ON telemetry_samples(well_id, depth_md_m);
    `);
  },
};