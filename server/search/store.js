/**
 * Maintains the hybrid-search index.
 *
 * Every write path that creates knowledge (document extraction, event entry,
 * admin CRUD) calls `indexKnowledgeItem`, so the search index can never drift
 * out of sync with the source tables. All three stores — FTS5, the sparse
 * vector table, and the IDF lexicon — are updated in one transaction.
 */

import { buildVector, serializeVector } from './embed.js';

const upsertKnowledge = `
  INSERT INTO knowledge_items (
    kind, ref, well_id, title, body, depth_md_m, formation_id,
    event_id, document_id, page_no, citations_json, created_at
  ) VALUES (
    @kind, @ref, @well_id, @title, @body, @depth_md_m, @formation_id,
    @event_id, @document_id, @page_no, @citations_json, @created_at
  )
  ON CONFLICT(ref) DO UPDATE SET
    well_id = excluded.well_id,
    title = excluded.title,
    body = excluded.body,
    depth_md_m = excluded.depth_md_m,
    formation_id = excluded.formation_id,
    event_id = excluded.event_id,
    document_id = excluded.document_id,
    page_no = excluded.page_no,
    citations_json = excluded.citations_json
`;

const upsertVector = `
  INSERT INTO search_vectors (ref, kind, well_id, terms, norm, token_count, meta_json, created_at)
  VALUES (@ref, @kind, @well_id, @terms, @norm, @token_count, @meta_json, @created_at)
  ON CONFLICT(ref) DO UPDATE SET
    well_id = excluded.well_id,
    terms = excluded.terms,
    norm = excluded.norm,
    token_count = excluded.token_count,
    meta_json = excluded.meta_json
`;

/** Increments document frequency for each unique term of a document. */
function bumpLexicon(db, terms, delta) {
  if (!terms.length) return;
  const upsert = db.prepare(`
    INSERT INTO lexicon (term, df) VALUES (?, ?)
    ON CONFLICT(term) DO UPDATE SET df = MAX(0, df + ?)
  `);
  terms.forEach((term) => upsert.run(term, delta > 0 ? 1 : -1, delta > 0 ? 1 : -1));
}

/**
 * Adds or replaces one knowledge item across all three search stores.
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./embed.js').createIdfSource>} idf
 */
export function indexKnowledgeItem(db, idf, item) {
  const ref = item.ref;
  const existingTerms = db
    .prepare('SELECT terms FROM search_vectors WHERE ref = ?')
    .get(ref);

  const payload = {
    kind: item.kind,
    ref,
    well_id: item.wellId ?? null,
    title: item.title || '',
    body: item.body || '',
    depth_md_m: item.depthMd ?? null,
    formation_id: item.formationId ?? null,
    event_id: item.eventId ?? null,
    document_id: item.documentId ?? null,
    page_no: item.pageNo ?? null,
    citations_json: item.citations ? JSON.stringify(item.citations) : null,
    created_at: new Date().toISOString(),
  };

  if (existingTerms) {
    const previous = JSON.parse(existingTerms.terms || '[]');
    bumpLexicon(db, previous.map(([t]) => t), -1);
    db.prepare('DELETE FROM search_fts WHERE ref = ?').run(ref);
  }

  db.prepare(upsertKnowledge).run(payload);

  db.prepare(`
    INSERT INTO search_fts (ref, kind, well_id, well_name, formation, title, body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref,
    item.kind,
    item.wellId ?? null,
    item.wellName || '',
    item.formation || '',
    item.title || '',
    item.body || '',
  );

  // The vector is built against the IDF snapshot *before* this document is
  // counted, which is the standard "leave-one-out" IDF treatment.
  const vector = buildVector(`${item.title || ''} ${item.body || ''}`, idf);
  db.prepare(upsertVector).run({
    ref,
    kind: item.kind,
    well_id: item.wellId ?? null,
    terms: JSON.stringify(vector.terms),
    norm: vector.norm,
    token_count: vector.tokens,
    meta_json: JSON.stringify({
      depthMd: item.depthMd ?? null,
      pageNo: item.pageNo ?? null,
      documentId: item.documentId ?? null,
      eventId: item.eventId ?? null,
    }),
    created_at: payload.created_at,
  });
  bumpLexicon(db, vector.terms.map(([t]) => t), 1);
  return ref;
}

export function indexKnowledgeItems(db, idf, items) {
  const run = db.transaction((list) => list.forEach((item) => indexKnowledgeItem(db, idf, item)));
  run(items);
  idf.refresh();
  return items.length;
}

export function removeKnowledgeItem(db, ref) {
  const existing = db.prepare('SELECT terms FROM search_vectors WHERE ref = ?').get(ref);
  if (!existing) return false;
  const previous = JSON.parse(existing.terms || '[]');
  bumpLexicon(db, previous.map(([t]) => t), -1);
  db.prepare('DELETE FROM search_vectors WHERE ref = ?').run(ref);
  db.prepare('DELETE FROM search_fts WHERE ref = ?').run(ref);
  db.prepare('DELETE FROM knowledge_items WHERE ref = ?').run(ref);
  return true;
}

/** Drops the whole index and rebuilds it from the source tables. */
export function rebuildIndex(db, idf, items) {
  db.exec('DELETE FROM search_fts; DELETE FROM search_vectors; DELETE FROM lexicon; DELETE FROM knowledge_items;');
  idf.refresh();
  return indexKnowledgeItems(db, idf, items);
}

export function indexStats(db) {
  const vectors = db.prepare('SELECT COUNT(*) AS c FROM search_vectors').get().c;
  const fts = db.prepare('SELECT COUNT(*) AS c FROM search_fts').get().c;
  const lexicon = db.prepare('SELECT COUNT(*) AS c FROM lexicon').get().c;
  const byKind = db
    .prepare('SELECT kind, COUNT(*) AS c FROM knowledge_items GROUP BY kind')
    .all()
    .reduce((acc, row) => ({ ...acc, [row.kind]: row.c }), {});
  return { vectors, fts, lexiconTerms: lexicon, byKind };
}