/**
 * CART decision trees, regression and classification.
 *
 * Deliberately small and readable: these trees are both the boosted model's weak
 * learners and the basis of the rule-based explanations shown to operators, so a
 * tree that cannot be read is not much use here.
 */

const MAX_GAIN_BITS = 0.25; // a sub-quarter-bit split is noise, not structure
const SPLIT_CUTS = 48; // candidate thresholds examined per feature

/** Gini impurity. Cheaper than entropy and equivalent at these sample sizes. */
function giniImpurity(counts, total) {
  if (!total) return 0;
  let impurity = 1;
  for (let i = 0; i < counts.length; i += 1) {
    const p = counts[i] / total;
    impurity -= p * p;
  }
  return impurity;
}

function entropy(counts, total) {
  if (!total) return 0;
  let sum = 0;
  for (let i = 0; i < counts.length; i += 1) {
    if (!counts[i]) continue;
    const p = counts[i] / total;
    sum -= p * Math.log2(p);
  }
  return sum;
}

function labelCountsFor(targets, indices, size) {
  const counts = new Int32Array(size);
  for (let i = 0; i < indices.length; i += 1) counts[targets[indices[i]]] += 1;
  return counts;
}

/**
 * Best split on a single feature, found by one sorted sweep.
 *
 * The obvious implementation — loop over candidate thresholds, and for each one
 * rescan every row in the node — is O(cuts × rows) per feature. With 46 features,
 * 48 cuts and a 4,000-row split sample that is ~9M comparisons per node, which
 * made a single boosting round take seconds.
 *
 * Sorting the node's rows on the feature once and then walking prefix sums
 * evaluates *every* threshold in a single O(rows) pass, so the cuts become free
 * and the whole search is O(features × rows log rows). Same thresholds, same
 * splits, roughly fifty times faster.
 */
function findBestSplit(rows, targets, indices, column, config) {
  const { minLeaf, sampleLimit, rng, task, labelCount } = config;

  // Large nodes are subsampled for split search. The gain from an optimal
  // threshold inside a 40k-row node is negligible beside the cost of finding it,
  // and the subsample is drawn from the seeded generator so the tree stays
  // reproducible.
  let search = indices;
  if (indices.length > sampleLimit) {
    const picks = new Array(sampleLimit);
    for (let i = 0; i < sampleLimit; i += 1) picks[i] = indices[Math.floor(rng() * indices.length)];
    search = picks;
  }
  const n = search.length;
  if (n < 2 * minLeaf) return null;

  // Pair each row's feature value with its target so one sort serves both.
  const values = new Float64Array(n);
  const ys = new Float64Array(n);
  let finite = 0;
  for (let i = 0; i < n; i += 1) {
    const value = rows[search[i]][column];
    if (!Number.isFinite(value)) {
      values[i] = Infinity; // sorts last; never counted as finite below
      ys[i] = targets[search[i]];
      continue;
    }
    values[i] = value;
    ys[i] = targets[search[i]];
    finite += 1;
  }
  if (finite < 2 * minLeaf) return null;

  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  // A typed-array sort with an index comparator: the comparison count dominates,
  // so a plain Array#sort here is measurably slower.
  const orderArray = Array.from(order);
  orderArray.sort((a, b) => values[a] - values[b]);

  // Candidate cut positions, spread evenly through the sorted rows. Evaluating a
  // subset of positions costs nothing now that the sweep is linear, and 48 cuts
  // resolve the shape of these relationships without needing the exact optimum.
  const cutStride = Math.max(1, Math.floor(finite / SPLIT_CUTS));
  const parentCounts = task === 'regression' ? null : countLabelsInPlace(orderArray, ys, labelCount, 0, finite);

  let best = null;

  if (task === 'regression') {
    // Prefix sums over the sorted order give every threshold's gain in O(1).
    const prefixSum = new Float64Array(finite + 1);
    const prefixSq = new Float64Array(finite + 1);
    for (let i = 0; i < finite; i += 1) {
      const y = ys[orderArray[i]];
      prefixSum[i + 1] = prefixSum[i] + y;
      prefixSq[i + 1] = prefixSq[i] + y * y;
    }
    const totalSum = prefixSum[finite];
    const totalSq = prefixSq[finite];

    for (let k = cutStride; k <= finite - minLeaf; k += cutStride) {
      const leftCount = k;
      const rightCount = finite - k;
      if (leftCount < minLeaf || rightCount < minLeaf) continue;
      const leftSum = prefixSum[k];
      const leftSq = prefixSq[k];
      const rightSum = totalSum - leftSum;
      const rightSq = totalSq - leftSq;
      // The parent's sum-of-squares term is constant across splits, so the
      // comparison uses the two child terms alone.
      const gain = leftSq - (leftSum * leftSum) / leftCount + rightSq - (rightSum * rightSum) / rightCount;
      if (!best || gain > best.gain) {
        const threshold = values[orderArray[k - 1]];
        best = { column, threshold, gain };
      }
    }
  } else {
    // Flat prefix-count table: one allocation of (finite+1) × labelCount rather
    // than `finite` separate arrays, which dominated allocation cost otherwise.
    const prefix = new Int32Array((finite + 1) * labelCount);
    for (let i = 0; i < finite; i += 1) {
      const label = ys[orderArray[i]];
      for (let c = 0; c < labelCount; c += 1) {
        prefix[(i + 1) * labelCount + c] = prefix[i * labelCount + c] + (c === label ? 1 : 0);
      }
    }

    const parentEntropy = entropy(parentCounts, finite);
    const leftCounts = new Int32Array(labelCount);
    const rightCounts = new Int32Array(labelCount);

    for (let k = cutStride; k <= finite - minLeaf; k += cutStride) {
      const leftTotal = k;
      const rightTotal = finite - k;
      if (leftTotal < minLeaf || rightTotal < minLeaf) continue;
      for (let c = 0; c < labelCount; c += 1) {
        leftCounts[c] = prefix[k * labelCount + c];
        rightCounts[c] = parentCounts[c] - leftCounts[c];
      }

      const weighted =
        (leftTotal / finite) * entropy(leftCounts, leftTotal) +
        (rightTotal / finite) * entropy(rightCounts, rightTotal);
      const gain = parentEntropy - weighted;
      if (gain < MAX_GAIN_BITS) continue;
      if (!best || gain > best.gain) {
        const threshold = values[orderArray[k - 1]];
        best = { column, threshold, gain };
      }
    }
  }

  return best;
}

