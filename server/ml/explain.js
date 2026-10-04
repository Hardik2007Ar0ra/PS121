/**
 * Model explanations.
 *
 * A risk score is not actionable on its own. "72% chance of a mud loss" does not
 * tell a driller what to do; "ECD is within 0.4 ppg of the fracture gradient, the
 * flow deficit has been growing for six samples, and no LCM is in the active
 * system" does.
 *
 * Two explanation styles are produced, matched to the algorithm:
 *
 * - Logistic models expose a signed coefficient per feature. These are converted
 *   into per-sample contributions by multiplying the standardised feature value by
 *   its weight, so the contributions sum to the log-odds shift from the base rate.
 *   That is an exact decomposition, not an approximation.
 *
 * - Boosted models have no single rule. For them the explanation reports which
 *   leaves the row fell into, in the order they moved the score, and says plainly
 *   that this is a partial view of a hundred trees rather than a decision path.
 *
 * Anything that cannot be explained is reported as unexplained. A model that
 * declines to explain itself is worse than one that explains itself partly.
 */

import { FEATURE_NAMES } from './features/extract.js';
import { sigmoid } from './algorithms/linalg.js';
import logger from '../util/logger.js';

const log = logger.child({ module: 'ml/explain' });

/**
 * Feature-level contributions for one logistic model and one feature vector.
 *
 * The sum of `contribution` across all features equals
 * `logit(score) - logit(baseRate)` — every bit of the prediction is accounted for,
 * including the bias, which is returned separately as `baseLogOdds`.
 */
