/**
 * Model serving.
 *
 * Loads the active models once, caches the feature standardisation they were
 * fitted on, and scores depth intervals. The critical invariant: a model is only
 * ever asked about feature vectors built by the same `FEATURE_VERSION` it was
 * trained on. A version mismatch is refused rather than coerced, because silently
 * scoring a v2 vector with a v1 model produces confident nonsense.
 */

import { FEATURE_VERSION, vectorToObject } from './features/extract.js';
import { calibrate, predictLogistic } from './algorithms/logistic.js';
import { predictGbdtRaw, predictGbdtRegressor } from './algorithms/gbdt.js';
import { scoreWithContext } from './algorithms/isolationForest.js';
import { loadActiveModels } from './registry.js';
import logger from '../util/logger.js';

const log = logger.child({ module: 'ml/serve' });

/** A loaded, ready-to-score model with its threshold and metadata flattened. */
class LoadedModel {
  constructor(record) {
    this.name = record.name;
    this.version = record.version;
    this.riskType = record.riskType;
    this.kind = record.kind;
    this.algorithm = record.algorithm;
    this.artifact = record.artifact;
    this.metrics = record.metrics;
    this.modelCard = record.modelCard;
    this.featureVersion = record.featureVersion;
    this.trainedAt = record.trainedAt;
    this.trainingRows = record.trainingRows;
    // The operating threshold was chosen on out-of-fold predictions at training
    // time and stored with the artifact. Recomputing it from the in-sample score
    // distribution here would silently move every alert boundary.
    this.threshold = record.artifact.operatingThreshold ?? null;
  }

  /** Raw (uncalibrated) scores for a batch of feature vectors. */
  scoreRaw(rows) {
    if (this.artifact.kind === 'logistic') return predictLogistic(this.artifact, rows);
    if (this.artifact.kind === 'gbdt_classifier') return predictGbdtRaw(this.artifact, rows);
    if (this.artifact.kind === 'gbdt_regressor') return predictGbdtRegressor(this.artifact, rows);
    if (this.artifact.kind === 'isolation_forest') {
      return scoreWithContext(this.artifact, rows, { window: this.artifact.smoothingWindow ?? 5 }).smoothed;
    }
    throw new Error(`${this.name}: unsupported algorithm ${this.artifact.kind}`);
  }

  /**
   * Calibrated probabilities for a classifier.
   *
   * The calibrator was fitted on the training corpus. On a well that corpus
   * contains, its probabilities are optimistic. That is stated in the model card
   * and repeated in the response, because a probability that quietly means
   * something else is the fastest way to lose an operator's trust.
   */
  scoreCalibrated(rows) {
    const raw = this.scoreRaw(rows);
    if (this.artifact.kind !== 'gbdt_classifier' && this.artifact.kind !== 'logistic') return raw;
    if (!this.artifact.calibrator) return raw;
    return calibrate(this.artifact.calibrator, raw);
  }

  /** True when the model predicts a class at all. */
  get isClassifier() {
    return this.kind === 'classifier';
  }
}

/**
 * The serving set: every active model, indexed by risk type.
 *
 * Missing models are not an error. A freshly seeded database has no models until
 * `npm run ml:train` has run, and the API must serve the rest of the system rather
 * than refuse to start. `missing` records what was asked for and not found, so the
 * status endpoint can say "no mud-loss model is trained" instead of silently
 * returning zero risks.
 */
export class ModelSet {
  constructor(models, { featureVersion = FEATURE_VERSION } = {}) {
    this.byRisk = models;
    this.featureVersion = featureVersion;
    this.loadedAt = new Date().toISOString();
  }

  static fromDb(db) {
    const records = loadActiveModels(db);
    const models = new Map();
    records.forEach((record) => models.set(record.riskType, new LoadedModel(record)));
    if (models.size) {
      log.info({ models: [...models.keys()].join(',') }, 'active models loaded');
    }
    return new ModelSet(models);
  }

  get(riskType) {
    return this.byRisk.get(riskType) ?? null;
  }

  get size() {
    return this.byRisk.size;
  }

