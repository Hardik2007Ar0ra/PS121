/**
 * Trains every risk model and writes the artifacts plus model cards.
 *
 *   npm run ml:train            train against the configured database
 *   npm run ml:train -- --folds 5
 *
 * Prints the held-out numbers, not the in-sample ones. The in-sample figures are
 * recorded in the model card under `in-sample` where they are available for
 * comparison, but the headline is always the cross-validated result on wells the
 * model has not seen.
 */

import path from 'node:path';
import { getDb, initDatabase } from '../server/db/index.js';
import { loadTrainingSet, trainAll } from '../server/ml/train.js';
import { modelHistory } from '../server/ml/registry.js';
import config from '../server/config.js';
import logger from '../server/util/logger.js';

const log = logger.child({ script: 'ml:train' });

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? (Number.isNaN(Number(value)) ? value : Number(value)) : true;
}

const options = {
  folds: arg('folds', 4),
  rounds: arg('rounds', 60),
  limit: arg('limit', null),
  seed: arg('seed', 20260101),
  // Artifacts go to disk, not only to the registry table. With the default
  // in-memory database the registry vanishes when the process exits, which would
  // make training produce nothing durable; the files under ml/artifacts are the
  // versioned, git-committed deliverable.
  artifactsDir: arg('artifacts', path.resolve(config.ml.artifactsDir)),
};

await initDatabase();
const db = getDb();

const started = Date.now();
log.info(options, 'training started');

const { results, trainedAt } = trainAll(db, options);

console.log('\nHeld-out performance, cross-validated by well\n');
console.log(
  '  risk            algorithm                 rows   pos%   wells   metric                          held-out        operating point',
);
console.log('  ' + '-'.repeat(148));

for (const result of results) {
  if (result.skipped) {
    console.log(`  ${result.riskType.padEnd(15)} SKIPPED — ${result.skipped}`);
    continue;
  }

  if (result.algorithm === 'isolation_forest') {
    const enrichment = result.enrichment;
    console.log(
      `  ${result.riskType.padEnd(15)} ${result.algorithm.padEnd(25)} ` +
        `${String(result.trainingRows ?? '').padStart(6)} rows` +
        `${String(result.wells ?? '').padStart(6)} wells   ` +
        `threshold ${result.threshold} (${result.thresholdBasis})` +
        `   top 1% intervals contain ${enrichment ? `${enrichment.intervalsContainingAnEvent}/${enrichment.totalLoggedEvents}` : 'n/a'} events` +
        `   separation AUC ${result.separationAuc}`,
    );
    continue;
  }

  const isRegressor = result.riskType === 'NPT';
  const metric = isRegressor
    ? `RMSE ${String(result.rmse).padEnd(6)} (base ${String(result.baselineRmse).padEnd(6)}) R2 ${result.r2}`
    : `ROC AUC ${String(result.rocAuc).padEnd(6)} AP ${String(result.averagePrecision ?? '').padEnd(6)}`;

  const interval = result.aucInterval ? ` [${result.aucInterval.lower}-${result.aucInterval.upper}]` : '';
  const operating = isRegressor
    ? `beats baseline: ${result.beatsBaseline ? 'yes' : 'NO'}`
    : `thr ${round4(result.threshold)} -> ${(result.precision * 100).toFixed(0)}% precision, ${(result.recall * 100).toFixed(0)}% recall${result.beatBaseline ? '' : ' (LOSES to flag-everything)'}`;

  console.log(
    `  ${result.riskType.padEnd(15)} ${result.algorithm.padEnd(25)} ` +
      `${String(result.trainingRows ?? '').padStart(6)}` +
      `${String(result.positiveRate ?? '').padStart(6)}` +
      `${String(result.wells ?? '').padStart(6)}   ` +
      `${metric}${interval}   ${operating}`,
  );

  // A model that trained but failed the deployment gate is the most important
  // line in the table, so it is called out rather than left for the reader to
  // infer from a zero precision.
  if (result.activated === false) {
    console.log(`  ${''.padEnd(15)} NOT ACTIVATED: ${result.activationBlockedBy.join('; ')}`);
  }

  if (result.runnerUp) {
    const label = 'runner-up';
    console.log(
      `  ${' '.repeat(15)} ${label.padEnd(25)} ${result.runnerUp.algorithm} ROC AUC ${result.runnerUp.rocAuc}`,
    );
  }
}

console.log(`\n  trained at ${trainedAt}`);
console.log(`  total ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

// Confirm what actually landed in the registry, so the printed table above is
// verified against the database rather than trusted.
const active = db.prepare('SELECT name, version, risk_type, algorithm, training_rows FROM models WHERE is_active = 1 ORDER BY risk_type').all();
console.log(`  ${active.length} active model(s) registered:`);
active.forEach((row) => {
  const history = modelHistory(db, row.name);
  console.log(
    `    ${row.risk_type.padEnd(16)} ${row.algorithm.padEnd(24)} ${row.name}@${row.version} ` +
      `(${row.training_rows} rows, ${history.length} version${history.length === 1 ? '' : 's'} on record)`,
  );
});

// A registry with no active model for a risk is a deployment problem, not a
// training problem, so it is named explicitly rather than left to be discovered
// when a user asks for a risk score.
const expected = ['MUD_LOSS', 'KICK', 'STUCK_PIPE', 'TORQUE_SPIKE', 'NPT', 'FORMATION_RISK'];
const missing = expected.filter((risk) => !active.some((row) => row.risk_type === risk));
if (missing.length) {
  console.log(`\n  no active model for: ${missing.join(', ')}`);
  const blocked = results.filter((r) => r.activationBlockedBy);
  blocked.forEach((r) => console.log(`    ${r.riskType}: ${r.activationBlockedBy.join('; ')}`));
  log.warn({ missing }, 'some risk types have no trained model');
}

function round4(value) {
  return typeof value === 'number' ? value.toFixed(4) : value;
}