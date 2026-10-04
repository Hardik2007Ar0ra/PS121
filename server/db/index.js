/**
 * Database bootstrap and the shared connection.
 *
 * A single SQLite handle is used for the whole process. better-sqlite3 is
 * synchronous, which is the right trade for an embedded analytical API: it
 * removes an entire class of concurrency bugs, and the queries here are
 * millisecond-scale index lookups rather than network round-trips.
 *
 * The Postgres + PostGIS + pgvector target described in docs/DATA_MODEL.md uses
 * the same repository API (server/repositories/*) with a different driver; this
 * module is the only place that knows which one is in use.
 */

import { migrate, migrationStatus, openDatabase } from './migrate.js';
import { isSeeded, seed } from '../seeds/seed.js';
import { createIdfSource } from '../search/embed.js';
import config from '../config.js';
import logger from '../util/logger.js';

let instance = null;

/**
 * Opens (or creates) the database, applies pending migrations and seeds the
 * synthetic corpus on first boot.
 */
export async function initDatabase(options = {}) {
  if (instance) return instance;

  const path = options.path ?? config.db.path;
  const db = openDatabase(path);

  const applied = await migrate(db);
  if (applied.length) logger.info({ path, applied }, 'schema ready');

  let seeded = false;
  if (config.db.autoSeed && !isSeeded(db)) {
    const summary = seed(db, {
      seed: config.db.seed,
      nWells: config.corpus.wells,
      nFields: config.corpus.fields,
      docsPerWell: config.corpus.docsPerWell,
    });
    seeded = true;
    instance = { db, idf: createIdfSource(db), path, summary, seeded };
    logger.info({ wells: summary.wells, events: summary.events }, 'seeded synthetic corpus');
  } else {
    instance = { db, idf: createIdfSource(db), path, summary: null, seeded };
  }

  instance.migrationStatus = () => migrationStatus(db);
  instance.close = () => {
    db.close();
    instance = null;
  };
  return instance;
}

export function getDb() {
  if (!instance) {
    throw new Error('database not initialised — call initDatabase() during boot');
  }
  return instance.db;
}

export function getIdf() {
  if (!instance) {
    throw new Error('database not initialised — call initDatabase() during boot');
  }
  return instance.idf;
}

export function getDatabaseInfo() {
  if (!instance) return null;
  const db = instance.db;
  const counts = {};
  [
    'fields',
    'wells',
    'formation_tops',
    'trajectory_surveys',
    'well_sections',
    'cementing_jobs',
    'mud_programs',
    'operational_events',
    'event_provenance',
    'lessons_learned',
    'documents',
    'document_pages',
    'document_chunks',
    'telemetry_samples',
    'feature_store',
    'risk_training_samples',
    'models',
    'alerts',
    'users',
    'knowledge_items',
  ].forEach((table) => {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } catch {
      counts[table] = null;
    }
  });

  return {
    path: instance.path,
    persistent: instance.path !== ':memory:',
    seeded: instance.seeded,
    counts,
    migrations: migrationStatus(db),
  };
}

/** For tests: opens an isolated in-memory database without touching the singleton. */
export async function createTestDatabase(options = {}) {
  const db = openDatabase(':memory:');
  await migrate(db, { log: false });
  return { db, idf: createIdfSource(db) };
}

export default { initDatabase, getDb, getIdf, getDatabaseInfo, createTestDatabase };