  describe() {
    return [...this.byRisk.values()].map((model) => ({
      name: model.name,
      version: model.version,
      riskType: model.riskType,
      kind: model.kind,
      algorithm: model.algorithm,
      threshold: model.threshold,
      featureVersion: model.featureVersion,
      trainedAt: model.trainedAt,
      trainingRows: model.trainingRows,
      headline:
        model.metrics?.rocAuc !== null && model.metrics?.rocAuc !== undefined
          ? `held-out ROC AUC ${model.metrics.rocAuc} on ${model.metrics.wells} unseen wells`
          : model.kind === 'regressor'
            ? `held-out RMSE ${model.metrics?.rmse}h vs ${model.metrics?.baselineRmse}h baseline`
            : model.modelCard?.verdict ?? null,
    }));
  }

  /**
   * Scores a set of intervals against one risk type.
   *
   * `featureVersion` is checked against the model's own. A caller passing a
   * different version gets an error naming both, not a number.
   */
  score(riskType, intervals, { featureVersion = FEATURE_VERSION, includeExplanation = true, explainer = null } = {}) {
    const model = this.get(riskType);
    if (!model) {
      return {
        riskType,
        available: false,
        reason: `no active model for ${riskType}. Run: npm run ml:train`,
        intervals: [],
      };
    }
    if (model.featureVersion !== featureVersion) {
      return {
        riskType,
        available: false,
        reason:
          `model ${model.name}@${model.version} was trained on feature set ${model.featureVersion}, ` +
          `but these intervals carry ${featureVersion}. Refusing to score across versions.`,
        intervals: [],
      };
    }
    if (!intervals.length) {
      return { riskType, available: true, model: this.describeOne(model), intervals: [] };
    }

    const vectors = intervals.map((interval) => interval.vector);
    const raw = model.scoreRaw(vectors);
    const calibrated = model.isClassifier ? model.scoreCalibrated(vectors) : raw;
    const threshold = model.threshold ?? 0.5;

    const scored = intervals.map((interval, index) => {
      const item = {
        depthMd: interval.depthMd,
        wellName: interval.wellName ?? null,
        formation: interval.formation ?? null,
        rawScore: round(raw[index], 4),
        score: round(calibrated[index], 4),
        threshold,
        flagged: model.isClassifier ? calibrated[index] >= threshold : null,
        featureObject: includeExplanation ? vectorToObject(vectors[index]) : undefined,
      };
      if (includeExplanation && explainer) {
        item.explanation = explainer(model, vectors[index], {
          featureObject: item.featureObject,
        });
      }
      return item;
    });

    return {
      riskType,
      available: true,
      model: this.describeOne(model),
      intervals: scored,
      summary: {
        scored: scored.length,
        flagged: scored.filter((s) => s.flagged).length,
        maxScore: round(Math.max(...scored.map((s) => s.score)), 4),
        meanScore: round(scored.reduce((a, b) => a + b.score, 0) / scored.length, 4),
      },
    };
  }

  describeOne(model) {
    return {
      name: model.name,
      version: model.version,
      algorithm: model.algorithm,
      kind: model.kind,
      threshold: model.threshold,
      featureVersion: model.featureVersion,
      trainedAt: model.trainedAt,
    };
  }
}

/**
 * Invalidation check.
 *
 * A model whose training corpus no longer matches the current feature version is
 * unusable. `staleReason` is surfaced by the status endpoint so an operator is
 * told the number they are looking at came from an incompatible training run.
 */
export function modelFreshness(db, modelSet) {
  const version = db
    .prepare('SELECT DISTINCT feature_version FROM risk_training_samples ORDER BY rowid DESC LIMIT 1')
    .get();
  return {
    currentFeatureVersion: version?.feature_version ?? null,
    loadedVersion: modelSet.featureVersion,
    stale: !!version && version.feature_version !== modelSet.featureVersion,
    staleReason: version && version.feature_version !== modelSet.featureVersion
      ? `training rows are at ${version.feature_version} but the extractor emits ${modelSet.featureVersion}`
      : null,
  };
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}