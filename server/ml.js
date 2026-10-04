import { latestTelemetry, listWells } from './db.js';

const riskModels = {
  'Stuck Pipe': {
    intercept: -2.9,
    weights: {
      eventDensity: 1.2,
      torque: 1.35,
      ropDrop: 0.9,
      trajectory: 0.8,
      formationX: 0.7,
      proximity: 1.1,
    },
  },
  'Lost Circulation': {
    intercept: -2.6,
    weights: {
      eventDensity: 1.05,
      pressureRise: 0.45,
      mudWeight: 0.75,
      formationX: 0.5,
      proximity: 1.0,
    },
  },
  Kick: {
    intercept: -3.2,
    weights: {
      eventDensity: 0.85,
      pressureRise: 1.0,
      mudWeight: -0.55,
      formationX: 0.4,
      proximity: 0.9,
    },
  },
  'Formation Instability': {
    intercept: -2.7,
    weights: {
      eventDensity: 1.1,
      torque: 0.75,
      ropDrop: 0.55,
      trajectory: 0.9,
      formationX: 0.8,
      proximity: 1.0,
    },
  },
};

const riskEventMap = {
  'Stuck Pipe': ['Stuck Pipe', 'High Torque', 'Torque Spike', 'Tight Hole'],
  'Lost Circulation': ['Lost Circulation', 'Mud Loss'],
  Kick: ['Kick'],
  'Formation Instability': ['Formation Instability', 'Tight Hole'],
};

const recommendations = {
  'Stuck Pipe': [
    'Review offset stuck-pipe and high-torque reports before drilling ahead.',
    'Increase torque, drag, ROP, and cuttings monitoring frequency through the interval.',
    'Prepare hole-cleaning sweep and define working limits with the drilling engineer.',
  ],
  'Lost Circulation': [
    'Prepare LCM material and update the loss-zone response plan.',
    'Watch ECD, flow-out, pit volume, and standpipe pressure trends closely.',
    'Compare mud-loss depths from offset wells before entering the look-ahead interval.',
  ],
  Kick: [
    'Confirm trip margin and review well-control readiness before approaching the interval.',
    'Track flow anomalies and standpipe pressure departures from the expected trend.',
    'Validate mud weight against pore-pressure indicators and offset kick evidence.',
  ],
  'Formation Instability': [
    'Review shale/instability notes from analogous offset wells.',
    'Tighten hole-cleaning and reaming practices through the unstable interval.',
    'Validate mud weight window and update the geomechanical assumptions.',
  ],
};

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formationX(formation = '') {
  return formation.includes('Formation X') ? 1 : 0;
}

function trajectoryScore(text = '') {
  const lower = text.toLowerCase();
  if (lower.includes('directional')) return 0.8;
  if (lower.includes('tangent') || lower.includes('s-shaped')) return 0.65;
  return 0.3;
}

function severityWeight(severity = '') {
  return { Low: 0.25, Medium: 0.55, High: 0.9 }[severity] ?? 0.35;
}

function featureVectorForWell(well, eventCount) {
  return [
    clamp(1 - Number(well.distance_km || 0) / 5, 0, 1),
    formationX(well.formation),
    trajectoryScore(well.trajectory),
    Number(well.current_depth_m || 0) / 4000,
    Number(well.total_depth_m || 0) / 4000,
    Number(well.similarity || 0) / 100,
    clamp(eventCount / 5, 0, 1),
  ];
}

function euclidean(a, b) {
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
}

function average(vectors) {
  return vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
}

export function rankOffsetWells(db, { activeWellId = 'A-17', radiusKm = 5 } = {}) {
  const wells = listWells(db, { radiusKm: Number(radiusKm) || 5 });
  const active = wells.find((well) => well.id === activeWellId) || wells[0];
  const eventCount = db.prepare(`
    SELECT well_id, COUNT(*) AS count
    FROM operational_events
    GROUP BY well_id
  `).all().reduce((acc, row) => ({ ...acc, [row.well_id]: row.count }), {});

  const activeVector = featureVectorForWell(active, eventCount[active.id] || 0);
  return wells
    .filter((well) => well.id !== active.id)
    .map((well) => {
      const vector = featureVectorForWell(well, eventCount[well.id] || 0);
      const distance = euclidean(activeVector, vector);
      const mlScore = Math.round(clamp((1 - distance / 2.2) * 100, 0, 100));
      return {
        ...well,
        model_similarity: mlScore,
        explanation: [
          well.formation === active.formation ? 'same formation' : 'nearby correlated formation',
          `${Number(well.distance_km).toFixed(1)} km from active well`,
          `${eventCount[well.id] || 0} indexed operational events`,
          `trajectory score ${trajectoryScore(well.trajectory).toFixed(2)}`,
        ],
      };
    })
    .sort((a, b) => b.model_similarity - a.model_similarity);
}

