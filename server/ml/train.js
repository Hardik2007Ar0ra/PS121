/**
 * Training orchestrator.
 *
 * For each risk type: fit both candidate algorithms under grouped cross-validation,
 * compare them on held-out wells, promote the winner, refit on everything, and
 * write an artifact plus a model card.
 *
 * The candidate comparison is the point. Boosted trees are the fashionable answer
 * for tabular risk prediction, but the features here are engineered local ratios
 * and physics-derived margins, and those are close to linear. Where a logistic
 * regression beats boosting on held-out wells, that is the answer, and the
 * booster is reported as the runner-up rather than quietly dropped.
 */

import { FEATURE_NAMES, FEATURE_VERSION } from './features/extract.js';
import { fitGbdtClassifier, fitGbdtRegressor, predictGbdtRaw, predictGbdtRegressor } from './algorithms/gbdt.js';
import { calibrate, fitLogistic, fitPlatt, predictLogistic } from './algorithms/logistic.js';
import { fitIsolationForest, scoreWithContext } from './algorithms/isolationForest.js';
import { evaluateAnomaly, evaluateClassifier, evaluateRegressor, finalFit } from './evaluate.js';
import { rocAuc } from './algorithms/metrics.js';
import { RISK_TYPES } from './features/dataset.js';
import { saveModel } from './registry.js';
import { exportArtifact } from './artifacts.js';
import { makeRandom } from '../seeds/generator/random.js';
import { treeRules } from './algorithms/tree.js';
import logger from '../util/logger.js';

const log = logger.child({ module: 'ml/train' });

const DEFAULTS = {
  folds: 4,
  rounds: 60,
  seed: 20260101,
  // Positive-class cost weight. Mud loss and kicking are expensive; a torque
  // spike is not. This is set per risk below rather than globally so the trade-off
  // reflects the consequence of being wrong, not the size of the class.
  positiveWeight: 1,
  minPrecision: 0.3,
  // Where versioned artifact bundles are written. Null disables the export, which
  // is only useful for tests.
  artifactsDir: null,
};

/**
 * Loads a risk type's training set.
 *
 * Only rows whose `feature_version` matches the current one are returned. A model
 * served against a feature vector from a different version is not the model that
 * was evaluated, and mixing versions is worse than having no model at all.
 */
export function loadTrainingSet(db, riskType, { featureVersion = FEATURE_VERSION, limit = null } = {}) {
  // The training table stores `well_id` and keeps the well name in `split_group`,
  // but the name is joined rather than read back from the group label: the label
  // is the split key and could in principle be something other than a well name,
  // and a report that silently conflated the two would be wrong the first time
  // that happened.
  const rows = db
    .prepare(
      `SELECT t.features_json, t.label, t.target_value, t.split_group, t.depth_md_m,
              w.well_name
       FROM risk_training_samples t
       JOIN wells w ON w.id = t.well_id
       WHERE t.risk_type = ? AND t.feature_version = ?
       ORDER BY t.split_group, t.depth_md_m`,
    )
    .all(riskType, featureVersion);

  const capped = limit ? rows.slice(0, limit) : rows;
  return {
    X: capped.map((row) => JSON.parse(row.features_json)),
    y: capped.map((row) => row.label),
    targets: capped.map((row) => row.target_value ?? 0),
    groups: capped.map((row) => row.split_group),
    depths: capped.map((row) => row.depth_md_m),
    wells: capped.map((row) => row.well_name),
    rows: capped,
  };
}

/** Trains every risk type and returns the saved model records. */
export function trainAll(db, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const trainedAt = options.trainedAt ?? new Date().toISOString();
  const results = [];

  for (const risk of RISK_TYPES) {
    const started = Date.now();
    const data = loadTrainingSet(db, risk.id, { limit: options.limit });

    if (!data.rows.length) {
      log.warn({ riskType: risk.id }, 'no training rows — skipped');
      results.push({ riskType: risk.id, skipped: 'no training rows' });
      continue;
    }

    const positives = data.y.reduce((a, b) => a + b, 0);
    if (risk.kind === 'classifier' && positives < 10) {
      // A ten-positive model is not a model. Reporting it as "trained, AUC 0.7"
      // would be the single most misleading thing this script could do, so the
      // gap is stated instead of papered over.
      log.warn({ riskType: risk.id, positives }, 'too few positives to train honestly');
      results.push({
        riskType: risk.id,
        skipped: `only ${positives} positive examples across ${new Set(data.groups).size} wells`,
        positives,
        wells: new Set(data.groups).size,
      });
      continue;
    }

    const outcome =
      risk.kind === 'classifier'
        ? trainClassifier({ db, risk, data, config, trainedAt })
        : risk.kind === 'regressor'
          ? trainRegressor({ db, risk, data, config, trainedAt })
          : trainAnomalyModel({ db, risk, data, config, trainedAt });

    results.push({ ...outcome, elapsedMs: Date.now() - started });
  }

  return { results, trainedAt, config };
}

