/**
 * 005 — Document corpus, page artefacts, retrieval chunks and ingestion jobs.
 *
 * Page-level granularity is deliberate: the whole point of the platform is that
 * an engineer can be shown *which page* of *which report* a claim came from.
 */
export default {
  name: '005_documents',
  up: (db) => {
    db.exec(`
      CREATE TABLE documents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        filename      TEXT NOT NULL,
        doc_type      TEXT NOT NULL CHECK (doc_type IN (
                        'WCR','DDR','MUD_LOG','CEMENTING_REPORT','TRAJECTORY_REPORT',
                        'CORE_REPORT','GEOGRAPHIC_LOG','DAILY_GEOLOGICAL_REPORT','OTHER')),
        well_id       INTEGER REFERENCES wells(id),
        well_name     TEXT,
        filed_date    TEXT,
        year          INTEGER,
        page_count    INTEGER NOT NULL DEFAULT 0,
        sha256        TEXT,
        storage_path  TEXT,
        file_size_bytes INTEGER,
        -- 'pending' | 'extracting' | 'text' | 'ocr' | 'partial' | 'failed'
        ocr_status    TEXT NOT NULL DEFAULT 'pending',
        ocr_confidence REAL,
        text_source   TEXT,
        pages_ocr_total INTEGER NOT NULL DEFAULT 0,
        pages_ocr_text  INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        processed_at  TEXT,
        created_at    TEXT NOT NULL,
        UNIQUE (well_id, filename)
      );
      CREATE INDEX idx_documents_well ON documents(well_id);
      CREATE INDEX idx_documents_type ON documents(doc_type);

      CREATE TABLE document_pages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_no        INTEGER NOT NULL,
        text           TEXT,
        char_count     INTEGER NOT NULL DEFAULT 0,
        image_path     TEXT,
        text_source    TEXT CHECK (text_source IN ('pdf_text_layer','ocr','mixed','none')),
        ocr_confidence REAL,
        ocr_engine     TEXT,
        processed_ms   INTEGER,
        UNIQUE (document_id, page_no)
      );
      CREATE INDEX idx_pages_doc ON document_pages(document_id, page_no);

      -- Retrieval units for hybrid search. The lexical_vector column holds a
      -- sparse TF-IDF vector (JSON, see server/search/embed.js) so retrieval works
      -- fully offline with no embedding service. The embedding column is reserved for a
      -- dense encoder when one is deployed on-prem.
      CREATE TABLE document_chunks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_no        INTEGER NOT NULL,
        chunk_no       INTEGER NOT NULL,
        section_type   TEXT,
        text           TEXT NOT NULL,
        token_count    INTEGER NOT NULL DEFAULT 0,
        well_id        INTEGER REFERENCES wells(id),
        depth_md_m     REAL,
        lexical_vector TEXT,
        embedding      BLOB,
        dim            INTEGER,
        created_at     TEXT NOT NULL,
        UNIQUE (document_id, page_no, chunk_no)
      );
      CREATE INDEX idx_chunks_well ON document_chunks(well_id);

      CREATE TABLE ingestion_jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL CHECK (kind IN ('document','telemetry_replay')),
        status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
        document_id     INTEGER REFERENCES documents(id) ON DELETE CASCADE,
        well_id         INTEGER REFERENCES wells(id),
        filename        TEXT,
        total_pages     INTEGER NOT NULL DEFAULT 0,
        processed_pages INTEGER NOT NULL DEFAULT 0,
        ocr_pages       INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        needs_review    INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        meta_json       TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_status ON ingestion_jobs(status);
    `);
  },
};