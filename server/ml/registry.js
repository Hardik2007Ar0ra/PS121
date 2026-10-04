/**
 * Model registry.
 *
 * Every trained model is stored as one row: the fitted artifact, its held-out
 * metrics, a model card, and the feature list it was trained against. The
 * artifact is plain JSON precisely so it can be diffed in git — a model whose
 * parameters changed cannot be reviewed, and a model whose parameters cannot be
 * reviewed cannot be defended to an operations panel.
 *
 * Activation is explicit and single-valued per risk: `models.is_active` is unique
 * across active rows for a given risk, so a new version replaces the old one
 * rather than silently competing with it. Previous versions are kept, because
 * "what was the model doing last quarter" is a question that gets asked.
 */

import { FEATURE_NAMES, FEATURE_VERSION } from './features/extract.js';
import logger from '../util/logger.js';

const log = logger.child({ module: 'ml/registry' });

/** Derives a semantic version from the training data, so retraining on new data bumps it. */
export function nextVersion(db, name, { trainedAt }) {
  const row = db
    .prepare('SELECT version FROM models WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name);
  if (!row) return '1.0.0';
  const [major, minor, patch] = row.version.split('.').map(Number);
  const stamp = new Date(trainedAt);
  // Same day: patch bump. New day: minor. New calendar month: major. This makes
  // the version say something a human can reason about without opening the card.
  const previous = db
    .prepare('SELECT trained_at FROM models WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name);
  const previousDate = new Date(previous.trained_at);
  if (stamp.getFullYear() !== previousDate.getFullYear() || stamp.getMonth() !== previousDate.getMonth()) {
    return `${major + 1}.0.0`;
  }
  if (stamp.getDate() !== previousDate.getDate()) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function saveModel(db, { name, riskType, kind, algorithm, artifact, metrics, modelCard, trainingRows, trainedAt, activate = true, notes = null }) {
  const version = nextVersion(db, name, { trainedAt });
  const featureList = modelCard.featureList ?? FEATURE_NAMES;
  const featureVersion = modelCard.featureVersion ?? FEATURE_VERSION;

  const persist = db.transaction(() => {
    if (activate) {
      // Deactivate first so the partial unique index below cannot be violated by
      // the ordering of these two statements.
      db.prepare('UPDATE models SET is_active = 0 WHERE risk_type = ? AND name = ?').run(riskType, name);
    }
    const info = db
      .prepare(
        `INSERT INTO models (
           name, version, risk_type, kind, algorithm, artifact_json, metrics_json,
           model_card_json, feature_version, feature_list_json, training_rows,
           is_active, trained_at, notes
         ) VALUES (
           @name, @version, @risk_type, @kind, @algorithm, @artifact_json, @metrics_json,
           @model_card_json, @feature_version, @feature_list_json, @training_rows,
           @is_active, @trained_at, @notes
         )`,
      )
      .run({
        name,
        version,
        risk_type: riskType,
        kind,
        algorithm,
        artifact_json: JSON.stringify(artifact),
        metrics_json: JSON.stringify(metrics),
        model_card_json: JSON.stringify(modelCard),
        feature_version: featureVersion,
        feature_list_json: JSON.stringify(featureList),
        training_rows: trainingRows,
        is_active: activate ? 1 : 0,
        trained_at: trainedAt,
        notes,
      });
    return info.lastInsertRowid;
  });

  const id = persist();
  log.info({ name, version, riskType, algorithm, trainingRows }, 'model saved');
  return { id, name, version, riskType, algorithm };
}

/**
 * Loads a model row and its fitted artifact.
 *
 * `parseArtifact` rehydrates the typed arrays that JSON turns into plain objects
 * of the wrong shape. Doing this here rather than at every call site keeps the
 * algorithms free of any serialisation concern — they never see JSON.
 */
export function loadModel(db, { name, version = null, riskType = null }) {
  const row = version
    ? db.prepare('SELECT * FROM models WHERE name = ? AND version = ?').get(name, version)
    : db
        .prepare(
          `SELECT * FROM models
           WHERE name = ? AND is_active = 1 ${riskType ? 'AND risk_type = ?' : ''}`,
        )
        .get(...(riskType ? [name, riskType] : [name]));

  if (!row) return null;
  const artifact = JSON.parse(row.artifact_json);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    riskType: row.risk_type,
    kind: row.kind,
    algorithm: row.algorithm,
    featureVersion: row.feature_version,
    featureList: JSON.parse(row.feature_list_json),
    metrics: JSON.parse(row.metrics_json),
    modelCard: JSON.parse(row.model_card_json),
    trainingRows: row.training_rows,
    trainedAt: row.trained_at,
    artifact: parseArtifact(artifact),
  };
}

/** All active models, keyed by risk type — the normal state of the serving path. */
export function loadActiveModels(db) {
  const rows = db
    .prepare('SELECT name FROM models WHERE is_active = 1')
    .all()
    .map((row) => row.name);
  const unique = [...new Set(rows)];
  const out = new Map();
  unique.forEach((name) => {
    const model = loadModel(db, { name });
    if (model) out.set(model.riskType, model);
  });
  return out;
}

/**
 * Restores the numeric types the trees and forests need.
 *
 * `threshold` and `value` stay ordinary numbers, but the tree node trees become
 * plain objects, which is what they already are. The real work is the forest's
 * nested `left`/`right`, which needs nothing either. The only genuinely lossy
 * round-trip is `Float64Array` inside the logistic model's weights, and those are
 * read through array indexing so plain arrays work unchanged.
 *
 * Kept as an explicit function rather than an inline map so that when a future
 * artifact gains a typed field, the place to fix it is one obvious place.
 */
function parseArtifact(artifact) {
  if (artifact.kind === 'isolation_forest') {
    return {
      ...artifact,
      forest: artifact.forest.map(reviveTree),
    };
  }
  if (artifact.kind === 'gbdt_classifier' || artifact.kind === 'gbdt_regressor') {
    return {
      ...artifact,
      trees: artifact.trees.map((entry) => ({ ...entry, root: reviveTree(entry.root) })),
    };
  }
  return artifact;
}

function reviveTree(node) {
  if (!node) return node;
  const revived = { ...node };
  if (node.left) revived.left = reviveTree(node.left);
  if (node.right) revived.right = reviveTree(node.right);
  return revived;
}

/** Full history for a model name, newest first. */
export function modelHistory(db, name) {
  return db
    .prepare(
      `SELECT id, name, version, risk_type, kind, algorithm, feature_version,
              training_rows, is_active, trained_at, notes, metrics_json
       FROM models WHERE name = ? ORDER BY id DESC`,
    )
    .all(name)
    .map((row) => ({ ...row, metrics: JSON.parse(row.metrics_json) }));
}

export function setActive(db, name, version, { activate = true } = {}) {
  const row = db.prepare('SELECT risk_type FROM models WHERE name = ? AND version = ?').get(name, version);
  if (!row) throw new Error(`setActive: ${name}@${version} not found`);
  db.transaction(() => {
    if (activate) {
      db.prepare('UPDATE models SET is_active = 0 WHERE risk_type = ? AND name = ?').run(row.risk_type, name);
    }
    db.prepare('UPDATE models SET is_active = ? WHERE name = ? AND version = ?').run(activate ? 1 : 0, name, version);
  })();
  return { name, version, isActive: activate };
}