export function clusterWells(db, { k = 3, iterations = 8 } = {}) {
  const wells = listWells(db);
  const eventCount = db.prepare(`
    SELECT well_id, COUNT(*) AS count
    FROM operational_events
    GROUP BY well_id
  `).all().reduce((acc, row) => ({ ...acc, [row.well_id]: row.count }), {});

  const points = wells.map((well) => ({
    well,
    vector: featureVectorForWell(well, eventCount[well.id] || 0),
  }));
  let centroids = points.slice(0, k).map((point) => point.vector);
  let assignments = new Map();

  for (let i = 0; i < iterations; i += 1) {
    assignments = new Map();
    points.forEach((point) => {
      const clusterIndex = centroids
        .map((centroid, index) => ({ index, distance: euclidean(point.vector, centroid) }))
        .sort((a, b) => a.distance - b.distance)[0].index;
      assignments.set(point.well.id, clusterIndex);
    });

    centroids = centroids.map((centroid, index) => {
      const members = points.filter((point) => assignments.get(point.well.id) === index);
      return members.length ? average(members.map((member) => member.vector)) : centroid;
    });
  }

  return centroids.map((centroid, index) => ({
    cluster: index + 1,
    centroid,
    label: ['Active/closest analogue', 'Higher-risk offsets', 'Lower-similarity offsets'][index] || `Cluster ${index + 1}`,
    wells: points
      .filter((point) => assignments.get(point.well.id) === index)
      .map((point) => ({
        id: point.well.id,
        name: point.well.name,
        field: point.well.field,
        formation: point.well.formation,
        distance_km: point.well.distance_km,
      })),
  }));
}

function evidenceForRisk(db, riskType, depth) {
  const eventTypes = riskEventMap[riskType];
  const placeholders = eventTypes.map(() => '?').join(',');
  return db.prepare(`
    SELECT *
    FROM operational_events
    WHERE event_type IN (${placeholders})
      AND depth_m BETWEEN ? AND ?
    ORDER BY ABS(depth_m - ?) ASC, severity DESC
    LIMIT 6
  `).all(...eventTypes, Number(depth) - 120, Number(depth) + 160, Number(depth));
}

function currentTelemetry(db, telemetryOverride) {
  if (telemetryOverride) return telemetryOverride;
  const rows = latestTelemetry(db, 5);
  return rows[rows.length - 1] || {};
}

function riskFeatures(db, riskType, { depth, formation, telemetry }) {
  const evidence = evidenceForRisk(db, riskType, depth);
  const eventDensity = evidence.reduce((sum, event) => sum + severityWeight(event.severity), 0);
  const nearest = evidence[0];
  const proximity = nearest ? clamp(1 - Math.abs(nearest.depth_m - Number(depth)) / 160, 0, 1) : 0;
  const sample = currentTelemetry(db, telemetry);

  return {
    evidence,
    eventDensity: clamp(eventDensity / 2.5, 0, 1.5),
    torque: clamp((Number(sample.torque_knm || sample.torque || 18) - 17) / 8, 0, 1.6),
    ropDrop: clamp((21 - Number(sample.rop_mhr || sample.rop || 18)) / 8, 0, 1.4),
    pressureRise: clamp((Number(sample.standpipe_pressure_psi || sample.pressure || 2910) - 2850) / 420, 0, 1.4),
    mudWeight: clamp((Number(sample.mud_weight_sg || sample.mudWeight || 1.13) - 1.1) / 0.08, 0, 1.4),
    trajectory: 0.65,
    formationX: formationX(formation),
    proximity,
  };
}

export function predictRisks(db, { depth = 2850, formation = 'Formation X', telemetry } = {}) {
  return Object.entries(riskModels)
    .map(([riskType, model]) => {
      const features = riskFeatures(db, riskType, { depth, formation, telemetry });
      const linear = Object.entries(model.weights).reduce(
        (sum, [feature, weight]) => sum + (features[feature] || 0) * weight,
        model.intercept
      );
      const score = Math.round(sigmoid(linear) * 100);
      const level = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
      return {
        risk_type: riskType,
        model: 'supervised logistic-regression style classifier',
        score,
        level,
        interval_m: {
          from: Math.max(0, Number(depth) - 25),
          to: Number(depth) + 125,
        },
        features: {
          event_density: +features.eventDensity.toFixed(3),
          torque_index: +features.torque.toFixed(3),
          rop_drop_index: +features.ropDrop.toFixed(3),
          pressure_index: +features.pressureRise.toFixed(3),
          mud_weight_index: +features.mudWeight.toFixed(3),
          offset_proximity: +features.proximity.toFixed(3),
        },
        evidence: features.evidence.map((event) => ({
          well: event.well_name,
          depth_m: event.depth_m,
          event_type: event.event_type,
          severity: event.severity,
          source: event.source,
          mitigation: event.mitigation,
        })),
        recommendations: recommendations[riskType],
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function architectureSummary(db) {
  const trainingCount = db.prepare('SELECT COUNT(*) AS count FROM risk_training_samples').get().count;
  return {
    database: 'SQLite relational schema seeded with synthetic NWIS records',
    supervised_model: {
      name: 'Logistic-regression style risk classifier',
      training_rows: trainingCount,
      target: 'binary risk / no-risk label per depth interval',
      input_features: [
        'depth',
        'formation code',
        'torque',
        'ROP',
        'standpipe pressure',
        'mud weight',
        'offset event density',
        'trajectory complexity',
        'well similarity score',
      ],
      outputs: ['risk score', 'risk level', 'risk type', 'evidence-backed recommendations'],
    },
    unsupervised_model: {
      name: 'K-means analogue-well clustering',
      input_features: [
        'distance from active well',
        'formation match',
        'trajectory complexity',
        'current depth ratio',
        'total depth ratio',
        'prior similarity score',
        'indexed event density',
      ],
      outputs: ['well cluster', 'analogue ranking', 'explanation factors'],
    },
    note: 'The prototype uses deterministic lightweight models so the architecture is inspectable in a hackathon/demo setting. Production would train these models from validated OIL historical records.',
  };
}
