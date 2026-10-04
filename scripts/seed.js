/**
 * Bootstraps the database and prints a summary. Useful on its own for verifying
 * the corpus generator without starting the HTTP server:
 *
 *   npm run db:seed
 */

import { initDatabase, getDatabaseInfo } from '../server/db/index.js';
import { assertProductionConfig } from '../server/config.js';

assertProductionConfig();

const started = Date.now();
const { summary } = await initDatabase();
const info = getDatabaseInfo();

console.log('');
console.log('  NWIS database ready');
console.log(`  path        ${info.path}`);
console.log(`  migrations  ${info.migrations.filter((m) => m.applied).length}/${info.migrations.length} applied`);
console.log('');
console.log('  Table                     Rows');
console.log('  ------------------------  ---------');
Object.entries(info.counts).forEach(([table, count]) => {
  console.log(`  ${table.padEnd(24)}  ${String(count ?? '-').padStart(9)}`);
});

if (summary) {
  console.log('');
  console.log(`  events by category  ${JSON.stringify(summary.eventsByCategory)}`);
  console.log(`  build time          ${Date.now() - started} ms`);
}
console.log('');