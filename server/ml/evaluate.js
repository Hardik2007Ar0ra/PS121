/**
 * Cross-validated evaluation of a candidate model.
 *
 * Three things here are not optional, and each exists because its absence has
 * produced a confidently wrong number before:
 *
 * 1. Splits are grouped by well. A random row split puts adjacent metres of the
 *    same hole on both sides; the rolling ratios in the feature set are computed
 *    from their own neighbourhood, so such a model scores well by memorising the
 *    well and reports a number that collapses on the next well.
 *
 * 2. Every candidate is measured against a baseline. For a classifier that is
 *    "predict the base rate everywhere"; for a regressor it is "predict the mean
 *    everywhere". A model that does not beat the baseline is reported as not
 *    beating it, however good its raw numbers look.
 *
 * 3. The operating threshold is chosen on held-out data with a precision floor,
 *    not at 0.5. On a class with a 1% base rate, a 0.5 threshold either fires on
 *    nothing or on everything.
 */

import { groupKFold } from './algorithms/cv.js';
import {
  averagePrecision,
  bestThreshold,
  bootstrapInterval,
  brierScore,
  calibration,
  confusionAt,
  recallAtK,
  regressionMetrics,
  rocAuc,
} from './algorithms/metrics.js';

/**
 * Evaluates a classifier factory across grouped folds.
 *
 * @param {object} params
 * @param {Array<Array<number>>} params.X
 * @param {Array<number>} params.y
 * @param {Array<string>} params.groups
 * @param {(trainX, trainY, options) => object} params.fit
 * @param {(model, rows) => number[]} params.predict raw scores, higher is riskier
 * @param {() => number} params.rng zero-argument uniform generator
 * @param {number} [params.folds]
 * @param {number} [params.minPrecision]
 */
