import 'dotenv/config';

/**
 * Central configuration. Every value has a safe development default so the
 * project runs from a clean clone with an empty `.env`. Production boot
 * validates the handful of values that genuinely have no safe default.
 */

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback) => {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const config = {
  env,
  isProduction,
  port: int(process.env.PORT, 4000),

  cors: {
    // `true` (reflect any origin) is only ever acceptable in development.
    origin: isProduction
      ? list(process.env.CORS_ORIGIN, [])
      : process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== 'true'
        ? list(process.env.CORS_ORIGIN, true)
        : true,
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || (isProduction ? '' : 'dev-only-insecure-secret'),
    refreshSecret:
      process.env.JWT_REFRESH_SECRET || (isProduction ? '' : 'dev-only-insecure-refresh-secret'),
    accessTtl: process.env.JWT_ACCESS_TTL || '30m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  },

  db: {
    path: process.env.NWIS_DB_PATH || ':memory:',
    autoSeed: bool(process.env.NWIS_AUTO_SEED, true),
    deterministic: bool(process.env.NWIS_SEED_DETERMINISTIC, true),
    seed: int(process.env.NWIS_SEED, 20260101),
    storageDir: process.env.NWIS_STORAGE_DIR || './storage',
    postgresUrl: process.env.DATABASE_URL || '',
  },

  corpus: {
    fields: int(process.env.NWIS_N_FIELDS, 3),
    wells: int(process.env.NWIS_N_WELLS, 48),
    docsPerWell: float(process.env.NWIS_DOCS_PER_WELL, 0.6),
    telemetryPoints: int(process.env.NWIS_TELEMETRY_POINTS, 260),
  },

  nlp: {
    ocrEnabled: bool(process.env.NWIS_OCR_ENABLED, true),
    ocrMode: process.env.NWIS_OCR_MODE || 'auto',
    ocrLangs: list(process.env.NWIS_OCR_LANGS, ['eng']),
    // Pages yielding less text than this are treated as scanned pages.
    textThreshold: int(process.env.NWIS_OCR_TEXT_THRESHOLD, 40),
    // Extracted facts below this confidence go to the review queue.
    minConfidence: float(process.env.NWIS_OCR_MIN_CONFIDENCE, 0.72),
    maxUploadBytes: int(process.env.NWIS_MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
  },

  live: {
    source: process.env.NWIS_LIVE_SOURCE || 'simulator',
    intervalMs: int(process.env.NWIS_LIVE_INTERVAL_MS, 2000),
    staleSeconds: int(process.env.NWIS_LIVE_STALE_SECONDS, 180),
    ertmacBaseUrl: process.env.NWIS_ERTTMAC_BASE_URL || '',
    mqttUrl: process.env.NWIS_ERTTMAC_MQTT_URL || '',
  },

  ml: {
    artifactsDir: process.env.NWIS_ML_ARTIFACTS_DIR || './ml/artifacts',
    requireTrained: bool(process.env.NWIS_ML_REQUIRE_TRAINED, false),
    embeddingDim: int(process.env.NWIS_EMBEDDING_DIM, 256),
  },

  llm: {
    provider: process.env.LLM_PROVIDER || 'none',
    model: process.env.LLM_MODEL || '',
    baseUrl: process.env.LLM_BASE_URL || 'http://localhost:11434',
    apiKey: process.env.LLM_API_KEY || '',
  },

  rag: {
    topK: int(process.env.NWIS_RAG_TOP_K, 8),
    minScore: float(process.env.NWIS_RAG_MIN_SCORE, 0.15),
  },

  logLevel: process.env.NWIS_LOG_LEVEL || (isProduction ? 'info' : 'info'),
};

/**
 * Fail fast rather than silently running an API on a publicly-guessable JWT
 * signing key. Called once from server/index.js before the app starts serving.
 */
export function assertProductionConfig() {
  if (!config.isProduction) return;
  const problems = [];
  if (!config.auth.jwtSecret) problems.push('JWT_SECRET');
  if (!config.auth.refreshSecret) problems.push('JWT_REFRESH_SECRET');
  if (config.auth.jwtSecret && config.auth.jwtSecret.startsWith('dev-only')) {
    problems.push('JWT_SECRET (still the development default)');
  }
  if (!Array.isArray(config.cors.origin) || config.cors.origin.length === 0) {
    problems.push('CORS_ORIGIN (required in production)');
  }
  if (!config.db.postgresUrl && config.db.path === ':memory:') {
    problems.push('NWIS_DB_PATH or DATABASE_URL (in-memory database loses all data)');
  }
  if (problems.length) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n  - ${problems.join('\n  - ')}\n` +
        'See .env.example for the required values.',
    );
  }
}

export default config;