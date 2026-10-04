/**
 * Evaluation metrics.
 *
 * Everything here is computed from arrays of scores and labels. The deliberate
 * omission is a single "accuracy" headline: the classes are heavily imbalanced,
 * so accuracy is not a meaningful summary and reporting it would invite the wrong
 * conclusion. Threshold-dependent metrics are always reported at a stated
 * threshold, alongside the ranking metrics that are threshold-free.
 */

/** Rank-based ROC AUC via the Mann-Whitney statistic, ties counted as half. */
export function rocAuc(scores, labels) {
  const positives = [];
  const negatives = [];
  for (let i = 0; i < scores.length; i += 1) {
    if (labels[i] === 1) positives.push(scores[i]);
    else negatives.push(scores[i]);
  }
  const nPos = positives.length;
  const nNeg = negatives.length;
  // Undefined is the honest answer here, not 0.5: with no positives there is no
  // ranking to be right about, and a model card that says "AUC 0.50" for an
  // empty class reads as "the model is useless" when it means "nothing to learn".
  if (nPos === 0 || nNeg === 0) return null;

  const sorted = [
    ...positives.map((v) => ({ v, p: 1 })),
    ...negatives.map((v) => ({ v, p: 0 })),
  ].sort((a, b) => a.v - b.v);

  // Average rank within groups of equal scores so ties contribute 0.5.
  let rankSumPos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (sorted[k].p === 1) rankSumPos += averageRank;
    i = j + 1;
  }

  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Average precision (area under the precision-recall curve).
 *
 * Reported alongside ROC AUC because at the base rates seen here — well under
 * 1% positives — precision-recall separates useful models from useless ones far
 * more sharply than ROC does.
 */
export function averagePrecision(scores, labels) {
  const order = scores
    .map((score, index) => ({ score, label: labels[index] }))
    .sort((a, b) => b.score - a.score);
  const totalPositives = labels.reduce((sum, l) => sum + (l === 1 ? 1 : 0), 0);
  if (totalPositives === 0) return null;

  let truePositives = 0;
  let precisionSum = 0;
  order.forEach((item, index) => {
    if (item.label !== 1) return;
    truePositives += 1;
    precisionSum += truePositives / (index + 1);
  });
  return precisionSum / totalPositives;
}

export function confusionAt(scores, labels, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < scores.length; i += 1) {
    const predicted = scores[i] >= threshold ? 1 : 0;
    if (predicted === 1 && labels[i] === 1) tp += 1;
    else if (predicted === 1) fp += 1;
    else if (labels[i] === 1) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    threshold,
    tp,
    fp,
    tn,
    fn,
    precision: round(precision, 4),
    recall: round(recall, 4),
    // F1 is undefined when nothing is predicted and nothing is found; reporting
    // 0 would read as "the model failed" rather than "the threshold was too high".
    f1: precision + recall > 0 ? round((2 * precision * recall) / (precision + recall), 4) : 0,
    // The single most useful number on an alert dashboard: how many of the
    // alerts an operator actually receives are worth acting on.
    alertPrecision: round(precision, 4),
  };
}

/**
 * Picks the threshold that maximises F1, with a minimum-precision floor applied
 * first. Without the floor an F1-optimal threshold on a rare event class happily
 * buys recall by firing on everything, which is not an operational improvement.
 */
export function bestThreshold(scores, labels, { minPrecision = 0.3, gridSize = 200 } = {}) {
  const sorted = scores.slice().sort((a, b) => a - b);
  const lo = sorted.length ? sorted[0] : 0;
  const hi = sorted.length ? sorted[sorted.length - 1] : 1;
  let best = { f1: -1, precision: 0, recall: 0, threshold: Math.max(0.5, (lo + hi) / 2) };
  for (let g = 0; g <= gridSize; g += 1) {
    const threshold = lo + ((hi - lo) * g) / gridSize;
    const stats = confusionAt(scores, labels, threshold);
    if (stats.precision < minPrecision && stats.f1 > 0) continue;
    if (stats.f1 > best.f1 || (stats.f1 === best.f1 && stats.recall > best.recall)) best = stats;
  }
  // Never fall back to "predict nothing": an alert that never fires is not a safe
  // default, it is an absent model.
  if (best.f1 < 0) {
    const fallback = confusionAt(scores, labels, 0.5);
    return { ...fallback, note: 'no threshold reached the precision floor' };
  }
  return best;
}

