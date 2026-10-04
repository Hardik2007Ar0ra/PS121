/**
 * Dense matrix helpers.
 *
 * Rows are plain arrays and matrices are arrays of rows. At this corpus size
 * (order 10^4 rows × 46 columns) that is comfortably fast and keeps every model
 * artifact as ordinary JSON, which matters more here than raw throughput: the
 * artifacts have to be diffable and loadable without a native dependency.
 */

export function zeros(rows, cols) {
  return Array.from({ length: rows }, () => new Float64Array(cols));
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** Column means, ignoring rows where the value is not finite. */
export function columnMeans(rows, cols) {
  const sums = new Float64Array(cols);
  const counts = new Int32Array(cols);
  rows.forEach((row) => {
    for (let j = 0; j < cols; j += 1) {
      const value = row[j];
      if (Number.isFinite(value)) {
        sums[j] += value;
        counts[j] += 1;
      }
    }
  });
  const means = new Float64Array(cols);
  for (let j = 0; j < cols; j += 1) means[j] = counts[j] ? sums[j] / counts[j] : 0;
  return means;
}

/**
 * Column standard deviations with a floor.
 *
 * The floor is not cosmetic. Several features are constant within a well or a
 * field — `mud_system_oil_based` is often all-ones, `prior_severity_p90` is 0
 * wherever no offset well had trouble — and without it the standardisation step
 * divides by zero and fills the model with NaN.
 */
export function columnStdDevs(rows, cols, means, floor = 1e-6) {
  const sums = new Float64Array(cols);
  const squares = new Float64Array(cols);
  const counts = new Int32Array(cols);
  rows.forEach((row) => {
    for (let j = 0; j < cols; j += 1) {
      const value = row[j];
      if (!Number.isFinite(value)) continue;
      const centred = value - means[j];
      sums[j] += centred;
      squares[j] += centred * centred;
      counts[j] += 1;
    }
  });
  const devs = new Float64Array(cols);
  for (let j = 0; j < cols; j += 1) {
    if (counts[j] < 2) {
      devs[j] = 1;
      continue;
    }
    const variance = Math.max(0, squares[j] / counts[j] - (sums[j] / counts[j]) ** 2);
    devs[j] = Math.max(floor, Math.sqrt(variance));
  }
  return devs;
}

/** In-place standardisation, returning a new matrix. */
export function standardise(rows, cols, means, devs) {
  return rows.map((row) => {
    const out = new Float64Array(cols);
    for (let j = 0; j < cols; j += 1) {
      const value = row[j];
      out[j] = Number.isFinite(value) ? (value - means[j]) / devs[j] : 0;
    }
    return out;
  });
}

/** Numerically stable logistic. */
export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function logisticLoss(probabilities, labels) {
  let sum = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, probabilities[i]));
    sum += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / labels.length;
}

/**
 * Deterministic Fisher-Yates shuffle driven by a seeded generator.
 *
 * `Math.random` is never used anywhere in the training path: a model that
 * cannot be reproduced cannot have its reported metrics believed.
 */
export function shuffle(indices, rng) {
  const out = indices.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}