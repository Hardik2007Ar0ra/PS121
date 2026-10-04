/**
 * Grouped k-fold cross-validation.
 *
 * The only kind used in this project, and the reason the training tables carry a
 * `split_group` column. Splitting rows at random would put metres 2,000 and 2,005
 * of the same well on opposite sides of the split. Those rows are near-identical:
 * the rolling ratios in the feature set are computed from their own neighbourhood,
 * and the rock is the same. A model validated that way scores well by memorising
 * well-specific behaviour and reports a number that will not survive contact with
 * the next well.
 *
 * Grouping by well means every reported metric is measured on wells the model has
 * never seen, which is the only question that matters operationally.
 */

import { shuffle } from './linalg.js';

/**
 * Assigns folds to groups.
 *
 * Groups are shuffled before assignment so fold composition is not determined by
 * well name — otherwise wells NA-01..NA-16 would all land in fold 0 and the
 * cross-validation would silently test on one field while training on the others.
 * Balancing by group size keeps folds comparable, which matters when a few wells
 * have three times the telemetry of others.
 */
export function assignFolds(groups, { folds = 5, rng = Math.random } = {}) {
  const byGroup = new Map();
  groups.forEach((group, index) => {
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(index);
  });

  const keys = shuffle([...byGroup.keys()], rng);
  const foldOf = new Array(groups.length).fill(0);
  const sizes = new Array(folds).fill(0);

  // Largest group first: placing the big wells into the emptiest fold is what
  // keeps the fold sizes even.
  keys
    .map((key) => ({ key, size: byGroup.get(key).length }))
    .sort((a, b) => b.size - a.size)
    .forEach(({ key, size }) => {
      let target = 0;
      for (let f = 1; f < folds; f += 1) if (sizes[f] < sizes[target]) target = f;
      sizes[target] += size;
      byGroup.get(key).forEach((index) => {
        foldOf[index] = target;
      });
    });

  return { foldOf, sizes };
}

/**
 * Splits rows into `folds` train/test partitions that share no group.
 *
 * @param {number} count number of rows
 * @param {Array<string>} groups one group label per row
 * @param {object} options
 * @param {number} [options.folds]
 * @param {() => number} [options.rng]
 */
export function groupKFold(count, groups, options = {}) {
  const { folds = 5, rng = Math.random } = options;
  if (count !== groups.length) throw new Error('groupKFold: groups length must match row count');

  const { foldOf, sizes } = assignFolds(groups, { folds, rng });
  const out = [];
  for (let f = 0; f < folds; f += 1) {
    const train = [];
    const test = [];
    for (let i = 0; i < count; i += 1) {
      if (foldOf[i] === f) test.push(i);
      else train.push(i);
    }
    // A fold with no held-out rows cannot contribute a metric, and a training set
    // with no rows cannot produce a model. Both are reported rather than skipped
    // silently.
    if (!test.length || !train.length) continue;
    out.push({ fold: f, train, test, trainSize: train.length, testSize: test.length });
  }

  return { splits: out, sizes, total: count };
}

/**
 * A single held-out split, for the final model fit once the cross-validation has
 * chosen the configuration.
 *
 * The held-out fraction is applied to *groups*, not rows. Reserving rows would put
 * the tail of some wells into validation, which is the leakage this module exists
 * to prevent.
 */
export function holdoutSplit(count, groups, { fraction = 0.25, rng = Math.random } = {}) {
  const unique = [...new Set(groups)];
  const shuffled = shuffle(unique, rng);
  const holdoutCount = Math.max(1, Math.round(shuffled.length * fraction));
  const holdoutGroups = new Set(shuffled.slice(0, holdoutCount));

  const train = [];
  const test = [];
  for (let i = 0; i < count; i += 1) {
    if (holdoutGroups.has(groups[i])) test.push(i);
    else train.push(i);
  }
  return {
    train,
    test,
    holdoutGroups: [...holdoutGroups],
    trainSize: train.length,
    testSize: test.length,
  };
}