/** Mean squared / absolute error and R² for a regression target. */
export function regressionMetrics(predictions, targets) {
  const n = targets.length;
  if (!n) return { rmse: null, mae: null, r2: null };
  let sumSquared = 0;
  let sumAbsolute = 0;
  for (let i = 0; i < n; i += 1) {
    const error = predictions[i] - targets[i];
    sumSquared += error * error;
    sumAbsolute += Math.abs(error);
  }
  const meanTarget = targets.reduce((a, b) => a + b, 0) / n;
  let totalVariance = 0;
  for (let i = 0; i < n; i += 1) totalVariance += (targets[i] - meanTarget) ** 2;

  const rmse = Math.sqrt(sumSquared / n);
  return {
    rmse: round(rmse, 4),
    mae: round(sumAbsolute / n, 4),
    // R² of 0 against a mean-predictor baseline; negative means worse than
    // always predicting the average, which is the honest reading.
    r2: totalVariance > 0 ? round(1 - sumSquared / totalVariance, 4) : null,
    baselineRmse: round(Math.sqrt(totalVariance / n), 4),
  };
}

/**
 * Expected calibration error, plus per-bin reliability.
 *
 * Reported for every classifier because a model that is well ranked but badly
 * calibrated produces alerts nobody trusts: a score of 0.8 has to actually mean
 * 80%.
 */
export function calibration(probabilities, labels, bins = 10) {
  const buckets = Array.from({ length: bins }, (_, i) => ({
    lower: i / bins,
    upper: (i + 1) / bins,
    count: 0,
    sumProbability: 0,
    sumLabel: 0,
  }));
  probabilities.forEach((p, index) => {
    const clamped = Math.min(0.999999, Math.max(0, p));
    const bin = Math.min(bins - 1, Math.floor(clamped * bins));
    buckets[bin].count += 1;
    buckets[bin].sumProbability += p;
    buckets[bin].sumLabel += labels[index];
  });

  let error = 0;
  const reliability = buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => {
      const meanProbability = bucket.sumProbability / bucket.count;
      const observed = bucket.sumLabel / bucket.count;
      error += Math.abs(meanProbability - observed) * bucket.count;
      return {
        range: `${bucket.lower.toFixed(1)}–${bucket.upper.toFixed(1)}`,
        count: bucket.count,
        meanPredicted: round(meanProbability, 4),
        observedFrequency: round(observed, 4),
      };
    });

  const n = probabilities.length;
  return { expectedCalibrationError: n ? round(error / n, 4) : null, reliability };
}

/** Brier score — proper scoring rule for binary outcomes. */
export function brierScore(probabilities, labels) {
  const n = labels.length;
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (probabilities[i] - labels[i]) ** 2;
  return round(sum / n, 4);
}

/**
 * Recall at the top-k predictions, the metric an alert look-ahead actually
 * cares about: "if the model fires its three highest-confidence warnings, how
 * many real events are they?".
 */
export function recallAtK(scores, labels, ks = [5, 10, 20]) {
  const order = scores
    .map((score, index) => ({ score, label: labels[index] }))
    .sort((a, b) => b.score - a.score);
  const totalPositives = labels.reduce((sum, l) => sum + (l === 1 ? 1 : 0), 0);
  if (!totalPositives) return Object.fromEntries(ks.map((k) => [`recallAt${k}`, null]));

  const result = {};
  ks.forEach((k) => {
    let hits = 0;
    const top = order.slice(0, k);
    top.forEach((item) => {
      if (item.label === 1) hits += 1;
    });
    result[`recallAt${k}`] = round(hits / totalPositives, 4);
  });
  return result;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Bootstrap confidence interval over the sample indices.
 *
 * Reported for AUC because a single point estimate on ~20 positives is far less
 * informative than the width of its interval, and a model card that omits it
 * invites over-confidence in a number that is mostly noise.
 */
export function bootstrapInterval(scores, labels, statistic, { resamples = 400, alpha = 0.05, rng = Math.random } = {}) {
  const n = labels.length;
  if (n < 10) return null;
  const values = [];
  const indexPool = Array.from({ length: n }, (_, i) => i);

  for (let r = 0; r < resamples; r += 1) {
    const sample = [];
    for (let i = 0; i < n; i += 1) sample.push(indexPool[Math.floor(rng() * n)]);
    const value = statistic(sample.map((i) => scores[i]), sample.map((i) => labels[i]));
    if (Number.isFinite(value)) values.push(value);
  }
  if (values.length < 10) return null;
  values.sort((a, b) => a - b);
  const lower = values[Math.floor((alpha / 2) * values.length)];
  const upper = values[Math.floor((1 - alpha / 2) * values.length)];
  return { lower: round(lower, 4), upper: round(upper, 4), resamples: values.length };
}