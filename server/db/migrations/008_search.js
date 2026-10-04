/**
 * 008 — Hybrid search indexes.
 *
 * Two independent retrievers over the same logical corpus:
 *   - `search_fts`      FTS5 (porter stemmer + unicode61) for lexical ranking.
 *   - `search_vectors`  a sparse TF-IDF vector per reference for semantic-ish
 *                       recall, so a query for "stuck pipe" also retrieves
 *                       documents that say "differential sticking".
 *
 * Ranking fuses the two with Reciprocal Rank Fusion (server/search/hybrid.js),
 * so neither retriever can dominate the other and neither is a black box.
 *
 * The vectors are sparse rather than dense on purpose: NWIS must run on-prem
 * with no external embedding service, and sparse lexical vectors are auditable.
 * Swap `search_vectors.vector` for a dense pgvector column and the retriever
 * interface is unchanged.
 */
export default {
  name: '008_search',
  up: (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        ref UNINDEXED,
        kind UNINDEXED,
        well_id UNINDEXED,
        well_name,
        formation,
        title,
        body,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      -- Global document frequency for IDF weighting. Maintained incrementally
      -- as the corpus grows.
      CREATE TABLE lexicon (
        term TEXT PRIMARY KEY,
        df   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_lexicon_df ON lexicon(df DESC);

      CREATE TABLE search_vectors (
        ref        TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        well_id    INTEGER,
        terms      TEXT NOT NULL,          -- JSON [[term, weight], ...]
        norm       REAL NOT NULL,          -- L2 norm of the sparse vector
        token_count INTEGER,
        meta_json  TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_vectors_kind ON search_vectors(kind);
      CREATE INDEX idx_vectors_well ON search_vectors(well_id);

      -- Retrieved knowledge objects, so the assistant can cite a lesson rather
      -- than a raw paragraph.
      CREATE TABLE knowledge_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL CHECK (kind IN ('event','lesson','document_chunk','well_section','mud_program','cementing_job')),
        ref          TEXT NOT NULL UNIQUE,
        well_id      INTEGER,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        depth_md_m   REAL,
        formation_id INTEGER,
        event_id     INTEGER,
        document_id  INTEGER,
        page_no      INTEGER,
        citations_json TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_kind ON knowledge_items(kind);
      CREATE INDEX idx_knowledge_well ON knowledge_items(well_id);
      CREATE INDEX idx_knowledge_depth ON knowledge_items(depth_md_m);
    `);
  },
};