// --- Classifiers ------------------------------------------------------------

function trainClassifier({ db, risk, data, config, trainedAt }) {
  const { X, y, groups } = data;
  const rng = makeRandom(config.seed);
  const label = risk.label;

  // Both candidates are cross-validated on exactly the same folds, driven by the
  // same seeded generator, so the comparison is paired rather than two
  // independent runs whose difference includes split luck.
  const fitLogisticCandidate = (trainX, trainY, foldRng) => {
    const model = fitLogistic(trainX, trainY, {
      l2: 1e-3,
      learningRate: 0.08,
      iterations: 400,
      positiveWeight: risk.positiveWeight ?? config.positiveWeight,
      rng: foldRng,
    });
    model.calibrate = (testScores, trainScores, trainY) =>
      calibrate(fitPlatt(trainScores, trainY, { rng: foldRng }), testScores);
    return model;
  };

  const fitBoostedCandidate = (trainX, trainY, foldRng) => {
    const model = fitGbdtClassifier(trainX, trainY, {
      rounds: config.rounds,
      learningRate: 0.08,
      maxDepth: 3,
      minLeaf: 60,
      rng: foldRng,
    });
    model.calibrate = (testScores, trainScores, trainY) =>
      calibrate(fitPlatt(trainScores, trainY, { rng: foldRng }), testScores);
    return model;
  };

  const candidates = [
    { algorithm: 'logistic_regression', fit: fitLogisticCandidate, predict: (m, rows) => predictLogistic(m, rows) },
    { algorithm: 'gradient_boosted_trees', fit: fitBoostedCandidate, predict: (m, rows) => predictGbdtRaw(m, rows) },
  ];

  const evaluated = candidates.map((candidate) => {
    const candidateRng = makeRandom(config.seed);
    const { metrics } = evaluateClassifier({
      X,
      y,
      groups,
      fit: candidate.fit,
      predict: candidate.predict,
      rng: candidateRng.unit,
      folds: config.folds,
      minPrecision: config.minPrecision,
      label,
    });
    return { ...candidate, metrics };
  });

  // Selection on held-out ROC AUC, with average precision as the tie-break. AUC
  // is primary because the operating threshold is chosen afterwards and therefore
  // has to be independent of which model wins.
  const ranked = [...evaluated].sort(
    (a, b) => (b.metrics.rocAuc ?? 0) - (a.metrics.rocAuc ?? 0) || (b.metrics.averagePrecision ?? 0) - (a.metrics.averagePrecision ?? 0),
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];

  const finalRng = makeRandom(config.seed);
  const { model, scores: inSampleScores } = finalFit({
    X,
    y,
    fit: winner.fit,
    predict: winner.predict,
    rng: finalRng.unit,
    labels: y,
  });

  // The calibrator shipped with the model is fitted on the whole corpus, because
  // its job is to make the scores interpretable at inference time — not to make
  // the reported number look better.
  const calibrator = fitPlatt(inSampleScores, y, { rng: finalRng.unit });
  const calibrated = calibrate(calibrator, inSampleScores);
  const threshold = winner.metrics.operatingPoint;

  const card = classifierCard({
    risk,
    winner,
    runnerUp,
    evaluated,
    data,
    metrics: winner.metrics,
    model,
    calibrator,
    threshold,
    config,
    trainedAt,
  });

  // A model that cannot beat "flag every interval" is registered for the record
  // but not activated. Promoting it would push a known-useless score into the
  // alert engine, where its cost shows up as an operator's attention rather than
  // as a metric anyone is watching.
  const gate = winner.metrics.deploymentGate;
  const activate = gate.usable;
  if (!activate) {
    card.headline = `Trained but NOT activated: ${gate.reasons.join('; ')}.`;
    card.deploymentGate = gate;
  }

  const saved = saveModel(db, {
    name: `nwis_${risk.id.toLowerCase()}_risk`,
    riskType: risk.id,
    kind: 'classifier',
    algorithm: winner.algorithm,
    artifact: {
      ...model,
      calibrator,
      operatingThreshold: threshold.threshold,
      featureVersion: FEATURE_VERSION,
    },
    metrics: winner.metrics,
    modelCard: card,
    trainingRows: X.length,
    trainedAt,
    activate,
    notes: card.headline,
  });

  if (activate && config.artifactsDir) {
    exportArtifact(config.artifactsDir, {
      name: saved.name,
      version: saved.version,
      riskType: risk.id,
      kind: 'classifier',
      algorithm: winner.algorithm,
      featureVersion: FEATURE_VERSION,
      featureList: FEATURE_NAMES,
      artifact: {
        ...model,
        calibrator,
        operatingThreshold: threshold.threshold,
        featureVersion: FEATURE_VERSION,
      },
      metrics: winner.metrics,
      modelCard: card,
      trainingRows: X.length,
      trainedAt,
      notes: card.headline,
    });
  }

  return {
    riskType: risk.id,
    algorithm: winner.algorithm,
    model: saved,
    activated: activate,
    activationBlockedBy: activate ? null : gate.reasons,
    trainingRows: X.length,
    positives: data.y.reduce((a, b) => a + b, 0),
    positiveRate: round((data.y.reduce((a, b) => a + b, 0) / X.length) * 100, 2),
    wells: new Set(groups).size,
    rocAuc: winner.metrics.rocAuc,
    aucInterval: winner.metrics.rocAucConfidence,
    averagePrecision: winner.metrics.averagePrecision,
    threshold: threshold.threshold,
    precision: threshold.precision,
    recall: threshold.recall,
    beatBaseline: winner.metrics.deltasVsBaseline.precision > 0,
    runnerUp: runnerUp
      ? { algorithm: runnerUp.algorithm, rocAuc: runnerUp.metrics.rocAuc }
      : null,
  };
}