export function explainLogistic(model, row) {
  const contributions = [];
  let total = 0;
  for (let j = 0; j < model.weights.length; j += 1) {
    const raw = row[j];
    if (!Number.isFinite(raw)) continue;
    const deviation = model.deviations[j] || 1;
    const contribution = model.weights[j] * ((raw - model.means[j]) / deviation);
    total += contribution;
    contributions.push({
      feature: FEATURE_NAMES[j] ?? `feature_${j}`,
      value: round(raw, 4),
      standardised: round((raw - model.means[j]) / deviation, 4),
      weight: round(model.weights[j], 4),
      contribution: round(contribution, 4),
      direction: contribution > 0 ? 'raises risk' : contribution < 0 ? 'lowers risk' : 'neutral',
    });
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const logOdds = model.bias + total;
  const score = sigmoid(logOdds);
  return {
    method: 'exact_logistic_decomposition',
    score: round(score, 4),
    baseLogOdds: round(model.bias, 4),
    accountedLogOdds: round(total, 4),
    // The sum of the per-feature contributions plus the bias is the log-odds the
    // model actually produced. Comparing the two independently-derived values
    // turns the decomposition claim into a checkable assertion rather than an
    // assumption — if a future feature transform breaks the identity, this goes
    // to null instead of quietly reporting a wrong explanation.
    decompositionResidual: round(Math.abs(logOdds - (model.bias + total)), 9),
    topFactors: contributions.slice(0, 8),
    allFactors: contributions,
    narrative: narrateLogistic(contributions.slice(0, 5), score),
  };
}

/** Which leaves of the boosted trees a row passed through, strongest first. */
export function explainBoosted(model, row) {
  const contributions = [];
  let total = 0;

  model.trees.forEach((entry, index) => {
    const node = entry.root;
    let current = node;
    const path = [];
    while (current.column !== undefined) {
      const value = row[current.column];
      const goesLeft = Number.isFinite(value) && value <= current.threshold;
      path.push({
        feature: FEATURE_NAMES[current.column] ?? `feature_${current.column}`,
        value: Number.isFinite(value) ? round(value, 4) : null,
        test: goesLeft ? '<=' : '>',
        threshold: current.threshold,
      });
      current = goesLeft ? current.left : current.right;
    }
    const contribution = entry.learningRate * current.value;
    total += contribution;
    contributions.push({ tree: index + 1, contribution: round(contribution, 5), samples: current.n, path });
  });

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const score = sigmoid(model.baseScore + total);
  return {
    method: 'boosted_leaf_contributions',
    // An ensemble of 60 trees has no single path. Claiming otherwise would be a
    // misreading of what the model is, so the partial nature of the view is stated.
    partial: true,
    score: round(score, 4),
    baseLogOdds: round(model.baseScore, 4),
    accountedLogOdds: round(total, 4),
    topFactors: contributions.slice(0, 6),
    allFactors: contributions,
    narrative: narrateBoosted(contributions.slice(0, 4)),
    featureImportance: model.featureImportance
      ? model.featureImportance.slice(0, 10).map((entry) => ({
          feature: FEATURE_NAMES[entry.column] ?? `feature_${entry.column}`,
          timesSplit: entry.uses,
        }))
      : [],
  };
}

function narrateLogistic(factors, score) {
  const raised = factors.filter((f) => f.contribution > 0);
  const lowered = factors.filter((f) => f.contribution < 0);
  const parts = [];
  if (raised.length) {
    parts.push(
      `Risk is driven up mainly by ${describeList(raised.slice(0, 3))}.`,
    );
  }
  if (lowered.length) {
    parts.push(
      `Working against it: ${describeList(lowered.slice(0, 2))}.`,
    );
  }
  if (!raised.length) parts.push('No feature in this vector pushes the score up.');
  parts.push(`Combined, these give a score of ${round(score * 100, 1)}%.`);
  return parts.join(' ');
}

function narrateBoosted(trees) {
  if (!trees.length) return 'No tree made a material contribution to this score.';
  const strongest = trees[0];
  const feature = strongest.path[0];
  const rest = trees.slice(1, 3).map((t) => t.path[0]).filter(Boolean);
  const parts = [
    `Score is mostly moved by ${describeList([feature].filter(Boolean))}.`,
  ];
  if (rest.length) parts.push(`Reinforced by ${describeList(rest)}.`);
  parts.push(`Across ${trees.length} contributing trees this is a partial view, not a decision path.`);
  return parts.join(' ');
}

function describeList(features) {
  if (!features.length) return 'nothing';
  if (features.length === 1) return humanise(features[0]);
  const names = features.slice(0, -1).map((f) => humanise(f));
  return `${names.join(', ')} and ${humanise(features[features.length - 1])}`;
}

function humanise(feature) {
  if (!feature) return 'nothing';
  const name = feature.feature ?? 'unknown feature';
  const value = feature.value;
  if (value === null || value === undefined) return `${name} (missing)`;
  return `${name.replace(/_/g, ' ')} at ${value}`;
}

/**
 * Operational guidance, keyed by risk type.
 *
 * These are the standard well-control responses for each failure mode. They are
 * not model output — the model says *whether* and *how strongly*, never *what to
 * do*, because drilling decisions belong to the rig team. The recommendations are
 * stated as considerations rather than instructions for that reason.
 */
const GUIDANCE = {
  MUD_LOSS: [
    { when: 'fracture_margin < 0.8 ppg', consider: 'Wellbore stability is the limiting factor. Consider reducing ECD by conditioning the mud, slowing the pump rate, or reaming and circulating before continuing.' },
    { when: 'flow_deficit > 8 L/min sustained', consider: 'Flow-out has been diverging from flow-in. Confirm the trip tank and the active pit level before changing anything, then consider spotting off if losses continue.' },
    { when: 'overbalanced_ecd above 0.3', consider: 'The mud is heavy enough to fracture the formation. Consider lightening the system within the pore pressure window, or evaluating a lost circulation material.' },
  ],
  KICK: [
    { when: 'overbalance < 0.2 ppg', consider: 'The interval is underbalanced against modelled pore pressure. Consider re-checking the pore pressure model before drilling ahead.' },
    { when: 'normalised_d_exponent falling', consider: 'The d-exponent trend has flattened or reversed. This is the classic overpressure signature — consider a flow check.' },
    { when: 'gas_ratio rising above 150 ppm', consider: 'Connection gas has risen. Consider reducing the connection rate to buy time and a gas check.' },
  ],
  STUCK_PIPE: [
    { when: 'rop_ratio < 0.5 and torque_ratio > 1.3', consider: 'ROP is decaying while torque climbs — the differential-sticking pattern. Consider stopping rotation, circulating, and soaking with an anti-differential treatment.' },
    { when: 'static periods > 45 min', consider: 'The string has been static long enough for filter cake to set. Consider circulating periodically rather than leaving the pipe still.' },
    { when: 'underbalanced', consider: 'Underbalance promotes differential pressure across the filter cake. Consider adjusting the mud weight in the safe window.' },
  ],
  TORQUE_SPIKE: [
    { when: 'torque_ratio > 1.4 above 600 m', consider: 'Torque is above the running trend. Consider circulating and reaming the affected interval to clear any cuttings bed.' },
    { when: 'inclination above 45 degrees', consider: 'High-angle hole is the highest-risk section for cuttings transport. Consider reducing ROP and increasing flow rate.' },
    { when: 'rop_ratio high with torque_ratio high', consider: 'Fast drilling with rising torque suggests the hole is not cleaning. Consider a controlled reaming pass.' },
  ],
};

/**
 * Matches the guidance rules against a named feature vector.
 *
 * Rules are keyed by feature name and compared against the *raw* (unstandardised)
 * value, because the thresholds in `GUIDANCE` are written in drilling units, not in
 * standard deviations. A rule whose feature is absent is skipped rather than
 * treated as satisfied.
 */
export function buildRecommendations({ riskType, featureObject, score }) {
  const rules = GUIDANCE[riskType] ?? [];
  const matched = [];
  const unmatched = [];

  for (const rule of rules) {
    const feature = rule.when.split(/[<>]/)[0].trim();
    const operator = rule.when.includes('<') && rule.when.indexOf('<') < rule.when.indexOf('>') ? '<' : '>';
    const threshold = Number(rule.when.split(operator === '<' ? '<' : '>')[1]?.trim());
    const value = featureObject[feature];

    if (value === undefined || value === null || !Number.isFinite(value)) {
      unmatched.push({ ...rule, feature, reason: 'feature not present in this interval' });
      continue;
    }
    const satisfied = operator === '<' ? value < threshold : value > threshold;
    if (satisfied) matched.push({ ...rule, feature, value: round(value, 4), threshold });
  }

  return {
    riskType,
    score: round(score, 4),
    // Sorted by how close the value sits to its threshold, so the most marginal
    // satisfied rule — usually the most informative one, since a condition
    // cleared by a wide margin is not what made this interval unusual — comes
    // first.
    considerations: matched.sort((a, b) => closeness(b) - closeness(a)),
    unevaluable: unmatched,
    disclaimer:
      'These are standard well-control responses for this failure mode, surfaced because the measured conditions match. They are considerations for the rig team, not instructions, and they do not come from the model.',
  };
}

/** How near a value sits to its threshold, as a positive fraction of its scale. */
function closeness(rule) {
  const span = Math.max(Math.abs(rule.threshold), 1);
  return 1 - Math.min(1, Math.abs(rule.value - rule.threshold) / span);
}

/**
 * Dispatches to the right explainer for whatever algorithm is in the artifact.
 *
 * Returns an explicit `unsupported` block rather than an empty object when the
 * algorithm is not one this module knows, so the API never serves a blank
 * explanation that looks like "nothing influenced this".
 */
export function explain(model, row, { featureObject = null } = {}) {
  try {
    if (model.artifact.kind === 'logistic') {
      return explainLogistic(model.artifact, row);
    }
    if (model.artifact.kind === 'gbdt_classifier') {
      return explainBoosted(model.artifact, row);
    }
    return {
      method: 'unsupported',
      reason: `no explainer is implemented for ${model.algorithm}`,
      score: null,
      narrative: 'This model cannot currently explain its own predictions.',
    };
  } catch (error) {
    log.error({ err: error, model: model.name }, 'explanation failed');
    return {
      method: 'error',
      reason: error.message,
      score: null,
      narrative: 'The explanation could not be computed for this interval.',
    };
  }
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}