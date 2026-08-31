/**
 * Métricas de verificación (1:1) e identificación en conjunto abierto (1:N).
 *
 * Funciones puras sobre listas de scores: no saben de caras ni de face-api, así
 * que se pueden comprobar a mano.
 */

export function stats(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return {
    n,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    p01: q(0.01),
    p05: q(0.05),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted[n - 1],
  };
}

/** FAR: impostores aceptados. FRR: genuinos rechazados. Regla: aceptar si score >= t. */
export function farFrr(genuine, impostor, t) {
  const far = impostor.reduce((acc, s) => acc + (s >= t ? 1 : 0), 0) / (impostor.length || 1);
  const frr = genuine.reduce((acc, s) => acc + (s < t ? 1 : 0), 0) / (genuine.length || 1);
  return { far, frr };
}

/** Curva DET completa, un punto por umbral candidato (todos los scores observados). */
export function detCurve(genuine, impostor) {
  const thresholds = [...new Set([...genuine, ...impostor])].sort((a, b) => a - b);
  return thresholds.map((t) => ({ t, ...farFrr(genuine, impostor, t) }));
}

/** EER: punto donde FAR y FRR se cruzan (interpolado sobre la curva DET). */
export function eer(genuine, impostor) {
  const curve = detCurve(genuine, impostor);
  let best = curve[0];
  for (const point of curve) {
    if (Math.abs(point.far - point.frr) < Math.abs(best.far - best.frr)) best = point;
  }
  return { eer: (best.far + best.frr) / 2, threshold: best.t, far: best.far, frr: best.frr };
}

/** Umbral mínimo que deja el FAR en o por debajo de `target`. */
export function thresholdForFar(genuine, impostor, target) {
  const curve = detCurve(genuine, impostor);
  for (const point of curve) {
    if (point.far <= target) return point;
  }
  return curve[curve.length - 1];
}

/**
 * Identificación en conjunto abierto (ROC open-set del NIST).
 *
 * - `mated`:    `{score, correcto}` del mejor candidato para un probe cuya
 *               identidad SÍ está en la galería.
 * - `nonMated`: `score` del mejor candidato para un probe cuya identidad NO
 *               está en la galería. Cualquier aceptación aquí es un fallo.
 *
 * FPIR = P(aceptar a alguien que no está enrolado)   ← el fallo del incidente
 * TPIR = P(aceptar Y acertar la identidad) para quien sí está enrolado
 */
export function openSet(mated, nonMated, t) {
  const fpir = nonMated.reduce((acc, s) => acc + (s >= t ? 1 : 0), 0) / (nonMated.length || 1);
  const tpir =
    mated.reduce((acc, m) => acc + (m.score >= t && m.correct ? 1 : 0), 0) / (mated.length || 1);
  const fnir = 1 - tpir;
  return { fpir, tpir, fnir };
}