// --- Regressor --------------------------------------------------------------

function trainRegressor({ db, risk, data, config, trainedAt }) {
  const { X, targets, groups } = data;
  const rng = makeRandom(config.seed);

  const { metrics } = evaluateRegressor({
    X,
    y: targets,
    groups,
    fit: (trainX, trainY, foldRng) =>
      fitGbdtRegressor(trainX, trainY, { rounds: config.rounds, rng: foldRng.unit }),
    predict: (model, rows) => predictGbdtRegressor(model, rows),
    rng: rng.unit,
    folds: config.folds,
    label: risk.label,
  });

  const fitRng = makeRandom(config.seed);
  const model = fitGbdtRegressor(X, targets, { rounds: config.rounds, rng: fitRng.unit });

  const card = {
    ...baseCard(risk, metrics, data, config, trainedAt),
    kind: 'regressor',
    algorithm: 'gradient_boosted_trees',
    unit: 'hours',
    target: 'NPT hours booked in the depth interval',
    // The honest read on this model. A regressor that does not beat the mean
    // predictor should say so in the headline, not in a footnote.
    verdict: metrics.beatsBaseline
      ? `Beats the mean-predictor baseline (RMSE ${metrics.rmse}h vs ${metrics.baselineRmse}h).`
      : `Does not beat the mean-predictor baseline (RMSE ${metrics.rmse}h vs ${metrics.baselineRmse}h). Usable as a relative indicator, not as an hours estimate.`,
    limitations: [
      'NPT is zero-inflated and heavy-tailed: most intervals cost nothing and a few cost days, so squared-error error metrics are dominated by a small number of intervals.',
      'The target is hours the crew actually booked, which depends on decisions made under circumstances the telemetry does not record. Part of the variance is therefore not predictable from these features at all.',
      ...baseCard(risk, metrics, data, config, trainedAt).limitations,
    ],
    percentiles: metrics.percentiles,
  };

  const saved = saveModel(db, {
    name: `nwis_${risk.id.toLowerCase()}_estimate`,
    riskType: risk.id,
    kind: 'regressor',
    algorithm: 'gradient_boosted_trees',
    artifact: { ...model, featureVersion: FEATURE_VERSION },
    metrics,
    modelCard: card,
    trainingRows: X.length,
    trainedAt,
    notes: card.verdict,
  });

  if (config.artifactsDir) {
    exportArtifact(config.artifactsDir, {
      name: saved.name,
      version: saved.version,
      riskType: risk.id,
      kind: 'regressor',
      algorithm: 'gradient_boosted_trees',
      featureVersion: FEATURE_VERSION,
      featureList: FEATURE_NAMES,
      artifact: { ...model, featureVersion: FEATURE_VERSION },
      metrics,
      modelCard: card,
      trainingRows: X.length,
      trainedAt,
      notes: card.verdict,
    });
  }

  return {
    riskType: risk.id,
    algorithm: 'gradient_boosted_trees',
    model: saved,
    trainingRows: X.length,
    positives: data.y.reduce((a, b) => a + b, 0),
    positiveRate: round((data.y.reduce((a, b) => a + b, 0) / X.length) * 100, 2),
    wells: new Set(groups).size,
    rmse: metrics.rmse,
    baselineRmse: metrics.baselineRmse,
    beatsBaseline: metrics.beatsBaseline,
    r2: metrics.r2,
  };
}