export function evaluateClassifier({ X, y, groups, fit, predict, rng, folds = 5, minPrecision = 0.3, label = '' }) {
  const { splits } = groupKFold(X.length, groups, { folds, rng });
  if (!splits.length) return { error: 'no usable folds — the corpus is too small to split by well' };

  const foldResults = [];
  const oofScores = new Array(X.length).fill(null);
  const oofCalibrated = new Array(X.length).fill(null);

  splits.forEach((split) => {
    const trainX = split.train.map((i) => X[i]);
    const trainY = split.train.map((i) => y[i]);
    const testX = split.test.map((i) => X[i]);
    const testY = split.test.map((i) => y[i]);

    const model = fit(trainX, trainY, rng);
    const trainScores = predict(model, trainX);
    const testScores = predict(model, testX);

    // Calibration is fitted on the training fold and applied to the held-out
    // wells. Fitting it on the test fold would leak the answer into the
    // transformation that is then scored against it.
    const calibratedTest = model.calibrate
      ? model.calibrate(testScores, trainScores, trainY)
      : testScores;

    split.test.forEach((index, position) => {
      oofScores[index] = testScores[position];
      oofCalibrated[index] = calibratedTest[position];
    });

    const testPositives = testY.reduce((a, b) => a + (b === 1 ? 1 : 0), 0);
    foldResults.push({
      fold: split.fold,
      trainRows: split.train.length,
      testRows: split.test.length,
      trainPositives: trainY.reduce((a, b) => a + (b ?? 0), 0),
      testPositives,
      testBaseRate: round(testPositives / testY.length, 4),
      // Null is reported when the fold has a single class, not 0.5. "No ranking
      // to be right about" is a different finding from "no better than chance".
      rocAuc: rocAuc(testScores, testY),
      averagePrecision: averagePrecision(calibratedTest, testY),
      recall: recallAtK(testScores, testY, [10, 25]),
    });
  });

  // Only rows that appeared in a test fold can be pooled. Rows from wells dropped
  // for imbalance never got scored, and counting them as negatives would be a lie.
  const scored = [];
  for (let i = 0; i < X.length; i += 1) {
    if (oofScores[i] === null) continue;
    scored.push({ score: oofScores[i], calibrated: oofCalibrated[i], label: y[i], group: groups[i] });
  }

  const scores = scored.map((r) => r.score);
  const calibrated = scored.map((r) => r.calibrated);
  const labels = scored.map((r) => r.label);
  const scoredGroups = scored.map((r) => r.group);

  const positives = labels.reduce((a, b) => a + b, 0);
  const baseRate = positives / labels.length;

  // The baseline a naive deployment would achieve: flag everything.
  const alwaysPositive = confusionAt(scores.map(() => 1), labels, 0.5);

  const auc = rocAuc(scores, labels);
  const metrics = {
    kind: 'classifier',
    label,
    rows: X.length,
    scoredRows: labels.length,
    wells: new Set(scoredGroups).size,
    positives,
    positiveRate: round(baseRate, 4),
    folds: splits.length,
    rocAuc: round(auc, 4),
    // A CI on ~20 positives is the difference between "0.84 ± 0.06" and a number
    // that looks precise and is mostly noise.
    rocAucConfidence: auc === null ? null : bootstrapInterval(scores, labels, rocAuc, { rng, resamples: 300 }),
    averagePrecision: round(averagePrecision(calibrated, labels), 4),
    brierScore: brierScore(calibrated, labels),
    calibration: calibration(calibrated, labels),
    recall: recallAtK(scores, labels, [10, 25, 50]),
    // Threshold chosen on pooled out-of-fold predictions with a precision floor.
    operatingPoint: bestThreshold(calibrated, labels, { minPrecision }),
    baseline: {
      description: 'flag every depth interval as positive',
      precision: alwaysPositive.precision,
      recall: alwaysPositive.recall,
      note: 'the trivial comparator; a classifier is only worth deploying if its precision at equal recall beats this',
    },
    perFold: foldResults.map((f) => ({ ...f, rocAuc: round(f.rocAuc, 4), averagePrecision: round(f.averagePrecision, 4) })),
    // Mean and spread across folds. A model whose folds vary wildly is not a model
    // whose single held-out number should be trusted either.
    foldSpread: spread(foldResults.map((f) => f.rocAuc).filter((v) => v !== null)),
  };

  metrics.deltasVsBaseline = {
    precision: round(metrics.operatingPoint.precision - alwaysPositive.precision, 4),
    auc: auc === null ? null : round(auc - 0.5, 4),
  };

  /**
   * Whether this model should be allowed to generate alerts at all.
   *
   * A model whose operating point cannot beat "flag every depth interval" is
   * worse than useless in this application: every alert it raises costs a
   * driller's attention, and an operator who learns that the model cries wolf
   * stops reading it. Rather than let training activate such a model and let the
   * noise surface later, the gate is evaluated here and enforced by the trainer.
   *
   * The bar is deliberately low — better precision than flagging everything is
   * almost trivial — because the point is to catch the degenerate case, not to
   * second-guess a real result. AUC below 0.5 is separately disqualifying because
   * it means the ranking is actively backwards.
   */
  metrics.deploymentGate = {
    usable: metrics.deltasVsBaseline.precision > 0 && (auc === null || auc >= 0.5),
    beatsAlwaysAlert: metrics.deltasVsBaseline.precision > 0,
    rankingNotInverted: auc === null || auc >= 0.5,
    reasons: [
      ...(metrics.deltasVsBaseline.precision <= 0
        ? [
            `at its operating point the model reaches ${(metrics.operatingPoint.precision * 100).toFixed(1)}% precision, ` +
              `which does not beat flagging every interval (${(alwaysPositive.precision * 100).toFixed(1)}%)`,
          ]
        : []),
      ...(auc !== null && auc < 0.5 ? [`held-out ROC AUC ${round(auc, 3)} is below 0.5, so the ranking is inverted`] : []),
      ...(metrics.operatingPoint.tp === 0
        ? ['the operating threshold never fires, so the model would report no risk at all']
        : []),
    ],
  };

  return { metrics, outOfFold: { scores, calibrated, labels, groups: scoredGroups } };
}

