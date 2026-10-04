/**
 * Offset-well selection.
 *
 * The question this answers is "which historical wells does this interval resemble,
 * and how much should I care?" — the basis for every offset evidence panel in the
 * product.
 *
 * Two ranking strategies, because they answer different questions and picking one
 * silently would hide the difference:
 *
 * - `pressure` ranks by pore-pressure proximity. Use it before drilling into an
 *   interval where the pressure behaviour, not the rock, is the question.
 * - `depth` ranks by depth overlap. Use it where the formation is the same and the
 *   pressure is already known.
 *
 * Both operate on measured depth against a known TVD reference. Nothing here
 * compares MD to TVD: they are different quantities and the schema keeps them in
 * separate columns precisely so that mistake is hard to make. A well is only
 * comparable to an active well at a shared point in the hole, and that point is
 * defined by measured depth plus a stated depth reference.
 */

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Cross-track distance of a well from the line between two points.
 *
 * Offset wells in a section are commonly described by their perpendicular
 * departure from the section line rather than by raw distance, because two wells
 * 10 km away on opposite sides of the line are not comparable but are 10 km apart.
 */
export function crossTrackKm(well, lineStart, lineEnd) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const φ1 = toRad(lineStart.lat);
  const λ1 = toRad(lineStart.lon);
  const φ2 = toRad(lineEnd.lat);
  const λ2 = toRad(lineEnd.lon);
  const φw = toRad(well.lat);
  const λw = toRad(well.lon);

  const Δ13 = haversineRadians(lineStart, well);
  // Bearing from line start to the well, and along the line itself.
  const θ13 = Math.atan2(
    Math.sin(λw - λ1) * Math.cos(φw),
    Math.cos(φ1) * Math.sin(φw) - Math.sin(φ1) * Math.cos(φw) * Math.cos(λw - λ1),
  );
  const θ12 = Math.atan2(
    Math.sin(λ2 - λ1) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1),
  );

  const δxt = Math.asin(Math.sin(Δ13) * Math.sin(θ13 - θ12));
  // Longitudinal offset along the line, used only to report which way the well sits.
  const δat = Math.acos(Math.cos(Δ13) / Math.cos(δxt));
  const signed = Math.cos(θ13 - θ12) > 0 ? -δxt : δxt;
  return { crossTrackKm: signed * R, alongTrackKm: δat * R };
}

function haversineRadians(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h));
}

/**
 * Ranks candidate wells for an active interval.
 *
 * @param {object} params
 * @param {object} params.target `{ wellName, lat, lon, depthMd, formationId }`
 * @param {Array} params.candidates wells with `{ wellName, lat, lon, tops, events }`
 * @param {object} params.options
 * @param {'pressure'|'depth'} [options.strategy]
 * @param {number} [options.radiusKm]
 * @param {number} [options.limit]
 * @param {number} [options.depthToleranceM] half-width of the depth band
 */