// --- Unsupervised anomaly model ---------------------------------------------

function trainAnomalyModel({ db, risk, data, config, trainedAt }) {
  const { X, groups, wells, depths } = data;
  const rng = makeRandom(config.seed);

  // Event depths per well, used only to report enrichment after training. They
  // are not part of the fit: the model sees feature vectors and nothing else.
  const eventsByWell = new Map();
  const eventRows = db
    .prepare(
      `SELECT s.split_group AS well, s.depth_md_m AS depth
       FROM risk_training_samples s
       WHERE s.risk_type = 'FORMATION_RISK' AND s.label = 1 AND s.feature_version = ?`,
    )
    .all(FEATURE_VERSION);
  eventRows.forEach((row) => {
    if (!eventsByWell.has(row.well)) eventsByWell.set(row.well, []);
    eventsByWell.get(row.well).push(row.depth);
  });

  const { metrics } = evaluateAnomaly({
    X,
    groups,
    fit: (trainX, foldRng) => fitIsolationForest(trainX, { trees: 60, sampleSize: 256, rng: foldRng.unit }),
    score: (model, rows) => scoreWithContext(model, rows, { window: 5 }).smoothed,
    rng: rng.unit,
    folds: config.folds,
    label: risk.label,
    eventDepths: { byWell: eventsByWell, depths, marginM: 60 },
  });

  const fitRng = makeRandom(config.seed);
  // The shipped model is fitted on every well. At inference time a *new* well is
  // scored against a forest built from this corpus; a well already in the corpus
  // is scored against a forest that includes it, which slightly flatters the
  // score. That is why the threshold is set from the held-out enrichment numbers
  // rather than from a score distribution.
  const model = fitIsolationForest(X, { trees: 100, sampleSize: 256, rng: fitRng.unit });
  const { smoothed } = scoreWithContext(model, X, { window: 5 });

  // The threshold is a quantile of the score distribution this model produces, not
  // a constant. Isolation Forest scores are interpretable only relative to the
  // forest that generated them: they depend on the subsample size and the training
  // population, so a hardcoded 0.6 is not a transferable number. An earlier version
  // hardcoded 0.6, which sat above this corpus's maximum score of 0.60 and so
  // flagged nothing at all - a silent, total failure. Deriving the threshold from
  // the score quantile means it cannot drift out of range when the features, the
  // sample size or the corpus change.
  const flagRate = 0.05;
  const sortedScores = smoothed.slice().sort((a, b) => a - b);
  const thresholdIndex = Math.min(sortedScores.length - 1, Math.floor((1 - flagRate) * sortedScores.length));
  const operatingThreshold = round(sortedScores[thresholdIndex], 4);

  // Measured separation against the event labels, so the card can state how much
  // signal there actually is. Reported rather than hidden: this model is
  // unsupervised, and a weak number here is a finding about the data rather than a
  // defect to be quietly left out of the card.
  const separationAuc = rocAuc(smoothed, data.y);
  const eventScores = smoothed.filter((_, index) => data.y[index] === 1);
  const otherScores = smoothed.filter((_, index) => data.y[index] === 0);
  const meanOf = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  const card = {
    ...baseCard(risk, metrics, data, config, trainedAt),
    kind: 'anomaly',
    algorithm: 'isolation_forest',
    scoreMeaning:
      'Smoothed anomaly score. Higher means the depth interval departs more from the way this field has historically drilled. It is a "look at this" signal, not a probability of trouble.',
    unsupervised: true,
    threshold: {
      value: operatingThreshold,
      basis: `top ${flagRate * 100}% of training-corpus scores`,
      rationale:
        'Isolation Forest scores depend on the subsample size and the training population, so a fixed constant does not transfer between models. A score quantile pins the flag rate to a stated rate.',
    },
    signalStrength: {
      aucAgainstEventLabels: separationAuc,
      meanScoreAtEvents: round(meanOf(eventScores), 4),
      meanScoreElsewhere: round(meanOf(otherScores), 4),
      reading:
        separationAuc === null
          ? 'no labelled events were available to measure separation against'
          : separationAuc < 0.6
            ? `Weak separation (AUC ${separationAuc}). The score finds intervals that are unusual, but it does not reliably indicate the intervals that became events. Treat it as a prompt to inspect, not as a risk ranking.`
            : `Moderate separation (AUC ${separationAuc}). The score is usefully related to event likelihood.`,
    },
    verdict: metrics.enrichment
      ? `The top 1% of scored intervals contain ${metrics.enrichment.intervalsContainingAnEvent} of ${metrics.enrichment.totalLoggedEvents} logged events.`
      : 'No logged events were available to check enrichment against.',
    limitations: [
      'Fitted without labels. The enrichment block is a sanity check on the ranking, not a trained accuracy.',
      'Scores for wells already present in the training corpus are optimistic, because the forest has seen them. A new well is scored honestly; a known well is not.',
      'The score says an interval is unusual relative to this field. It does not say the interval is dangerous — a genuinely interesting target interval can score high for entirely benign reasons.',
      ...baseCard(risk, metrics, data, config, trainedAt).limitations,
    ],
    enrichment: metrics.enrichment,
  };

  const anomalyArtifact = {
      ...model,
      smoothingWindow: 5,
      operatingThreshold,
      thresholdBasis: `top ${flagRate * 100}% of training-corpus anomaly scores`,
      featureVersion: FEATURE_VERSION,
      trainingWells: [...new Set(wells)],
    };

  const saved = saveModel(db, {
    name: `nwis_${risk.id.toLowerCase()}_anomaly`,
    riskType: risk.id,
    kind: 'anomaly',
    algorithm: 'isolation_forest',
    artifact: anomalyArtifact,
    metrics,
    modelCard: card,
    trainingRows: X.length,
    trainedAt,
    notes: card.verdict,
  });

  if (config.artifactsDir) {
    exportArtifact(config.artifactsDir, {
      name: saved.name,
      version: saved.version,
      riskType: risk.id,
      kind: 'anomaly',
      algorithm: 'isolation_forest',
      featureVersion: FEATURE_VERSION,
      featureList: FEATURE_NAMES,
      artifact: anomalyArtifact,
      metrics,
      modelCard: card,
      trainingRows: X.length,
      trainedAt,
      notes: card.verdict,
    });
  }

  return {
    riskType: risk.id,
    algorithm: 'isolation_forest',
    model: saved,
    trainingRows: X.length,
    wells: new Set(groups).size,
    enrichment: metrics.enrichment,
    separationAuc,
    threshold: operatingThreshold,
    thresholdBasis: anomalyArtifact.thresholdBasis,
    flagRate: metrics.flagRateAtDefault,
  };
}

