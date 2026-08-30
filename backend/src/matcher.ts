/**
 * Umbral operativo para FaceNet 128-d L2-normalizado.
 *
 * Distancia euclidiana 0.6 de face-api ≈ coseno 0.82 en vectores unitarios.
 * En 1:N el FAR crece con el tamaño de la galería, así que subimos el listón.
 *
 * intraMean / intraStd miden qué tan compacto quedó el enrollo de esa persona.
 * Un cluster más apretado permite un umbral un poco más exigente sin disparar FRR.
 */
export const BASE_COSINE_THRESHOLD = 0.52;
export const MAX_COSINE_THRESHOLD = 0.72;
export const MIN_COSINE_THRESHOLD = 0.48;

export function l2Normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  if (norm < 1e-12) return vector.slice();
  return vector.map((value) => value / norm);
}

export function cosine(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

export function meanVector(samples: number[][]): number[] {
  const dim = samples[0]?.length ?? 0;
  const acc = new Array<number>(dim).fill(0);
  for (const sample of samples) {
    for (let i = 0; i < dim; i += 1) acc[i] += sample[i];
  }
  return l2Normalize(acc.map((value) => value / samples.length));
}

export function intraStats(samples: number[][]): { mean: number; std: number } {
  if (samples.length < 2) return { mean: 1, std: 0 };
  const scores: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      scores.push(cosine(samples[i], samples[j]));
    }
  }
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const variance =
    scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  return { mean, std: Math.sqrt(variance) };
}

export function adaptiveThreshold(intraMean: number, intraStd: number, gallerySize: number): number {
  const qualityOffset = clamp(0.06 - intraStd * 1.8, 0, 0.07);
  const compactness = clamp((intraMean - 0.7) * 0.15, 0, 0.04);
  const identificationMargin = gallerySize > 1 ? Math.min(0.08, 0.025 * Math.log10(gallerySize + 1) * 3) : 0;
  return clamp(
    BASE_COSINE_THRESHOLD + qualityOffset + compactness + identificationMargin,
    MIN_COSINE_THRESHOLD,
    MAX_COSINE_THRESHOLD,
  );
}

export function enrollmentQuality(samples: number[][]): { ok: boolean; reason: string } {
  if (samples.length < 4) {
    return { ok: false, reason: "Se necesitan al menos 4 capturas válidas de la misma persona." };
  }
  const { mean, std } = intraStats(samples);
  if (mean < 0.62) {
    return { ok: false, reason: "Las capturas no parecen de la misma persona. Repite el enrollo con mejor luz." };
  }
  if (std > 0.14) {
    return { ok: false, reason: "Hay demasiada variación entre capturas. Mantén una distancia estable a la cámara." };
  }
  return { ok: true, reason: "ok" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
