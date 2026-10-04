/**
 * Gradient-boosted decision trees.
 *
 * For the binary classifiers here the loss is the logistic one, so each round
 * fits a regression tree to the gradient of the log-loss with a leaf shrinkage
 * term, then updates the running log-odds. That combination — logistic loss,
 * regression trees, leaf shrinkage — is the standard generalisation of AdaBoost
 * and is what makes boosted probabilities need Platt calibration: squared-error
 * boosting would give the same ranking with far worse calibration.
 *
 * Boosting is compared against plain logistic regression at training time and
 * both artifacts are kept, with the better model by held-out AUC promoted. The
 * comparison is recorded in the model card either way, because "we used boosting
 * because it was better" and "we used boosting because it is fashionable" are
 * very different claims.
 */

import { sigmoid } from './linalg.js';
import { buildTree, predictTree } from './tree.js';

export function fitGbdtClassifier(rows, labels, options = {}) {
  const {
    rounds = 120,
    learningRate = 0.08,
    maxDepth = 3,
    minLeaf = 60,
    sampleLimit = 2000,
    rowSampleRatio = 0.7,
    rng = Math.random,
    l2 = 1.0,
  } = options;

  const n = rows.length;
  if (!n) throw new Error('fitGbdtClassifier: no rows');

  const positives = labels.reduce((sum, l) => sum + (l === 1 ? 1 : 0), 0);
  // Start from the empirical log-odds rather than zero, so the first tree only has
  // to learn the structure, not the base rate. This matters when positives are
  // 0.4% of rows: starting at zero would spend early rounds on an intercept the
  // data already answers.
  const baseScore = Math.log((positives + 0.5) / (n - positives + 0.5));

  const rawScores = new Float64Array(n).fill(baseScore);
  const trees = [];
  const featureUse = new Map();

  for (let round = 0; round < rounds; round += 1) {
    // Fit the round's tree to the *negative* gradient of the log-loss, then add
    // its prediction to the running score. d(log-loss)/d(logit) = p - y, so the
    // negative gradient is y - p: for an unrecognised positive this is positive,
    // and adding the tree's output moves the score up. Fitting to +gradient and
    // adding it instead would push every prediction away from the label, which
    // is exactly what it did — the AUC came out at 0.10.
    const negativeGradient = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      negativeGradient[i] = labels[i] - sigmoid(rawScores[i]);
    }

    // Stochastic boosting: each round sees a fresh random subset of rows. It cuts
    // training time by the sampling ratio and, by preventing later trees from
    // re-fitting the same rows over and over, usually improves generalisation too.
    const roundIndices = rowSampleRatio >= 1
      ? rows.map((_, i) => i)
      : sampleIndices(n, rowSampleRatio, rng);

    const tree = buildTree(rows, negativeGradient, {
      task: 'regression',
      maxDepth,
      minLeaf,
      sampleLimit,
      indices: roundIndices,
      rng,
    });

    // Shrinkage as a leaf-wise L2 pull towards zero. On top of the learning rate
    // this is the usual defence against the last trees fitting noise: a tree
    // whose leaves barely move is close to its regularised fixed point.
    for (let i = 0; i < n; i += 1) {
      rawScores[i] += learningRate * (followTree(tree, rows[i]).value / (1 + l2 * learningRate));
    }

    tallyFeatures(tree, featureUse);
    trees.push({ root: tree, learningRate, l2 });

    // Stop once the trees are no longer moving the training set.
    let moved = 0;
    for (let i = 0; i < n; i += 1) moved += Math.abs(learningRate * followTree(tree, rows[i]).value);
    if (round > 10 && moved / n < 1e-5) break;
  }

  const importance = [...featureUse.entries()]
    .map(([column, uses]) => ({ column, uses }))
    .sort((a, b) => b.uses - a.uses);

  return {
    kind: 'gbdt_classifier',
    baseScore,
    trees,
    rounds: trees.length,
    learningRate,
    l2,
    maxDepth,
    rowSampleRatio,
    featureImportance: importance,
    n,
    positives,
  };
}