// --- Model cards ------------------------------------------------------------

function baseCard(risk, metrics, data, config, trainedAt) {
  const wells = new Set(data.groups);
  return {
    name: `nwis_${risk.id.toLowerCase()}`,
    riskType: risk.id,
    purpose: risk.purpose,
    trainedAt,
    featureVersion: FEATURE_VERSION,
    featureList: FEATURE_NAMES,
    featureCount: FEATURE_NAMES.length,
    trainingRows: data.rows.length,
    trainingWells: wells.size,
    positives: data.y.reduce((a, b) => a + b, 0),
    positiveRate: round((data.y.reduce((a, b) => a + b, 0) / data.rows.length) * 100, 2),
    validation: {
      method: `${config.folds}-fold cross-validation grouped by well`,
      rationale:
        'Rows are split by well, never at random. Adjacent metres of one hole share their own neighbourhood in the rolling features and the same rock, so a random row split leaks the well into the training set and reports a number that does not survive the next well.',
      folds: config.folds,
    },
    expectedFeatures: risk.primaryFeatures,
    limitations: [
      `Labels are widened by ±${risk.labelMarginM} m around each recorded event so the model sees precursors. The positive rate in training (${round((data.y.reduce((a, b) => a + b, 0) / data.rows.length) * 100, 2)}%) is therefore higher than the operational event rate, and the operating threshold is not a frequency estimate.`,
      'Training data is synthetic. The generator derives event labels from the same physical channels the feature extractor measures, so a high score here demonstrates that the pipeline is internally consistent — it is not evidence of field performance. Real well data must be used before any operational decision rests on these numbers.',
      'One model covers the whole field. Formation-specific behaviour is expressed through the leave-one-well-out formation priors in the feature set, not through separate models.',
    ],
  };
}