export function rankOffsets({ target, candidates, options = {} }) {
  const {
    strategy = 'pressure',
    radiusKm = 50,
    limit = 12,
    depthToleranceM = 120,
  } = options;

  const scored = [];

  for (const candidate of candidates) {
    if (candidate.wellName === target.wellName) continue;

    const distance = haversineKm(target, candidate);
    // Radius is a hard filter, not a ranking term. An offset 200 km away is not a
    // slightly weaker offset, it is a different geological province, and letting
    // it into the list under a low score would invite exactly the cross-well
    // comparison the schema is designed to prevent.
    if (distance > radiusKm) continue;

    const targetTop = topAt(target.tops, target.depthMd);
    const candidateTop = topAt(candidate.tops, target.depthMd);

    const depthMatch =
      targetTop && candidateTop
        ? depthSimilarity(targetTop, candidateTop, target.depthMd, candidateTop, depthToleranceM)
        : null;

    const pressureMatch =
      targetTop && candidateTop
        ? gradientSimilarity(targetTop, candidateTop)
        : null;

    if (depthMatch === null && pressureMatch === null) continue;

    // Formation identity is the strongest available signal about whether two
    // intervals are comparable at all, and it is reported separately from the
    // numeric scores so a reviewer can see *why* a well was proposed.
    const sameFormation = !!(targetTop && candidateTop && targetTop.formationId === candidateTop.formationId);

    const events = (candidate.events ?? [])
      .map((event) => ({
        ...event,
        // Distance from the interval being drilled, in metres of hole.
        offsetM: Math.abs((event.depth_md_m ?? event.depth_m ?? 0) - target.depthMd),
      }))
      .filter((event) => event.offsetM <= depthToleranceM * 3)
      .sort((a, b) => a.offsetM - b.offsetM);

    const score =
      strategy === 'pressure'
        ? (sameFormation ? 0.5 : 0) + (pressureMatch ?? 0) * 0.3 + (depthMatch ?? 0) * 0.2
        : (sameFormation ? 0.5 : 0) + (depthMatch ?? 0) * 0.35 + (pressureMatch ?? 0) * 0.15;

    // A well with recorded trouble nearby is far more useful as evidence than one
    // that merely looks similar, and an offset panel of only quiet wells teaches
    // nothing. The bonus is bounded so it cannot dominate the geological match.
    const troubleNearby = events.filter((event) => event.offsetM <= depthToleranceM * 2).length;
    const adjusted = Math.min(1, score + Math.min(0.15, troubleNearby * 0.05));

    scored.push({
      wellName: candidate.wellName,
      fieldName: candidate.fieldName ?? null,
      distanceKm: round(distance, 2),
      bearingDeg: bearing(target, candidate),
      score: round(adjusted, 4),
      geologyScore: round(score, 4),
      sameFormation,
      targetFormation: targetTop ? { code: targetTop.code ?? targetTop.formation, topMd: targetTop.top_md_m } : null,
      offsetFormation: candidateTop ? { code: candidateTop.code ?? candidateTop.formation, topMd: candidateTop.top_md_m } : null,
      depthMatch: round(depthMatch, 4),
      pressureMatch: round(pressureMatch, 4),
      // Both gradients in psi/ft, stated so the comparison is auditable. The
      // model card convention applies here too: never compare MD against TVD.
      gradients: targetTop && candidateTop
        ? {
            targetPorePressurePsiFt: round(targetTop.ppGradient, 5),
            offsetPorePressurePsiFt: round(candidateTop.ppGradient, 5),
            targetFracturePsiFt: round(targetTop.fgGradient, 5),
            offsetFracturePsiFt: round(candidateTop.fgGradient, 5),
            depthReference: 'MD',
          }
        : null,
      troubleNearby,
      nearbyEvents: events.slice(0, 6),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  return {
    strategy,
    radiusKm,
    depthToleranceM,
    target: { wellName: target.wellName, depthMd: target.depthMd },
    candidateCount: scored.length,
    offsets: scored.slice(0, limit),
  };
}

/** The formation top in effect at a given measured depth. */
export function topAt(tops, depthMd) {
  if (!tops?.length) return null;
  const ordered = [...tops].sort((a, b) => a.base_md_m - b.base_md_m);
  let current = ordered[0];
  for (const top of ordered) {
    if (top.base_md_m <= depthMd) current = top;
    else break;
  }
  return current;
}

/**
 * Similarity of formation identity between two intervals at a shared depth.
 *
 * Returns null when either side has no top covering the depth — an absent top is
 * not a match of zero, it is an absence of information, and treating it as a zero
 * would let a well with no tops at all rank alongside a well with a full set.
 */
function depthSimilarity(targetTop, candidateTop, depthMd, candidate, toleranceM) {
  const targetBase = targetTop.base_md_m;
  const candidateBase = candidateTop.base_md_m;
  const targetThickness = Math.max(1, (targetTop.tvd_m ?? 0) - targetBase);
  void targetThickness;
  const delta = Math.abs(candidateBase - targetBase);
  if (delta > toleranceM) return 0;
  return 1 - delta / toleranceM;
}

/**
 * How similar the drilling environment is, from the pore and fracture gradients.
 *
 * Both gradients together, not pore pressure alone: two intervals can share a
 * pore pressure and still have completely different fracture limits, and the
 * fracture gradient is what decides whether a mud weight that is safe in one is
 * safe in the other.
 */
function gradientSimilarity(targetTop, candidateTop) {
  const parts = [
    [targetTop.ppGradient, candidateTop.ppGradient],
    [targetTop.fgGradient, candidateTop.fgGradient],
  ].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

  if (!parts.length) return null;

  const similarities = parts.map(([a, b]) => {
    const spread = Math.max(Math.abs(a), Math.abs(b));
    if (spread === 0) return 1;
    return Math.max(0, 1 - Math.abs(a - b) / spread);
  });
  return similarities.reduce((a, b) => a + b, 0) / similarities.length;
}

export function bearing(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const y = Math.sin(toRad(to.lon - from.lon)) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(toRad(to.lon - from.lon));
  return round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, 1);
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}