import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { risks } from '../src/data/risks.js';
import {
  latestTelemetry,
  listDocuments,
  listEvents,
  listWells,
  openDatabase,
  parseJsonColumns,
} from './db.js';
import {
  architectureSummary,
  clusterWells,
  predictRisks,
  rankOffsetWells,
} from './ml.js';
import {
  createUser,
  requireAuth,
  requireRole,
  sanitizeUser,
  signToken,
  verifyLogin,
} from './auth.js';

const app = express();
const db = openDatabase();
const auth = requireAuth(db);
const port = Number(process.env.PORT || 4000);

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'NWIS backend',
    database: 'SQLite',
    ml: ['risk classifier', 'analogue well clustering', 'similarity ranking'],
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/register', asyncRoute((req, res) => {
  const user = createUser(db, req.body);
  res.status(201).json({
    user: sanitizeUser(user),
    token: signToken(user),
  });
}));

app.post('/api/auth/login', asyncRoute((req, res) => {
  const user = verifyLogin(db, req.body);
  res.json({
    user: sanitizeUser(user),
    token: signToken(user),
  });
}));

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/wells', (req, res) => {
  const radiusKm = req.query.radiusKm ? numberOrDefault(req.query.radiusKm, 5) : undefined;
  res.json({ wells: listWells(db, { radiusKm }) });
});

app.get('/api/wells/:id', (req, res) => {
  const well = db.prepare('SELECT * FROM wells WHERE id = ?').get(req.params.id);
  if (!well) {
    res.status(404).json({ error: 'well not found' });
    return;
  }
  const events = listEvents(db, { well: well.name }).map((event) => parseJsonColumns(event, ['parameters_json']));
  const documents = listDocuments(db, { well: well.name }).map((document) => parseJsonColumns(document, ['nlp_entities_json']));
  res.json({ well, events, documents });
});

app.get('/api/events', (req, res) => {
  const events = listEvents(db, {
    well: req.query.well,
    eventType: req.query.eventType,
    formation: req.query.formation,
    severity: req.query.severity,
    minDepth: req.query.minDepth,
    maxDepth: req.query.maxDepth,
    q: req.query.q,
  }).map((event) => parseJsonColumns(event, ['parameters_json']));
  res.json({ events });
});

app.get('/api/documents', (req, res) => {
  const documents = listDocuments(db, {
    well: req.query.well,
    q: req.query.q,
  }).map((document) => parseJsonColumns(document, ['nlp_entities_json']));
  res.json({ documents });
});

app.get('/api/telemetry', (req, res) => {
  const range = numberOrDefault(req.query.range, 30);
  res.json({ telemetry: latestTelemetry(db, range) });
});

app.get('/api/risks', (_req, res) => {
  res.json({
    risks,
    source: 'static prototype risk taxonomy, enriched by /api/ml/risk predictions',
  });
});

app.get('/api/ml/architecture', (_req, res) => {
  res.json(architectureSummary(db));
});

app.get('/api/ml/similarity', (req, res) => {
  res.json({
    activeWellId: req.query.activeWellId || 'A-17',
    radiusKm: numberOrDefault(req.query.radiusKm, 5),
    ranked_wells: rankOffsetWells(db, {
      activeWellId: req.query.activeWellId || 'A-17',
      radiusKm: numberOrDefault(req.query.radiusKm, 5),
    }),
  });
});

app.get('/api/ml/clusters', (req, res) => {
  res.json({
    model: 'k-means analogue well clustering',
    clusters: clusterWells(db, {
      k: numberOrDefault(req.query.k, 3),
      iterations: numberOrDefault(req.query.iterations, 8),
    }),
  });
});

app.get('/api/ml/risk', (req, res) => {
  const depth = numberOrDefault(req.query.depth, 2850);
  const formation = req.query.formation || 'Formation X';
  res.json({
    depth,
    formation,
    predictions: predictRisks(db, { depth, formation }),
  });
});

app.post('/api/alerts/evaluate', (req, res) => {
  const depth = numberOrDefault(req.body.depth, 2850);
  const formation = req.body.formation || 'Formation X';
  const predictions = predictRisks(db, {
    depth,
    formation,
    telemetry: req.body.telemetry,
  });
  const top = predictions[0];
  res.json({
    alert: {
      active: top.score >= 40,
      level: top.level,
      message: `${top.risk_type} risk ${top.score}% near ${depth}-${depth + 125} m`,
      requires_engineer_review: true,
    },
    predictions,
  });
});

app.get('/api/alerts/current', (req, res) => {
  const depth = numberOrDefault(req.query.depth, 2850);
  const formation = req.query.formation || 'Formation X';
  const predictions = predictRisks(db, { depth, formation });
  const actionable = predictions.filter((prediction) => prediction.score >= 40);
  res.json({
    depth,
    formation,
    alerts: actionable.map((prediction) => ({
      risk_type: prediction.risk_type,
      score: prediction.score,
      level: prediction.level,
      interval_m: prediction.interval_m,
      evidence_count: prediction.evidence.length,
      recommendations: prediction.recommendations,
    })),
  });
});

app.get('/api/recommendations', (req, res) => {
  const depth = numberOrDefault(req.query.depth, 2850);
  const formation = req.query.formation || 'Formation X';
  const riskType = req.query.riskType;
  const predictions = predictRisks(db, { depth, formation });
  const selected = riskType
    ? predictions.find((prediction) => prediction.risk_type === riskType)
    : predictions[0];

  if (!selected) {
    res.status(404).json({ error: 'risk type not found' });
    return;
  }

  res.json({
    depth,
    formation,
    risk_type: selected.risk_type,
    score: selected.score,
    recommendations: selected.recommendations,
    evidence: selected.evidence,
    disclaimer: 'Decision-support only. Engineer review is required before operational action.',
  });
});

app.get('/api/search', (req, res) => {
  const q = req.query.q || '';
  res.json({
    q,
    events: listEvents(db, { q }).map((event) => parseJsonColumns(event, ['parameters_json'])),
    documents: listDocuments(db, { q }).map((document) => parseJsonColumns(document, ['nlp_entities_json'])),
  });
});

app.post('/api/admin/events', auth, requireRole('admin'), (req, res) => {
  const required = ['well_id', 'well_name', 'depth_m', 'formation', 'event_type', 'severity', 'event_date', 'source'];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) {
    res.status(400).json({ error: `missing fields: ${missing.join(', ')}` });
    return;
  }

  const result = db.prepare(`
    INSERT INTO operational_events (
      well_id, well_name, depth_m, formation, event_type, severity, event_date, source,
      npt_hours, mitigation, parameters_json
    ) VALUES (
      @well_id, @well_name, @depth_m, @formation, @event_type, @severity, @event_date, @source,
      @npt_hours, @mitigation, @parameters_json
    )
  `).run({
    ...req.body,
    npt_hours: req.body.npt_hours ?? 0,
    mitigation: req.body.mitigation ?? 'Review and validate with drilling engineer.',
    parameters_json: JSON.stringify(req.body.parameters || {}),
  });

  res.status(201).json({
    event: db.prepare('SELECT * FROM operational_events WHERE id = ?').get(result.lastInsertRowid),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'internal server error',
    status,
  });
});

app.listen(port, () => {
  console.log(`NWIS backend listening on http://localhost:${port}`);
  console.log('Demo users: engineer@nwis.demo / demo1234, admin@nwis.demo / admin1234');
});