function classifierCard({ risk, winner, runnerUp, evaluated, data, metrics, model, calibrator, threshold, config, trainedAt }) {
  const base = baseCard(risk, metrics, data, config, trainedAt);
  const coefficients =
    model.kind === 'logistic' && Array.isArray(model.weights)
      ? model.weights
          .map((weight, index) => ({ feature: FEATURE_NAMES[index], weight: round(weight, 4) }))
          .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
          .slice(0, 15)
      : null;

  return {
    ...base,
    kind: 'classifier',
    algorithm: winner.algorithm,
    headline:
      `Held-out ROC AUC ${metrics.rocAuc} over ${metrics.wells} unseen wells; ` +
      `at threshold ${threshold.threshold} it catches ${round(threshold.recall * 100, 1)}% of logged events with ` +
      `${round(threshold.precision * 100, 1)}% of alerts worth acting on.`,
    selection: {
      criterion: 'highest mean held-out ROC AUC across grouped folds, average precision as tie-break',
      candidates: evaluated.map((candidate) => ({
        algorithm: candidate.algorithm,
        rocAuc: candidate.metrics.rocAuc,
        rocAucConfidence: candidate.metrics.rocAucConfidence,
        averagePrecision: candidate.metrics.averagePrecision,
        calibrationError: candidate.metrics.calibration?.expectedCalibrationError ?? null,
        selected: candidate.algorithm === winner.algorithm,
      })),
      // Stating the losing candidate's score is what makes "we chose the linear
      // model" a finding rather than an omission.
      rationale:
        runnerUp && (runnerUp.metrics.rocAuc ?? 0) < (winner.metrics.rocAuc ?? 0)
          ? `${winner.algorithm} was selected because it scored higher on held-out wells than ${runnerUp.algorithm} (${metrics.rocAuc} vs ${runnerUp.metrics.rocAuc}). The features are engineered local ratios and physics margins, which are close to linear, so a boosted model had little interaction structure to exploit here. On a feature set with genuine non-linearity the ordering could reverse; the comparison is re-run on every training run for that reason.`
          : `${winner.algorithm} was selected over ${runnerUp?.algorithm ?? 'the alternative'} on held-out ROC AUC.`,
    },
    operatingPoint: {
      threshold: threshold.threshold,
      thresholdSource: 'chosen on pooled out-of-fold predictions with a precision floor',
      minPrecision: config.minPrecision,
      precision: threshold.precision,
      recall: threshold.recall,
      f1: threshold.f1,
      truePositives: threshold.tp,
      falsePositives: threshold.fp,
      falseNegatives: threshold.fn,
      trueNegatives: threshold.tn,
      note: threshold.note ?? null,
    },
    calibration: {
      method: 'Platt scaling fitted on the training set',
      slope: round(calibrator.slope, 4),
      intercept: round(calibrator.bias, 4),
      expectedCalibrationError: metrics.calibration?.expectedCalibrationError ?? null,
      reliability: metrics.calibration?.reliability ?? null,
    },
    baselines: metrics.baseline,
    topCoefficients: coefficients,
    interpretableRules:
      model.kind === 'logistic'
        ? null
        : // A boosted model has no single rule to show an operator, so the
          // largest leaves of the first few trees are surfaced instead. They are a
          // partial view and the card says so.
          model.trees.slice(0, 3).map((entry, index) => ({
            tree: index + 1,
            rules: treeRules(entry.root, FEATURE_NAMES, 6),
          })),
    foldSpread: metrics.foldSpread,
  };
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}