/** Evaluates a regression target against the mean-predictor baseline. */
export function evaluateRegressor({ X, y, groups, fit, predict, rng, folds = 5, label = '' }) {
  const { splits } = groupKFold(X.length, groups, { folds, rng });
  if (!splits.length) return { error: 'no usable folds' };

  const foldResults = [];
  const predictions = new Array(X.length).fill(null);

  splits.forEach((split) => {
    const model = fit(split.train.map((i) => X[i]), split.train.map((i) => y[i]), rng);
    const testPredictions = predict(model, split.test.map((i) => X[i]));
    split.test.forEach((index, position) => {
      predictions[index] = testPredictions[position];
    });
    const foldMetrics = regressionMetrics(
      testPredictions,
      split.test.map((i) => y[i]),
    );
    foldResults.push({ fold: split.fold, trainRows: split.train.length, testRows: split.test.length, ...foldMetrics });
  });

  const scored = [];
  for (let i = 0; i < X.length; i += 1) if (predictions[i] !== null) scored.push(predictions[i]);
  const targets = [];
  for (let i = 0; i < X.length; i += 1) if (predictions[i] !== null) targets.push(y[i]);

  const overall = regressionMetrics(scored, targets);
  // Predicted distribution against actual: a regressor that outputs the mean for
  // everything has a good RMSE on a spiky target and is completely useless, and
  // that failure is invisible in the error metrics alone.
  const predictedStats = distribution(scored);
  const targetStats = distribution(targets);

  return {
    metrics: {
      kind: 'regressor',
      label,
      rows: X.length,
      wells: new Set(groups).size,
      folds: splits.length,
      ...overall,
      meanTarget: round(targetStats.mean, 4),
      predictedMean: round(predictedStats.mean, 4),
      predictedStdDev: round(predictedStats.stdDev, 4),
      targetStdDev: round(targetStats.stdDev, 4),
      beatsBaseline: overall.rmse !== null && overall.baselineRmse !== null ? overall.rmse < overall.baselineRmse : null,
      // NPT is heavily zero-inflated: most intervals cost nothing and a few cost
      // days. Squared error on that target is dominated by the tail, so the
      // operational value of the model has to be read off the percentile table
      // as well as the RMSE.
      percentiles: percentileTable(scored, targets),
      perFold: foldResults,
    },
  };
}

/**
 * Scores an anomaly model on held-out wells.
 *
 * There is no accuracy to report, because the model was not given labels. What
 * can honestly be reported is the concentration of real events in the flagged
 * set: if the top 1% of intervals by anomaly score contains most of the recorded
 * events, the score is finding something.
 */
export function evaluateAnomaly({ X, groups, fit, score, rng, folds = 5, label = '', eventDepths = null, wells = null }) {
  const { splits } = groupKFold(X.length, groups, { folds, rng });
  if (!splits.length) return { error: 'no usable folds' };

  const flags = new Array(X.length).fill(null);
  const scores = new Array(X.length).fill(null);

  splits.forEach((split) => {
    const model = fit(split.train.map((i) => X[i]), rng);
    const testScores = score(model, split.test.map((i) => X[i]));
    split.test.forEach((index, position) => {
      scores[index] = testScores[position];
    });
  });

  for (let i = 0; i < X.length; i += 1) if (scores[i] !== null) flags[i] = scores[i];

  const flagged = [];
  for (let i = 0; i < X.length; i += 1) if (flags[i] !== null) flagged.push(flags[i]);

  // Concentration of real events in the flagged set, at the top-k by score. The
  // event labels are used only for this reporting — they never entered training.
  const enrichment = eventDepths
    ? topKEnrichment({ scores: flags, groups, eventDepths, wells })
    : null;

  return {
    metrics: {
      kind: 'anomaly',
      label,
      rows: X.length,
      wells: new Set(groups).size,
      folds: splits.length,
      scoreRange: {
        min: round(Math.min(...flagged), 4),
        max: round(Math.max(...flagged), 4),
        mean: round(flagged.reduce((a, b) => a + b, 0) / flagged.length, 4),
      },
      // Without a reference point a score of 0.62 means nothing. The flag rate at
      // the default threshold is the one number an operator can act on.
      flagRateAtDefault: round(
        flagged.filter((s) => s >= 0.6).length / flagged.length,
        4,
      ),
      enrichment,
      note: 'trained without labels; the enrichment block reports how much of the real event set falls in the flagged intervals',
    },
  };
}