function countLabelsInPlace(order, ys, labelCount, from, to) {
  const counts = new Int32Array(labelCount);
  for (let i = from; i < to; i += 1) counts[ys[order[i]]] += 1;
  return counts;
}

/**
 * @param {Array<Array<number>>} rows
 * @param {Array<number>} targets
 * @param {object} options
 * @param {'regression'|'classification'} [options.task]
 * @param {number} [options.maxDepth] Shallow on purpose. Boosted trees are meant to
 *   be weak learners; a deep tree here would both overfit and produce explanations
 *   nobody can read.
 * @param {number} [options.minLeaf]
 * @param {number[]} [options.indices] Rows to build the tree from. Defaults to all
 *   of them; stochastic boosting passes a random subset per round.
 * @param {() => number} [options.rng] Zero-argument uniform generator.
 */
export function buildTree(rows, targets, options = {}) {
  const {
    task = 'regression',
    maxDepth = 3,
    minLeaf = 60,
    sampleLimit = 4000,
    indices = null,
    rng = Math.random,
  } = options;

  const labelCount = task === 'classification' ? targets.reduce((m, t) => Math.max(m, t), 0) + 1 : 0;
  const config = { minLeaf, sampleLimit, rng, task, labelCount };
  const columnCount = rows[0]?.length ?? 0;
  const allIndices = indices ?? rows.map((_, i) => i);

  /** Mean target (regression) or positive-class share (classification). */
  const leafValue = (indices) => {
    if (task === 'classification') {
      let positives = 0;
      for (let i = 0; i < indices.length; i += 1) if (targets[indices[i]] === 1) positives += 1;
      return positives / indices.length;
    }
    let sum = 0;
    for (let i = 0; i < indices.length; i += 1) sum += targets[indices[i]];
    return sum / indices.length;
  };

  function grow(indices, depth) {
    const node = { depth, n: indices.length, value: round(leafValue(indices), 8) };

    if (depth >= maxDepth || indices.length < 2 * minLeaf) return node;
    if (task === 'classification') {
      const counts = labelCountsFor(targets, indices, labelCount);
      if (giniImpurity(counts, indices.length) < 1e-9) return node;
    }

    // Features are considered in a seeded random order and a subset is tried.
    // Boosted trees only need weak learners, so spending the full feature set at
    // every node buys almost no accuracy and costs real time.
    const order = [...Array(columnCount).keys()].sort(() => rng() - 0.5);
    const candidateColumns =
      columnCount <= 8 ? order : order.slice(0, Math.max(4, Math.floor(columnCount * 0.6)));

    let best = null;
    for (const column of candidateColumns) {
      const split = findBestSplit(rows, targets, indices, column, config);
      if (split && (!best || split.gain > best.gain)) best = split;
    }
    if (!best) return node;

    const left = [];
    const right = [];
    for (let i = 0; i < indices.length; i += 1) {
      const index = indices[i];
      const value = rows[index][best.column];
      // Missing values follow the right branch, which is where the
      // low-information tail of each feature naturally sits.
      if (Number.isFinite(value) && value <= best.threshold) left.push(index);
      else right.push(index);
    }
    if (left.length < minLeaf || right.length < minLeaf) return node;

    node.column = best.column;
    node.threshold = round(best.threshold, 6);
    node.left = grow(left, depth + 1);
    node.right = grow(right, depth + 1);
    return node;
  }

  return grow(allIndices, 0);
}

export function predictTree(node, row) {
  let current = node;
  while (current.column !== undefined) {
    const value = row[current.column];
    current = Number.isFinite(value) && value <= current.threshold ? current.left : current.right;
  }
  return current.value;
}

/** Flattens a tree into readable `feature <= threshold` rules, largest leaf first. */
export function treeRules(node, featureNames, maxRules = 12) {
  const rules = [];
  (function walk(current, path) {
    if (current.column === undefined) {
      rules.push({
        condition: path.length ? path.join(' AND ') : '(all rows)',
        prediction: round(current.value, 4),
        samples: current.n,
      });
      return;
    }
    const name = featureNames[current.column] ?? `feature_${current.column}`;
    walk(current.left, [...path, `${name} <= ${current.threshold}`]);
    walk(current.right, [...path, `${name} > ${current.threshold}`]);
  })(node, []);
  return rules.sort((a, b) => b.samples - a.samples).slice(0, maxRules);
}

/** Features the tree actually splits on, most-used first — the feature importance proxy. */
export function splitUsage(node, tally = new Map()) {
  if (node.column === undefined) return tally;
  tally.set(node.column, (tally.get(node.column) || 0) + 1);
  splitUsage(node.left, tally);
  splitUsage(node.right, tally);
  return tally;
}

export function countNodes(node) {
  if (node.column === undefined) return 1;
  return 1 + countNodes(node.left) + countNodes(node.right);
}

export function treeDepth(node) {
  if (node.column === undefined) return 0;
  return 1 + Math.max(treeDepth(node.left), treeDepth(node.right));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}