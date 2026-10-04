import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import logger from '../util/logger.js';

// Migrations live in server/db/migrations/, one file per version.
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      duration_ms INTEGER
    );
  `);
}

/** Migrations are applied in filename order; each is applied at most once. */
export function pendingMigrations(db) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((row) => row.name),
  );
  const files = fs
    .readdirSync(here)
    .filter((file) => /^\d{3}_.*\.js$/.test(file))
    .sort();

  const pending = [];
  for (const file of files) {
    const name = file.replace(/\.js$/, '');
    if (applied.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    pending.push({ name, path: path.join(here, file) });
  }
  return pending;
}

/**
 * Applies every pending migration inside a transaction per migration so a
 * failure leaves the schema at the last good version rather than half-applied.
 */
export async function migrate(db, { log = true } = {}) {
  const queue = pendingMigrations(db);
  if (!queue.length) {
    if (log) logger.debug('migrations: schema already up to date');
    return [];
  }

  const applied = [];
  for (const migration of queue) {
    const module = await import(`file://${migration.path.replace(/\\/g, '/')}`);
    const started = Date.now();
    const run = db.transaction(() => {
      module.default.up(db);
      db.prepare(
        'INSERT INTO _migrations (name, applied_at, duration_ms) VALUES (?, ?, ?)',
      ).run(migration.name, new Date().toISOString(), Date.now() - started);
    });
    run();
    applied.push(migration.name);
    if (log) logger.info({ migration: migration.name, ms: Date.now() - started }, 'migration applied');
  }
  return applied;
}

export function migrationStatus(db) {
  ensureMigrationsTable(db);
  const applied = new Map(
    db.prepare('SELECT name, applied_at, duration_ms FROM _migrations').all().map((row) => [row.name, row]),
  );
  return fs
    .readdirSync(here)
    .filter((file) => /^\d{3}_.*\.js$/.test(file))
    .sort()
    .map((file) => {
      const name = file.replace(/\.js$/, '');
      return { name, applied: applied.has(name), appliedAt: applied.get(name)?.applied_at || null };
    });
}

export function openDatabase(path, { verbose = false } = {}) {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  if (verbose) db.pragma('verbose = DBG_PREPARE');

  registerFunctions(db);
  return db;
}

/**
 * SQLite has no spatial type, so geospatial work is done with real SQL through
 * user-defined functions rather than by filtering in JavaScript. This is what
 * lets `WHERE haversine_km(...) <= :radius` be an actual indexed-ish query.
 *
 * The Postgres target uses ST_DWithin + a GiST index instead; see
 * docs/DATA_MODEL.md. Both return identical results because the maths is the
 * same haversine formula.
 */
function registerFunctions(db) {
  const R = 6371.0088; // mean Earth radius, km

  db.function('haversine_km', { deterministic: true }, (lat1, lng1, lat2, lng2) => {
    if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  });

  // Great-circle initial bearing, used to orient the A-A' section view.
  db.function('bearing_deg', { deterministic: true }, (lat1, lng1, lat2, lng2) => {
    if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
    const toRad = Math.PI / 180;
    const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
    const x =
      Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
      Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  });

  // Offset of a station perpendicular to a section line, for the section view.
  db.function('cross_track_km', { deterministic: true }, (lat, lng, lat1, lng1, bearing) => {
    if ([lat, lng, lat1, lng1, bearing].some((v) => v === null || v === undefined)) return null;
    const toRad = Math.PI / 180;
    const dLng = (lng - lng1) * toRad;
    const dLat = (lat - lat1) * toRad;
    const brng = bearing * toRad;
    const numerator = Math.sin(dLng) * Math.cos(lat * toRad);
    const denominator =
      Math.cos(lat1 * toRad) * Math.sin(lat * toRad) -
      Math.sin(lat1 * toRad) * Math.cos(lat * toRad) * Math.cos(dLng);
    return (Math.asin(numerator / Math.sqrt(numerator ** 2 + denominator ** 2)) * 180) / Math.PI / toRad * 111.195;
  });
}

export { here as migrationsDir };