/** Indices of a random subset, without replacement. */
function sampleIndices(n, ratio, rng) {
  const count = Math.max(2, Math.floor(n * ratio));
  const pool = new Int32Array(n);
  for (let i = 0; i < n; i += 1) pool[i] = i;
  // Partial Fisher-Yates: only the first `count` positions need to be correct.
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return Array.from(pool.subarray(0, count));
}

/** Raw boosted log-odds. Kept separate from the calibrated probability. */
export function predictGbdtRaw(model, rows) {
  return rows.map((row) => {
    let score = model.baseScore;
    for (let t = 0; t < model.trees.length; t += 1) {
      score += model.trees[t].learningRate * followTree(model.trees[t].root, row).value;
    }
    return score;
  });
}

export function predictGbdt(model, rows) {
  return predictGbdtRaw(model, rows).map(sigmoid);
}

function followTree(root, row) {
  let node = root;
  while (node.column !== undefined) {
    const value = row[node.column];
    node = Number.isFinite(value) && value <= node.threshold ? node.left : node.right;
  }
  return node;
}

function tallyFeatures(node, tally) {
  if (node.column === undefined) return;
  tally.set(node.column, (tally.get(node.column) || 0) + 1);
  tallyFeatures(node.left, tally);
  tallyFeatures(node.right, tally);
}

/**
 * Gradient-boosted regression trees for the NPT model.
 *
 * The loss is squared error rather than logistic: NPT is a quantity in hours, and
 * squaring is the loss that makes the fitted value an estimate of hours rather
 * than a ranking.
 */
export function fitGbdtRegressor(rows, targets, options = {}) {
  const {
    rounds = 100,
    learningRate = 0.1,
    maxDepth = 4,
    minLeaf = 40,
    sampleLimit = 2000,
    rowSampleRatio = 0.7,
    rng = Math.random,
    l2 = 1.0,
  } = options;

  const n = rows.length;
  if (!n) throw new Error('fitGbdtRegressor: no rows');

  const baseScore = targets.reduce((a, b) => a + b, 0) / n;
  const predictions = new Float64Array(n).fill(baseScore);
  const trees = [];
  const featureUse = new Map();

  for (let round = 0; round < rounds; round += 1) {
    const residuals = new Float64Array(n);
    for (let i = 0; i < n; i += 1) residuals[i] = targets[i] - predictions[i];

    const roundIndices = rowSampleRatio >= 1
      ? rows.map((_, i) => i)
      : sampleIndices(n, rowSampleRatio, rng);

    const tree = buildTree(rows, residuals, {
      task: 'regression',
      maxDepth,
      minLeaf,
      sampleLimit,
      indices: roundIndices,
      rng,
    });
    for (let i = 0; i < n; i += 1) {
      predictions[i] += learningRate * (followTree(tree, rows[i]).value / (1 + l2 * learningRate));
    }
    tallyFeatures(tree, featureUse);
    trees.push({ root: tree, learningRate, l2 });
  }

  return {
    kind: 'gbdt_regressor',
    baseScore,
    trees,
    rounds: trees.length,
    learningRate,
    l2,
    maxDepth,
    rowSampleRatio,
    // NPT cannot be negative, and a boosted model will happily predict a few.
    // Clamping is applied at prediction time, not here, so the raw model stays
    // inspectable.
    lowerBound: 0,
    upperBound: 168,
    featureImportance: [...featureUse.entries()]
      .map(([column, uses]) => ({ column, uses }))
      .sort((a, b) => b.uses - a.uses),
    n,
  };
}

export function predictGbdtRegressor(model, rows) {
  return rows.map((row) => {
    let value = model.baseScore;
    for (let t = 0; t < model.trees.length; t += 1) {
      value += model.trees[t].learningRate * followTree(model.trees[t].root, row).value;
    }
    // No operation can lose time, and a week is the longest credible single NPT
    // booking for one interval on one well.
    return Math.min(model.upperBound ?? Infinity, Math.max(model.lowerBound ?? -Infinity, value));
  });
}