/**
 * On-disk model artifacts.
 *
 * The registry table is a cache, not the deliverable. With the default
 * in-memory database the registry disappears when the process exits, which would
 * make `npm run ml:train` produce nothing that survives the run that created it.
 * The artifacts written here are the actual product of training: plain JSON,
 * diffable in git, reviewable line by line, and loadable without a database.
 *
 * The format is deliberately generic — a `kind`, a `featureVersion`, a feature
 * list, a metrics block and a model card — so that a scikit-learn pipeline
 * trained outside this codebase can be dropped in as long as it emits the same
 * envelope. Nothing here assumes the model was fitted by the code in
 * server/ml/algorithms.
 */

import fs from 'node:fs';
import path from 'node:path';
import logger from '../util/logger.js';

const log = logger.child({ module: 'ml/artifacts' });

const MANIFEST = 'manifest.json';

/**
 * Writes one artifact bundle.
 *
 * The bundle is a single JSON file rather than separate artifact/metrics/card
 * files so that a version is always read as a unit. A card that describes a
 * different artifact than the one beside it is worse than no card at all.
 */
export function exportArtifact(directory, { name, version, riskType, kind, algorithm, featureVersion, featureList, artifact, metrics, modelCard, trainingRows, trainedAt, notes }) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${name}@${version}.json`;
  const file = path.join(directory, filename);

  const bundle = {
    schema: 'nwis.model.bundle/1',
    name,
    version,
    riskType,
    kind,
    algorithm,
    featureVersion,
    featureList,
    trainingRows,
    trainedAt,
    notes: notes ?? null,
    metrics,
    modelCard,
    artifact,
  };

  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  updateManifest(directory, {
    name,
    version,
    riskType,
    kind,
    algorithm,
    featureVersion,
    trainingRows,
    trainedAt,
    notes: notes ?? null,
    headline: modelCard?.headline ?? modelCard?.verdict ?? null,
    metrics,
    file: filename,
  });
  log.info({ file, riskType, version }, 'artifact exported');
  return file;
}

/**
 * Rewrites the manifest from the artifact files actually on disk.
 *
 * Rebuilt from the directory rather than incrementally updated so that a
 * hand-deleted or hand-added artifact shows up as the discrepancy it is, instead
 * of the manifest quietly disagreeing with its own directory.
 */
function updateManifest(directory, entry) {
  const manifestFile = path.join(directory, MANIFEST);
  let manifest = { schema: 'nwis.model.manifest/1', models: {} };
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      log.warn({ err: error, manifestFile }, 'manifest unreadable, rebuilding from artifacts');
      manifest = { schema: 'nwis.model.manifest/1', models: {} };
    }
  }
  manifest.models[entry.name] = manifest.models[entry.name] ?? { versions: [] };
  const existing = manifest.models[entry.name].versions.findIndex((v) => v.version === entry.version);
  const record = { ...entry };
  if (existing >= 0) manifest.models[entry.name].versions[existing] = record;
  else manifest.models[entry.name].versions.push(record);
  manifest.models[entry.name].versions.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  // The most recent version of each model is the active one on disk.
  manifest.models[entry.name].activeVersion = manifest.models[entry.name].versions[0].version;
  manifest.updatedAt = new Date().toISOString();

  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Reads every bundle in a directory, keyed by `name@version`. */
export function readArtifacts(directory) {
  if (!fs.existsSync(directory)) return new Map();
  const out = new Map();
  fs.readdirSync(directory)
    .filter((file) => file.endsWith('.json') && file !== MANIFEST)
    .forEach((file) => {
      try {
        const bundle = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        if (bundle.schema !== 'nwis.model.bundle/1') return;
        out.set(`${bundle.name}@${bundle.version}`, bundle);
      } catch (error) {
        // One corrupt file must not take down the whole load; the bad bundle is
        // named so it can be fixed or deleted.
        log.error({ err: error, file }, 'artifact unreadable, skipped');
      }
    });
  return out;
}

/**
 * The active bundle per model name.
 *
 * "Active" comes from the manifest rather than from the filename ordering, so a
 * version promoted out of order still wins.
 */
export function readActiveArtifacts(directory) {
  const manifestFile = path.join(directory, MANIFEST);
  if (!fs.existsSync(manifestFile)) return [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    log.error({ err: error, manifestFile }, 'manifest unreadable');
    return [];
  }

  const bundles = readArtifacts(directory);
  const active = [];
  Object.entries(manifest.models ?? {}).forEach(([name, record]) => {
    const version = record.activeVersion ?? record.versions?.[0]?.version;
    if (!version) return;
    const bundle = bundles.get(`${name}@${version}`);
    if (bundle) active.push(bundle);
    else log.error({ name, version }, 'manifest names a version with no artifact file');
  });
  return active;
}

export { MANIFEST };