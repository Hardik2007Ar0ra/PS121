export default {
  name: '009_training_targets',
  up(db) {
    db.exec(`
      -- Regression targets for the row models.
      --
      -- The classifier tables do not need this, but the NPT model predicts hours,
      -- not a class, and there was nowhere to put the hours. Storing the target
      -- alongside the label is what makes the training set self-contained: a row
      -- can be read without joining back to operational_events, and the snapshot
      -- stays valid if an event is later corrected.
      ALTER TABLE risk_training_samples ADD COLUMN target_value REAL;

      -- Events also need their effective NPT to be queryable as a total, which is
      -- what the operational summary reports. Kept as a stored value rather than
      -- recomputed on every read because it is used in a GROUP BY over the
      -- field-level dashboards.
      ALTER TABLE operational_events ADD COLUMN npt_hours_total REAL;
      UPDATE operational_events SET npt_hours_total = COALESCE(npt_hours, 0);

      CREATE INDEX idx_events_category_depth ON operational_events(category, depth_m);

      -- Look-ahead alerts are keyed by well and depth and filtered on whether they
      -- are still open, which was a sequential scan of every open alert.
      CREATE INDEX idx_alerts_well_type_open ON alerts(well_id, risk_type, status);
    `);
  },
};