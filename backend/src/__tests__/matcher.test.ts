import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_COSINE_THRESHOLD,
  MAX_COSINE_THRESHOLD,
  MIN_COSINE_THRESHOLD,
  adaptiveThreshold,
  clampThreshold,
  cosine,
  enrollmentQuality,
  multiProbePenalty,
  storedSamplesPenalty,
  intraStats,
  l2Normalize,
  meanVector,
} from "../matcher.js";

function norm(vector: number[]): number {
  return Math.hypot(...vector);
}

test("l2Normalize deja el vector unitario", () => {
  const unit = l2Normalize([3, 4, 0, 0]);
  assert.ok(Math.abs(norm(unit) - 1) < 1e-12);
  assert.deepEqual(unit, [0.6, 0.8, 0, 0]);
});

test("l2Normalize no divide entre cero", () => {
  const zero = l2Normalize([0, 0, 0]);
  assert.deepEqual(zero, [0, 0, 0]);
  assert.ok(zero.every((value) => Number.isFinite(value)));
});

test("cosine de vectores unitarios: 1 consigo mismo, 0 ortogonal, -1 opuesto", () => {
  const a = l2Normalize([1, 2, 3]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-12);
});

test("meanVector devuelve el centroide normalizado", () => {
  const centroid = meanVector([l2Normalize([1, 0]), l2Normalize([0, 1])]);
  assert.ok(Math.abs(norm(centroid) - 1) < 1e-12);
  assert.ok(Math.abs(centroid[0] - centroid[1]) < 1e-12);
});

test("intraStats: muestras idénticas dan mean 1 y std 0", () => {
  const sample = l2Normalize([1, 2, 3, 4]);
  const { mean, std } = intraStats([sample, sample, sample]);
  assert.ok(Math.abs(mean - 1) < 1e-12);
  assert.ok(std < 1e-12);
});

test("intraStats con una sola muestra no falla", () => {
  assert.deepEqual(intraStats([[1, 0]]), { mean: 1, std: 0 });
});

test("intraStats baja el mean cuando las muestras se dispersan", () => {
  const apretado = intraStats([l2Normalize([1, 0.01]), l2Normalize([1, 0.02]), l2Normalize([1, 0])]);
  const disperso = intraStats([l2Normalize([1, 0]), l2Normalize([1, 1]), l2Normalize([0, 1])]);
  assert.ok(apretado.mean > disperso.mean);
  assert.ok(apretado.std < disperso.std);
});

test("adaptiveThreshold es monótono no decreciente con el tamaño de galería", () => {
  let previous = -Infinity;
  for (const gallerySize of [1, 2, 3, 5, 10, 50, 100, 1000, 10_000]) {
    const value = adaptiveThreshold(0.85, 0.05, gallerySize);
    assert.ok(value >= previous, `bajó en gallerySize=${gallerySize}`);
    previous = value;
  }
});

test("adaptiveThreshold sube con galería grande respecto a una sola identidad", () => {
  // Con (0.85, 0.05) los dos extremos chocaban contra el techo y salían iguales.
  // El techo pasó de 0.72 a 0.96 y la base de 0.52 a 0.93: ahora solo quedan
  // 0.03 de recorrido, así que el montaje necesita un enrollo apretado para que
  // el margen de identificación se vea sin tropezar con el clamp.
  assert.ok(adaptiveThreshold(0.97, 0.01, 1000) > adaptiveThreshold(0.97, 0.01, 1));
});

test("adaptiveThreshold siempre respeta los clamps", () => {
  const extremos = [-10, 0, 0.5, 0.7, 1, 10];
  for (const mean of extremos) {
    for (const std of extremos) {
      for (const gallerySize of [0, 1, 10, 1e6]) {
        const value = adaptiveThreshold(mean, std, gallerySize);
        assert.ok(value >= MIN_COSINE_THRESHOLD && value <= MAX_COSINE_THRESHOLD, `fuera de rango: ${value}`);
      }
    }
  }
});

test("adaptiveThreshold: el piso es el cluster clonado en galería de uno", () => {
  // Antes este test fijaba el piso en (0.65, 1): un cluster disperso. Con la
  // señal corregida la dispersión SUMA al umbral, así que el piso es el caso
  // contrario: coherencia perfecta, cero dispersión, una sola identidad.
  assert.equal(adaptiveThreshold(1, 0, 1), BASE_COSINE_THRESHOLD);
});

test("adaptiveThreshold: el cluster ancho es el exigente, no el apretado", () => {
  // Señal invertida respecto a la versión anterior, a propósito. El score es un
  // `max` sobre las muestras: un enrollo ancho sube también el score del
  // impostor y necesita el listón alto. Un enrollo apretado (cinco frames de la
  // misma sesión) no es calidad, es falta de cobertura: exigirle más solo
  // rechaza al dueño cuando cambia la luz o se quita los lentes.
  assert.ok(adaptiveThreshold(0.7, 0.2, 10) > adaptiveThreshold(0.95, 0.01, 10));
});

