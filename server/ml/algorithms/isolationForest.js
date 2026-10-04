/**
 * Isolation Forest for the unsupervised formation-risk model.
 *
 * The problem statement asks for anomaly detection over historical data, and this
 * is the right tool for the part of the problem where no labels exist: the well
 * being drilled now has no record of what happens next. Isolation Forest fits by
 * isolating samples — an anomaly is a point that separates from the rest in few
 * random splits — which needs no class balance and no positive examples.
 *
 * It is applied here to *depth intervals within a single well*, not to the corpus
 * as a whole. That distinction is the whole design: a depth that looks unusual
 * next to the rest of this well is either a genuine departure from its own
 * drilling or a recording artefact, and either way a geologist should look at it.
 * Fitting one forest per well is what makes the score comparable across wells,
 * because every well is standardised against its own history rather than against a
 * corpus average that the deepest well dominates.
 */

import { buildTree, predictTree } from './tree.js';

/** Average path length of an unsuccessful BST search over n points. */
export function averagePathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

export function fitIsolationForest(rows, options = {}) {
  const {
    trees = 80,
    sampleSize = 256,
    maxDepth = 8,
    rng = Math.random,
  } = options;

  const n = rows.length;
  if (!n) throw new Error('fitIsolationForest: no rows');

  // A sample size above 256 buys almost nothing: the forest variance dominates
  // beyond that, and small samples are what make path lengths cheap to compute.
  const effectiveSample = Math.min(sampleSize, n);
  const columnCount = rows[0].length;
  const forest = [];

  for (let t = 0; t < trees; t += 1) {
    const sample = new Array(effectiveSample);
    for (let i = 0; i < effectiveSample; i += 1) {
      sample[i] = rows[Math.floor(rng() * n)];
    }
    // Each tree uses a random subset of features, so different trees can isolate
    // along different axes. Without this every tree would find the same splits.
    const featureCount = Math.max(1, Math.floor(columnCount * 0.6));
    const features = [];
    const pool = [...Array(columnCount).keys()];
    for (let i = 0; i < featureCount; i += 1) {
      features.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    features.sort((a, b) => a - b);

    const depthLimit = Math.max(1, Math.ceil(Math.log2(Math.max(2, effectiveSample))));
    const root = buildIsolationTree(sample, features, 0, depthLimit, rng);
    forest.push(root);
  }

  return {
    kind: 'isolation_forest',
    forest,
    trees,
    sampleSize: effectiveSample,
    columnCount,
    // c(n) normalises path lengths across different subsample sizes, without
    // which two forests of different sizes would give incomparable scores.
    normalizer: averagePathLength(effectiveSample),
    n,
  };
}

/**
 * Grows one isolation tree.
 *
 * The algorithm's whole premise is that it does *not* try to find a good split. A
 * feature is drawn at random from this tree's subset, and a threshold is drawn at
 * random from inside that feature's observed range in the node. The resulting
 * partition is often badly unbalanced, and that is the mechanism rather than a
 * defect: an ordinary point gets caught in the crowd of a skewed split and needs
 * many rounds to isolate, while a point alone in an empty corner of the space is
 * isolated in one or two. Path length is the score.
 *
 * An earlier version searched for the split that divided the node most evenly.
 * That is a perfectly good balanced search tree and a useless isolation forest:
 * every point reached depth log2(n), every score collapsed onto 2^(-1) ≈ 0.5, and
 * the measured spread across the corpus was 0.556 to 0.565 with no ability to rank
 * anything at all. The randomness is not a shortcut here — it is the algorithm.
 */
function buildIsolationTree(sample, features, depth, depthLimit, rng) {
  const node = { depth, n: sample.length };

  // The depth limit is ceil(log2 psi): a point that survives to this depth is
  // indistinguishable from the bulk, so it is scored as if isolated exactly here.
  // Growth also stops when a single point remains, which is genuine isolation.
  if (depth >= depthLimit || sample.length <= 1) return node;

  // One random feature per node. A few retries are allowed only because a single
  // feature can be constant in this node, leaving no threshold to draw, and
  // retrying a different feature is the cheapest way past that.
  for (let attempt = 0; attempt < 4 && features.length > 0; attempt += 1) {
    const column = features[Math.floor(rng() * features.length)];

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < sample.length; i += 1) {
      const value = sample[i][column];
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    // A constant or wholly-missing feature cannot be split on.
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) continue;

    // Uniform between min and max, so neither end is favoured. Drawing from the
    // sorted values instead would over-sample dense regions and bias every split
    // towards the centre of the distribution.
    const threshold = min + rng() * (max - min);
    const left = [];
    const right = [];
    for (let i = 0; i < sample.length; i += 1) {
      const value = sample[i][column];
      if (Number.isFinite(value) && value <= threshold) left.push(sample[i]);
      else right.push(sample[i]);
    }
    // An empty side would waste the node entirely. Redrawing is better than
    // recursing on it, and this is the only place the pure random-threshold rule
    // is bent.
    if (!left.length || !right.length) continue;

    node.column = column;
    node.value = threshold;
    node.left = buildIsolationTree(left, features, depth + 1, depthLimit, rng);
    node.right = buildIsolationTree(right, features, depth + 1, depthLimit, rng);
    return node;
  }

  return node;
}

/** Depth of the leaf a point falls into. */
function isolationPathLength(node, row) {
  let current = node;
  while (current.column !== undefined) {
    const value = row[current.column];
    current = Number.isFinite(value) && value <= current.value ? current.left : current.right;
  }
  // The conventional +c(|leaf|) correction accounts for the fact that a leaf with
  // several points was truncated by the depth limit, not by isolation.
  return current.depth + averagePathLength(current.n);
}

/**
 * Anomaly scores in (0, 1], where higher is more anomalous.
 *
 * `2^(-E[h(x)] / c(n))` is the standard formulation. The exponent is negative, so
 * a point isolated in few splits gets a score near 1 — and, importantly, the
 * score is comparable across trees and across wells with the same sample size.
 */
export function scoreIsolation(model, rows) {
  return rows.map((row) => {
    let total = 0;
    for (let t = 0; t < model.forest.length; t += 1) {
      total += isolationPathLength(model.forest[t], row);
    }
    const expected = total / model.forest.length;
    const normaliser = model.normalizer || averagePathLength(model.sampleSize);
    return Math.min(1, Math.max(0, 2 ** (-expected / normaliser)));
  });
}

/**
 * A depth interval's anomaly score blended with its own local context.
 *
 * Isolation Forest answers "does this look like the well's bulk drilling?" A
 * single sample can look odd for a boring reason — a rig-floor sensor glitch, a
 * connection, a circulation. Requiring the anomaly to persist over a short window
 * is what turns it into an operational signal rather than a data-quality one, and
 * the window length is stated so the behaviour is not a hidden parameter.
 */
export function scoreWithContext(model, rows, { window = 5 } = {}) {
  const raw = scoreIsolation(model, rows);
  const smoothed = raw.map((_, index) => {
    const start = Math.max(0, index - window);
    const slice = raw.slice(start, index + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  return { raw, smoothed };
}