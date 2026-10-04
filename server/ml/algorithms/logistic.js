/**
 * L2-regularised logistic regression, fitted by full-batch gradient descent with
 * Adam.
 *
 * Full batch rather than mini-batch because the training sets here are small
 * (10^4 rows) and every row is visited anyway; mini-batching would add
 * hyper-parameters without improving the fit. Adam rather than plain GD because
 * the features are correlated and differently scaled, and L2-regularised logistic
 * regression on such data converges in tens of iterations under Adam where plain
 * GD oscillates.
 *
 * This is the interpretable baseline the problem statement needs: it trains in
 * under a second, exposes a signed coefficient per feature, and its calibration
 * curve can be inspected. The gradient-boosted model is then judged against it
 * rather than against a wish.
 */

import { logisticLoss, sigmoid, standardise, columnMeans, columnStdDevs } from './linalg.js';

/**
 * @param {object} options
 * @param {number} [options.l2] L2 penalty. Small but non-zero: with correlated
 *   features (torque, torque ratio and drag all move together) an unregularised fit
 *   splits weight across them unpredictably and the coefficients stop meaning much.
 * @param {number} [options.learningRate]
 * @param {number} [options.iterations]
 * @param {number} [options.positiveWeight] Cost weighting for the positive class,
 *   used to trade recall against precision on rare events.
 * @param {() => number} [options.rng] Only used for weight initialisation; results
 *   stay reproducible for a given seed.
 */
export function fitLogistic(rows, labels, options = {}) {
  const {
    l2 = 1e-3,
    learningRate = 0.08,
    iterations = 400,
    positiveWeight = 1,
    tolerance = 1e-7,
    rng = Math.random,
  } = options;

  const n = rows.length;
  if (!n) throw new Error('fitLogistic: no rows');
  const cols = rows[0].length;

  // Standardisation is fitted on the training fold only. Doing it on the full
  // matrix before splitting would leak the held-out wells' means and spreads into
  // training, which is a quieter version of the same mistake as a random split.
  const means = columnMeans(rows, cols);
  const devs = columnStdDevs(rows, cols, means);
  const x = standardise(rows, cols, means, devs);

  const positives = labels.reduce((sum, l) => sum + (l === 1 ? 1 : 0), 0);
  const weightScale = positives > 0 && positives < n
    ? (n - positives) / positives
    : 1;
  const classWeight = positiveWeight * weightScale;

  // Intercept is not regularised: penalising it biases the model towards a 50%
  // prior, which is never what is wanted.
  const weights = new Float64Array(cols).map(() => (rng() - 0.5) * 0.01);
  let bias = Math.log((positives + 1) / (n - positives + 1));

  const m = new Float64Array(cols + 1);
  const v = new Float64Array(cols + 1);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;

  let previousLoss = Infinity;
  let loss = Infinity;

  for (let t = 1; t <= iterations; t += 1) {
    const gradW = new Float64Array(cols);
    let gradB = 0;
    const probabilities = new Float64Array(n);

    for (let i = 0; i < n; i += 1) {
      const row = x[i];
      let z = bias;
      for (let j = 0; j < cols; j += 1) z += weights[j] * row[j];
      const p = sigmoid(z);
      probabilities[i] = p;
      // Cost-sensitive gradient: a missed mud loss costs more than a wasted
      // warning, so positives carry proportionally more weight.
      const target = labels[i] === 1 ? classWeight : 1;
      const factor = (p - labels[i]) * target;
      for (let j = 0; j < cols; j += 1) gradW[j] += factor * row[j];
      gradB += factor;
    }

    for (let j = 0; j < cols; j += 1) {
      gradW[j] = gradW[j] / n + l2 * weights[j];
      gradB /= n;
    }

    for (let j = 0; j < cols; j += 1) {
      const g = gradW[j];
      m[j] = beta1 * m[j] + (1 - beta1) * g;
      v[j] = beta2 * v[j] + (1 - beta2) * g * g;
      const mHat = m[j] / (1 - beta1 ** t);
      const vHat = v[j] / (1 - beta2 ** t);
      weights[j] -= (learningRate * mHat) / (Math.sqrt(vHat) + epsilon);
    }
    m[cols] = beta1 * m[cols] + (1 - beta1) * gradB;
    v[cols] = beta2 * v[cols] + (1 - beta2) * gradB * gradB;
    bias -= (learningRate * (m[cols] / (1 - beta1 ** t))) / (Math.sqrt(v[cols] / (1 - beta2 ** t)) + epsilon);

    if (t % 10 === 0 || t === iterations) {
      const probabilities2 = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        let z = bias;
        for (let j = 0; j < cols; j += 1) z += weights[j] * x[i][j];
        probabilities2[i] = sigmoid(z);
      }
      loss = logisticLoss(probabilities2, labels);
      if (Math.abs(previousLoss - loss) < tolerance) break;
      previousLoss = loss;
    }
  }

  return {
    kind: 'logistic',
    weights: Array.from(weights),
    bias,
    means: Array.from(means),
    deviations: Array.from(devs),
    l2,
    trainingLoss: loss,
    classWeight,
    positives,
    n,
  };
}

/**
 * Platt scaling: fit a 1-D logistic regression on the classifier's own output
 * scores. A boosted model trained with squared error on residuals tends to be
 * systematically over- or under-confident at the extremes; calibration is what
 * turns a ranking into a probability an operator can act on.
 */
export function fitPlatt(scores, labels, options = {}) {
  const model = fitLogistic(
    scores.map((score) => [score]),
    labels,
    { ...options, l2: 0, iterations: options.iterations ?? 200 },
  );
  return {
    kind: 'platt',
    slope: model.weights[0],
    bias: model.bias,
    mean: model.means[0],
    deviation: model.deviations[0],
  };
}

/**
 * A trivial calibrator used when Platt cannot be fitted — for example when the
 * held-out fold contains a single class. Returning a pass-through is honest:
 * the model is then uncalibrated and the model card says so via the calibration
 * block, rather than being silently adjusted toward a base rate it cannot see.
 */
export function identityCalibrator() {
  return { kind: 'identity', slope: 1, bias: 0, mean: 0, deviation: 1 };
}

export function predictLogistic(model, rows) {
  const cols = model.weights.length;
  return rows.map((row) => {
    let z = model.bias;
    for (let j = 0; j < cols; j += 1) {
      const value = row[j];
      if (!Number.isFinite(value)) continue;
      z += model.weights[j] * ((value - model.means[j]) / model.deviations[j]);
    }
    return sigmoid(z);
  });
}

/** Applies a Platt (or identity) calibrator to raw scores. */
export function calibrate(calibrator, scores) {
  return scores.map((score) => sigmoid(calibrator.slope * ((score - calibrator.mean) / (calibrator.deviation || 1)) + calibrator.bias));
}