test("adaptiveThreshold: separar condiciones sube el umbral (compensa el FAR)", () => {
  // Los valores de antes (0.85 y 0.55) están por debajo de
  // MIN_INTER_CONDITION_COSINE: son enrollos que el alta ya no acepta, así que
  // como montaje no significaban nada. El ancla del término también se movió de
  // 0.9 a 0.95, porque la separación REAL entre dos condiciones de la misma
  // persona es 0.98–0.99 y con el ancla vieja este término era cero siempre.
  const unaCondicion = adaptiveThreshold(0.97, 0.01, 3, null);
  const dosCercanas = adaptiveThreshold(0.97, 0.01, 3, 0.99);
  const dosLejanas = adaptiveThreshold(0.97, 0.01, 3, 0.93);
  assert.ok(dosLejanas > dosCercanas, `${dosLejanas} debería superar a ${dosCercanas}`);
  assert.ok(dosCercanas >= unaCondicion);
});

test("enrollmentQuality rechaza menos de 4 capturas", () => {
  const sample = l2Normalize([1, 0, 0]);
  const result = enrollmentQuality([sample, sample, sample]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /4 capturas/);
});

test("multiProbePenalty crece con el número de descriptores y está topada", () => {
  assert.equal(multiProbePenalty(1), 0);
  assert.ok(multiProbePenalty(7) > multiProbePenalty(3));
  assert.ok(multiProbePenalty(1000) <= 0.005);
  // Medido con las variantes de augmentación reales: pasar de 1 a 7
  // descriptores sube el p99 del impostor 0.0039. La penalización tiene que
  // quedar en ese orden de magnitud, no en el 0.035 que salió de sintéticos.
  assert.ok(multiProbePenalty(7) > 0.003 && multiProbePenalty(7) < 0.006);
});

test("storedSamplesPenalty compensa el `max` sobre las muestras guardadas", () => {
  assert.equal(storedSamplesPenalty(0), 0);
  assert.equal(storedSamplesPenalty(1), 0);
  assert.ok(storedSamplesPenalty(20) > storedSamplesPenalty(5));
  assert.ok(storedSamplesPenalty(10_000) <= 0.005);
  // Medido: 20 muestras almacenadas suben el p99 del impostor 0.0039 respecto a
  // puntuar solo contra el centroide. La penalización va justo por encima.
  assert.ok(storedSamplesPenalty(20) >= 0.0039 && storedSamplesPenalty(20) <= 0.005);
});

test("clampThreshold hace de MAX un techo real, penalizaciones incluidas", () => {
  // Sin este acotado el umbral se colaba por encima de MAX: las penalizaciones
  // se suman DESPUÉS de adaptiveThreshold. Medido con galería de 100, colarse a
  // 0.9626 costaba 5.5 puntos de TPIR sin bajar el FPIR.
  const compuesto = adaptiveThreshold(0.9, 0.05, 1000) + multiProbePenalty(7) + storedSamplesPenalty(30);
  assert.ok(compuesto > MAX_COSINE_THRESHOLD, "el montaje requiere que se pase del techo");
  assert.equal(clampThreshold(compuesto), MAX_COSINE_THRESHOLD);
  assert.equal(clampThreshold(0.1), MIN_COSINE_THRESHOLD);
});

test("enrollmentQuality rechaza capturas incoherentes", () => {
  const result = enrollmentQuality([
    l2Normalize([1, 0, 0]),
    l2Normalize([0, 1, 0]),
    l2Normalize([0, 0, 1]),
    l2Normalize([-1, 0, 0]),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /misma persona/);
});

test("enrollmentQuality rechaza un `enrollo` de personas distintas", () => {
  // El gate estaba en intraMean 0.62 y esto pasaba. Medido sobre LFW: cinco
  // fotos de cinco personas distintas dan intraMean 0.8702 como mucho, y cinco
  // de la misma persona 0.8877 en el peor caso. El gate está en 0.88.
  const distintas = [
    l2Normalize([1, 0.5, 0.5, 0.5]),
    l2Normalize([0.5, 1, 0.5, 0.5]),
    l2Normalize([0.5, 0.5, 1, 0.5]),
    l2Normalize([0.5, 0.5, 0.5, 1]),
  ];
  const { mean } = intraStats(distintas);
  // 0.857: justo la zona donde caen dos personas distintas de verdad (media
  // medida en LFW: 0.837, p95 0.8915).
  assert.ok(mean > 0.62 && mean < 0.88, `montaje inválido: intraMean ${mean}`);
  assert.equal(enrollmentQuality(distintas).ok, false);
  assert.match(enrollmentQuality(distintas).reason, /misma persona/);
});

test("enrollmentQuality acepta un cluster apretado de 4 capturas", () => {
  const base = l2Normalize([1, 0.02, 0.01, 0.03]);
  const samples = [base, l2Normalize([1, 0.03, 0.02, 0.02]), l2Normalize([1, 0.01, 0.03, 0.04]), l2Normalize([1, 0.02, 0.02, 0.03])];
  assert.deepEqual(enrollmentQuality(samples), { ok: true, reason: "ok" });
});
