/**
 * Hybrid retrieval.
 *
 * Two retrievers run independently over the same corpus and their rankings are
 * fused with Reciprocal Rank Fusion:
 *
 *     score(d) = Σ  weight_r / (k + rank_r(d))
 *
 * RRF is used rather than a weighted score blend because FTS5's BM25 and cosine
 * similarity are on incomparable scales, and because a rank-based fusion degrades
 * gracefully when one retriever returns nothing.
 */

import { buildVector, cosine, deserializeVector, termOverlap } from './embed.js';

const RRF_K = 60;
const LEXICAL_WEIGHT = 1.0;
const SEMANTIC_WEIGHT = 0.85;

/** Escape a user query for an FTS5 MATCH expression. */
function toMatchExpression(query) {
  const cleaned = String(query)
    .replace(/["^*()]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .trim();
  if (!cleaned) return null;
  // Quote each token so FTS5 treats them as literals rather than operators,
  // then OR them together: recall matters more than precision at this stage
  // because RRF and the semantic retriever will re-rank.
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 2).slice(0, 24);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

function buildFilterSql(filters = {}, params = {}) {
  const clauses = [];
  if (filters.wellId != null) {
    clauses.push('sv.well_id = @wellId');
    params.wellId = filters.wellId;
  }
  if (filters.kind) {
    const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
    clauses.push(`sv.kind IN (${kinds.map((_, i) => `@kind${i}`).join(',')})`);
    kinds.forEach((kind, i) => {
      params[`kind${i}`] = kind;
    });
  }
  if (filters.minDepth != null) {
    clauses.push('json_extract(sv.meta_json, \'$.depthMd\') >= @minDepth');
    params.minDepth = filters.minDepth;
  }
  if (filters.maxDepth != null) {
    clauses.push('json_extract(sv.meta_json, \'$.depthMd\') <= @maxDepth');
    params.maxDepth = filters.maxDepth;
  }
  if (filters.wellIds?.length) {
    clauses.push(`sv.well_id IN (${filters.wellIds.map((_, i) => `@wellId${i}`).join(',')})`);
    filters.wellIds.forEach((id, i) => {
      params[`wellId${i}`] = id;
    });
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/** Lexical retriever: BM25 over the FTS5 index. */
export function lexicalSearch(db, query, { limit = 50, filters = {} } = {}) {
  const expression = toMatchExpression(query);
  if (!expression) return [];

  const params = { expression, limit: limit * 3 };
  const filterSql = buildFilterSql(filters, params);

  // FTS5 tables are queried directly; structural filters are applied through the
  // companion search_vectors row so the same filter DSL serves both retrievers.
  const rows = db
    .prepare(`
      SELECT f.ref, f.kind, sv.well_id, bm25(search_fts) AS bm25_score
      FROM search_fts f
      JOIN search_vectors sv ON sv.ref = f.ref
      WHERE search_fts MATCH @expression
        ${filterSql.replace(/sv\./g, 'sv.')}
      ORDER BY bm25_score ASC
      LIMIT @limit
    `)
    .all(params);

  return rows.map((row, index) => ({
    ref: row.ref,
    kind: row.kind,
    wellId: row.well_id,
    // bm25() is negative with smaller = better; convert to a positive 0..1-ish
    // relevance for display without pretending it is calibrated probability.
    rawScore: row.bm25_score,
    score: 1 / (1 + Math.exp(row.bm25_score / 8)),
    rank: index + 1,
    retriever: 'lexical',
  }));
}

/** Sparse-vector retriever: cosine similarity against the stored TF-IDF vectors. */
export function semanticSearch(db, idf, query, { limit = 50, filters = {} } = {}) {
  const queryVector = buildVector(query, idf, { topN: 64 });
  if (!queryVector.terms.length) return [];

  const params = {};
  const filterSql = buildFilterSql(filters, params);
  const rows = db
    .prepare(`SELECT ref, kind, well_id, terms, norm, meta_json FROM search_vectors ${filterSql}`)
    .all(params);

  const results = [];
  rows.forEach((row) => {
    const vector = deserializeVector(row.terms);
    const score = cosine(queryVector.terms, queryVector.norm, vector.terms, vector.norm);
    if (score <= 0.02) return;
    results.push({
      ref: row.ref,
      kind: row.kind,
      wellId: row.well_id,
      meta: row.meta_json ? JSON.parse(row.meta_json) : {},
      score,
      rank: 0,
      retriever: 'semantic',
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r, index) => ({ ...r, rank: index + 1 }));
}

/** Fuses retriever rankings with Reciprocal Rank Fusion. */
export function reciprocalRankFusion(resultSets, { k = RRF_K, weights = {} } = {}) {
  const fused = new Map();
  resultSets.forEach((results, setIndex) => {
    const weight = weights[setIndex] ?? 1;
    results.forEach((result) => {
      const existing = fused.get(result.ref) || {
        ref: result.ref,
        kind: result.kind,
        wellId: result.wellId,
        meta: result.meta || {},
        fusedScore: 0,
        lexicalRank: null,
        lexicalScore: null,
        semanticRank: null,
        semanticScore: null,
        sources: [],
      };
      existing.fusedScore += weight / (k + result.rank);
      if (result.retriever === 'lexical') {
        existing.lexicalRank = result.rank;
        existing.lexicalScore = result.score;
      } else {
        existing.semanticRank = result.rank;
        existing.semanticScore = result.score;
      }
      existing.sources.push(result.retriever);
      fused.set(result.ref, existing);
    });
  });

  return [...fused.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

/** Removes near-duplicate hits so ten variants of one page do not fill the list. */
export function diversify(results, { overlapThreshold = 0.82 } = {}) {
  const kept = [];
  results.forEach((candidate) => {
    const duplicate = kept.find(
      (k) => k.terms && k.kind === candidate.kind && termOverlap(k.terms, candidate.terms) >= overlapThreshold,
    );
    if (duplicate) {
      duplicate.mergedRefs = [...(duplicate.mergedRefs || [duplicate.ref]), candidate.ref];
      return;
    }
    kept.push({ ...candidate });
  });
  return kept;
}

/**
 * Full hybrid search: retrieve, fuse, hydrate, diversify, truncate.
 */
export function hybridSearch(db, idf, query, options = {}) {
  const {
    limit = 20,
    filters = {},
    includeMeta = true,
    rerankLocally = true,
  } = options;

  const lexical = lexicalSearch(db, query, { limit: limit * 3, filters });
  const semantic = semanticSearch(db, idf, query, { limit: limit * 3, filters });

  let fused = reciprocalRankFusion([lexical, semantic], {
    weights: { 0: LEXICAL_WEIGHT, 1: SEMANTIC_WEIGHT },
  });

  if (!fused.length) return { query, results: [], retrieverStats: { lexical: 0, semantic: 0 } };

  const refs = fused.map((r) => r.ref);
  const hydrated = hydrate(db, refs);
  fused = fused.map((r) => ({ ...r, ...(hydrated.get(r.ref) || {}) }));

  // Local rerank using cheap, meaningful signals: how close the item's depth is
  // to the depth being drilled, whether it is from a nearby well, and whether
  // both retrievers agreed.
  if (rerankLocally) {
    const { activeWellId, targetDepth } = filters;
    const depthWell = new Map();
    if (activeWellId) {
      db.prepare('SELECT well_name, lat, lng FROM wells WHERE id = ?').get(activeWellId);
    }
    fused = fused
      .map((r) => {
        let bonus = 0;
        const depth = r.depthMd ?? null;
        if (targetDepth != null && depth != null) {
          const delta = Math.abs(depth - targetDepth);
          if (delta <= 150) bonus += 0.05;
          if (r.wellId === activeWellId) bonus += 0.03;
        }
        if (r.lexicalRank && r.semanticRank) bonus += 0.02;
        if (r.kind === 'lesson') bonus += 0.015;
        return { ...r, rerankScore: r.fusedScore + bonus };
      })
      .sort((a, b) => b.rerankScore - a.rerankScore);
    void depthWell;
  }

  fused = diversify(fused);

  const terms = fused.map((r) => deserializeVector(r.terms || JSON.stringify(r._terms)).terms);

  const results = fused.slice(0, limit).map((r, index) => ({
    rank: index + 1,
    ref: r.ref,
    kind: r.kind,
    wellId: r.wellId,
    wellName: r.wellName ?? null,
    title: r.title,
    snippet: buildSnippet(r.body, query),
    depthMd: r.depthMd ?? null,
    pageNo: r.pageNo ?? null,
    documentId: r.documentId ?? null,
    eventId: r.eventId ?? null,
    citations: r.citations ?? null,
    scores: {
      fused: Number((r.rerankScore ?? r.fusedScore).toFixed(6)),
      lexical: r.lexicalScore != null ? Number(r.lexicalScore.toFixed(4)) : null,
      lexicalRank: r.lexicalRank,
      semantic: r.semanticScore != null ? Number(r.semanticScore.toFixed(4)) : null,
      semanticRank: r.semanticRank,
    },
    retrievers: [...new Set(r.sources)],
  }));

  void terms;
  void includeMeta;
  return {
    query,
    results,
    retrieverStats: { lexical: lexical.length, semantic: semantic.length },
  };
}

function hydrate(db, refs) {
  const map = new Map();
  if (!refs.length) return map;
  const placeholders = refs.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ki.ref, ki.kind, ki.title, ki.body, ki.depth_md_m, ki.well_id, ki.page_no,
              ki.document_id, ki.event_id, ki.citations_json, w.well_name
       FROM knowledge_items ki
       LEFT JOIN wells w ON w.id = ki.well_id
       WHERE ki.ref IN (${placeholders})`,
    )
    .all(...refs);
  const vectorRows = db
    .prepare(`SELECT ref, terms FROM search_vectors WHERE ref IN (${placeholders})`)
    .all(...refs);

  const vectorMap = new Map(vectorRows.map((r) => [r.ref, r.terms]));
  rows.forEach((row) => {
    map.set(row.ref, {
      title: row.title,
      body: row.body,
      wellName: row.well_name,
      depthMd: row.depth_md_m,
      pageNo: row.page_no,
      documentId: row.document_id,
      eventId: row.event_id,
      citations: row.citations_json ? JSON.parse(row.citations_json) : null,
      terms: JSON.parse(vectorMap.get(row.ref) || '[]'),
    });
  });
  return map;
}

function buildSnippet(body, query, maxLength = 320) {
  if (!body) return '';
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const lower = text.toLowerCase();
  let best = 0;
  terms.forEach((term) => {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (best === 0 || idx < best)) best = idx;
  });
  const start = Math.max(0, best - Math.floor(maxLength / 3));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + maxLength)}${start + maxLength < text.length ? '…' : ''}`;
}

export { buildSnippet };