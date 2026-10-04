/**
 * Sparse TF-IDF vectorisation for offline semantic-ish retrieval.
 *
 * Why sparse TF-IDF rather than a transformer: NWIS has to run inside OIL's
 * network with no external embedding service, and every vector it produces has
 * to be explainable to a drilling engineer who will challenge a recommendation.
 * IDF weighting plus co-occurrence-free cosine similarity is enough to close the
 * vocabulary gap that matters here — "stuck pipe" retrieves "differential
 * sticking", "mud loss" retrieves "losses observed" — because the domain
 * synonyms are added by the domain lexicon in server/nlp/ontology.
 *
 * Everything is deterministic: same corpus, same vectors, byte for byte.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'over', 'under',
  'it', 'its', 'we', 'they', 'he', 'she', 'him', 'her', 'them', 'our', 'their',
  'as', 'so', 'no', 'not', 'nor', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'there', 'here', 'when', 'where', 'which', 'who', 'whom', 'what', 'how', 'why',
  'all', 'any', 'some', 'each', 'other', 'also', 'per', 'via', 'up', 'out', 'off',
  'page', 'pages', 'page_no', 'md', 'tvd', 'nbsp',
]);

/** Very small suffix stemmer. Deliberately conservative: over-stemming merges
 *  unrelated drilling terms far more damagingly than under-stemming. */
export function stem(token) {
  if (token.length <= 4) return token;
  if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('ses')) return token.slice(0, -2);
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 4) return token.slice(0, -1);
  return token;
}

/**
 * Tokenises free text. Numbers are preserved because depth and pressure values
 * are themselves searchable signals ("what happened at 2880 m").
 */
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d),(\d{3})/g, '$1$2') // 2,880 -> 2880
    .split(/[^a-z0-9./-]+/)
    .map((raw) => raw.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((token) => token.length >= 2 && token.length <= 40)
    .filter((token) => !STOPWORDS.has(token))
    .map((token) => (/^\d+$/.test(token) ? token : stem(token)));
}

/** Splits a document page into retrieval-sized chunks on paragraph then sentence
 *  boundaries, keeping a little overlap so a fact split across two paragraphs is
 *  still retrievable. */
export function chunkText(text, { targetChars = 900, overlapChars = 140 } = {}) {
  if (!text) return [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return [text.trim()].filter(Boolean);

  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > targetChars) {
      chunks.push(current.trim());
      const tail = current.slice(-overlapChars);
      current = `${tail}\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // A single very long paragraph still has to be split.
  const out = [];
  chunks.forEach((chunk) => {
    if (chunk.length <= targetChars * 1.8) {
      out.push(chunk);
      return;
    }
    const sentences = chunk.split(/(?<=[.!?])\s+/);
    let buffer = '';
    sentences.forEach((sentence) => {
      if (buffer && buffer.length + sentence.length > targetChars) {
        out.push(buffer.trim());
        buffer = sentence;
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
      }
    });
    if (buffer.trim()) out.push(buffer.trim());
  });
  return out.filter(Boolean);
}

/**
 * Builds a sparse TF-IDF vector.
 * @param {string} text
 * @param {{get: (term: string) => number, total: number}} idf  IDF lookup
 * @param {{topN?: number, minWeight?: number}} options
 * @returns {{terms: [string, number][], norm: number, tokens: number}}
 */
export function buildVector(text, idf, options = {}) {
  const { topN = 96, minWeight = 0.02 } = options;
  const tokens = tokenize(text);
  if (!tokens.length) return { terms: [], norm: 0, tokens: 0 };

  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

  const weights = [];
  counts.forEach((count, term) => {
    // Sub-linear tf damps the repetition that boilerplate headings produce.
    const tf = 1 + Math.log(count);
    const idfWeight = idf.get(term);
    const weight = tf * idfWeight;
    if (weight >= minWeight) weights.push([term, Number(weight.toFixed(5))]);
  });

  weights.sort((a, b) => b[1] - a[1]);
  const terms = weights.slice(0, topN);

  const norm = Math.sqrt(terms.reduce((sum, [, w]) => sum + w * w, 0)) || 1;
  return { terms, norm, tokens: tokens.length };
}

/** Cosine similarity between two already-normalised sparse vectors. */
export function cosine(termsA, normA, termsB, normB) {
  if (!termsA.length || !termsB.length || !normA || !normB) return 0;
  const map = new Map(termsB);
  let dot = 0;
  for (const [term, weight] of termsA) {
    const other = map.get(term);
    if (other) dot += weight * other;
  }
  return dot / (normA * normB);
}

/** Jaccard overlap on terms — used to keep RRF from returning near-duplicates. */
export function termOverlap(termsA, termsB) {
  if (!termsA.length || !termsB.length) return 0;
  const setB = new Set(termsB.map(([t]) => t));
  let shared = 0;
  for (const [term] of termsA) if (setB.has(term)) shared += 1;
  return shared / Math.min(termsA.length, termsB.length);
}

export function serializeVector(vector) {
  return JSON.stringify({ terms: vector.terms, norm: vector.norm, tokens: vector.tokens });
}

export function deserializeVector(json) {
  if (!json) return { terms: [], norm: 0, tokens: 0 };
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return {
      terms: Array.isArray(parsed.terms) ? parsed.terms : [],
      norm: Number(parsed.norm) || 0,
      tokens: Number(parsed.tokens) || 0,
    };
  } catch {
    return { terms: [], norm: 0, tokens: 0 };
  }
}

/**
 * Incremental IDF source backed by the `lexicon` table.
 * Total document count is passed in rather than stored so it can be derived
 * from whichever corpus table is currently populated.
 */
export function createIdfSource(db) {
  const cache = new Map();
  let total = 0;
  let version = 0;

  const refresh = () => {
    cache.clear();
    // The lexicon table only exists once migration 008 has run. Tolerating its
    // absence keeps this module usable against a partially migrated database
    // (for example inside a migration test) instead of throwing.
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lexicon'")
      .get();
    if (!hasTable) {
      total = 1;
      version += 1;
      return;
    }
    const rows = db.prepare('SELECT term, df FROM lexicon WHERE df > 0').all();
    rows.forEach((row) => cache.set(row.term, row.df));
    total = db.prepare('SELECT COUNT(*) AS c FROM search_vectors').get().c || 1;
    version += 1;
  };

  refresh();

  return {
    refresh,
    get version() {
      return version;
    },
    get size() {
      return total;
    },
    get df() {
      return cache;
    },
    /**
     * Smoothed IDF: log((N + 1) / (df + 1)) + 1. The +1 keeps a term that
     * appears in every document from contributing exactly zero weight, which
     * would make "drilling" invisible in every query.
     */
    get(term) {
      const df = cache.get(term) || 0;
      return Math.log((total + 1) / (df + 1)) + 1;
    },
  };
}