/**
 * Final fit on every well, once the configuration has been chosen by
 * cross-validation.
 *
 * `labels` is optional. When present, in-sample metrics are reported alongside the
 * model, purely so a reader can tell whether the cross-validated number is doing
 * real work or whether the model has simply memorised the corpus. They are labelled
 * as in-sample in the output for that reason.
 */
export function finalFit({ X, y, fit, predict, rng, labels = null }) {
  const model = fit(X, y, rng);
  const scores = predict(model, X);
  if (!labels) return { model, scores };

  const metrics = {
    kind: 'classifier',
    label: 'in-sample',
    rows: X.length,
    positives: y.reduce((a, b) => a + b, 0),
    rocAuc: round(rocAuc(scores, labels), 4),
    averagePrecision: round(averagePrecision(scores, labels), 4),
    // Reported so a reader can tell whether the cross-validated number is doing
    // real work or whether the model has simply memorised the corpus.
    note: 'in-sample; compare against the cross-validated metrics, not on its own',
  };
  return { model, scores, metrics };
}

function spread(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean: round(mean, 4), stdDev: round(Math.sqrt(variance), 4), min: round(Math.min(...values), 4), max: round(Math.max(...values), 4) };
}

function distribution(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, stdDev: Math.sqrt(variance) };
}

/** Predicted vs actual at fixed percentiles of the actual target. */
function percentileTable(predictions, targets) {
  const pairs = targets
    .map((target, index) => ({ target, prediction: predictions[index] }))
    .sort((a, b) => a.target - b.target);
  const table = [];
  [50, 75, 90, 95, 99].forEach((percentile) => {
    const position = Math.min(pairs.length - 1, Math.floor((percentile / 100) * pairs.length));
    const slice = pairs.slice(0, position + 1);
    const actual = slice.reduce((a, b) => a + b.target, 0) / slice.length;
    const predicted = slice.reduce((a, b) => a + b.prediction, 0) / slice.length;
    table.push({
      percentile,
      rows: position + 1,
      meanActualHours: round(actual, 2),
      meanPredictedHours: round(predicted, 2),
      // Positive means the model under-predicts the cost of the worst intervals,
      // which is exactly the error that matters when planning a well.
      underPrediction: round(predicted - actual, 2),
    });
  });
  return table;
}

/**
 * How many real events fall inside the top-k flagged intervals.
 *
 * This is the only honest evaluation of an unsupervised score: it asks whether
 * the ranking it produces puts real trouble near the top.
 */
function topKEnrichment({ scores, groups, eventDepths, wells }) {
  const byWell = new Map();
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] === null) continue;
    const group = groups[i];
    if (!byWell.has(group)) byWell.set(group, []);
    byWell.get(group).push({ score: scores[i], depth: eventDepths.depths?.[i] });
  }

  const ranked = [];
  byWell.forEach((entries, well) => {
    const events = eventDepths.byWell.get(well) ?? [];
    const sorted = entries.slice().sort((a, b) => b.score - a.score);
    const take = Math.max(1, Math.floor(sorted.length * 0.01));
    sorted.slice(0, take).forEach((entry) => {
      // An interval counts as a hit when a real event falls inside it. Anything
      // looser and the metric would credit the model for flagging whole wells.
      ranked.push(events.some((eventDepth) => Math.abs(eventDepth - entry.depth) <= eventDepths.marginM));
    });
  });

  if (!ranked.length) return null;
  const hits = ranked.filter(Boolean).length;
  const totalEvents = [...eventDepths.byWell.values()].reduce((a, b) => a + b.length, 0);
  return {
    topOnePercentIntervals: ranked.length,
    intervalsContainingAnEvent: hits,
    recallOfLoggedEvents: totalEvents ? round(hits / totalEvents, 4) : null,
    totalLoggedEvents: totalEvents,
    marginM: eventDepths.marginM,
  };
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}