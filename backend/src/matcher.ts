/**
 * Umbral operativo para el descriptor de 128-d de face-api.
 *
 * ## De dónde sale este número (y por qué el anterior estaba mal)
 *
 * Todo lo anterior se calibró con vectores sintéticos. Con vectores inventados
 * no se puede elegir un umbral: la distribución impostora es la que uno decide
 * al generarla. Estas constantes salen de medir **caras reales** — LFW, 13 233
 * imágenes, 10 641 con detección — con el mismo `@vladmandic/face-api` y el
 * mismo recorte alineado que corre en el navegador. El banco es
 * `npm run eval:threshold` y el informe queda en `scripts/eval/resultados/`.
 *
 * ### El error de aritmética que lo empezó todo
 *
 * El README decía "distancia euclidiana 0.6 ≈ coseno 0.82", y esa equivalencia
 * **solo vale para vectores unitarios**. Los descriptores de face-api no lo
 * son: su norma medida es **‖d‖ = 1.4318** (p01 1.2912, p99 1.6010). Para norma
 * `r`, `d² = 2r²(1 − cos)`, así que el listón de face-api (distancia 0.6)
 * equivale a **coseno 0.912**, no a 0.82. Un coseno de 0.82 es distancia 0.86:
 * casi medio listón por encima de lo que face-api considera "otra persona".
 *
 * ### Lo que hay realmente ahí fuera
 *
 * Sobre los 6000 pares oficiales de LFW (View 2), tras L2-normalizar:
 *
 * | | media | p05 | p50 | p95 | p99 | max |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | genuino  | 0.9494 | 0.9137 | 0.9534 | 0.9767 | — | — |
 * | impostor | 0.8370 | — | 0.8383 | 0.8915 | 0.9093 | 0.9269 |
 *
 * El impostor **medio** puntúa 0.837. Con el umbral anterior (base 0.52, techo
 * 0.72) cualquier desconocido entraba: medido sobre una galería de 3 identidades
 * con el mismo enrollo que tenía el vault de producción, **1500 de 1500**
 * desconocidos fueron aceptados. FPIR = 100 %. No era un umbral laxo, era un
 * umbral que no filtraba nada.
 *
 * ### El punto de operación
 *
 * Se elige por **FPIR** (probe de alguien que NO está en la galería que empareja
 * con alguien), no por EER: en autenticación un falso positivo entrega la
 * cuenta y un falso rechazo se resuelve reintentando. Objetivo: **FPIR ≤ 0.1 %**
 * medido contra 1500 desconocidos reales.
 *
 * FPIR / TPIR medidos (galería de 3, enrollo de 5 muestras, 1500 desconocidos):
 *
 * | umbral | FPIR | TPIR |
 * | --- | --- | --- |
 * | 0.5773 (el que había) | 100 % | 100 % |
 * | 0.90 | 24.5 % | 100 % |
 * | 0.92 | 3.9 % | 100 % |
 * | 0.93 | 0.93 % | 100 % |
 * | 0.94 | 0.13 % | 100 % |
 * | **0.95** | **0.07 %** | **100 %** |
 * | 0.96 | 0.00 % | 100 % |
 *
 * `BASE` es 0.93 —por encima del listón 1:1 de face-api (0.912), porque esto es
 * 1:N y sin vigilancia— y los términos adaptativos lo suben hasta ≈0.955 en el
 * caso real. El EER queda en 3.49 % (coseno 0.8954) y **no** se usa como punto
 * de operación: ahí el FPIR sería del 30 %.
 */
export const BASE_COSINE_THRESHOLD = 0.93;

/**
 * Techo. Por encima de 0.96 el FRR se dispara sin comprar FPIR: medido, pasar
 * de 0.96 a 0.97 con galería de 100 baja el TPIR de 88 % a 57 % y el FPIR se
 * queda igual (0.27 % → 0.07 %). El coste deja de valer la pena ahí.
 */
export const MAX_COSINE_THRESHOLD = 0.96;

/**
 * Suelo. Nunca por debajo del listón 1:1 propio de face-api (coseno 0.912 =
 * distancia 0.6). Todos los términos adaptativos son ≥ 0, así que este suelo
 * solo actúa como red de seguridad si alguien baja `BASE` sin medir.
 */
export const MIN_COSINE_THRESHOLD = 0.92;

/**
 * Coseno mínimo entre centroides de dos condiciones de la misma persona.
 *
 * Estaba en 0.45, y eso era una puerta abierta: **dos personas distintas
 * puntúan 0.837 de media** (p99 0.9093, máximo medido 0.9269). Con 0.45,
 * "también me enrolo con lentes" era la forma trivial de meter a un segundo
 * individuo bajo una sola identidad.
 *
 * 0.92 queda por encima del p99 impostor y por debajo de lo que da la misma
 * persona en dos condiciones distintas: el enrollo multi-condición real del
 * vault de producción midió **0.9907**, y partiendo en dos (2-medias) las fotos
 * de 42 identidades de LFW —años distintos, poses y gafas distintas— la
 * separación entre nubes fue 0.9845 de media, 0.9755 en el p05 y 0.9444 en el
 * peor caso.
 */
export const MIN_INTER_CONDITION_COSINE = 0.92;

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

/**
 * Umbral por sub-cluster.
 *
 * **La señal de `intraStd`/`intraMean` estaba invertida.** La versión anterior
 * premiaba el cluster apretado con un umbral *más estricto* ("más calidad").
 * Un cluster apretado no es calidad: son cinco frames consecutivos de la misma
 * sesión, con la misma luz. Lo que mide es *cobertura*, y la cobertura mueve el
 * umbral en el otro sentido, por las dos puntas a la vez:
 *
 * - **FRR.** El score es `max` sobre las muestras. Un enrollo que solo cubre una
 *   condición da scores genuinos bajos en cuanto cambia la luz o los lentes;
 *   exigirle *más* a esa plantilla es exactamente cómo se rechaza al dueño.
 * - **FAR.** Ese mismo `max` sobre un conjunto de muestras más disperso cubre
 *   más direcciones del espacio, así que el score de un impostor también sube.
 *
 * La dirección era correcta y ahora además está **medida** sobre LFW. Ordenando
 * 120 identidades por lo ancho de su enrollo y midiendo qué score atraen 1500
 * desconocidos contra cada una:
 *
 * | tercio | intraMean | intraStd | p99 impostor |
 * | --- | --- | --- | --- |
 * | más ancho    | 0.9315 | 0.0249 | 0.9266 |
 * | medio        | 0.9500 | 0.0112 | 0.9230 |
 * | más apretado | 0.9618 | 0.0096 | 0.9207 |
 *
 * 0.0059 de p99 por 0.030 de `intraMean` ⇒ coeficiente ≈ 0.20. El 0.22 que ya
 * estaba escrito resulta ser el correcto; lo que estaba mal eran los **topes**,
 * dimensionados para una escala de 0.52 donde sobraba sitio. Con la base en
 * 0.93 solo quedan 0.07 de recorrido hasta 1.0, así que todos los términos se
 * reescalan a lo que de verdad ocupan: `intraMean` real va de 0.89 a 1.00, de
 * modo que la cobertura nunca pasa de ≈0.025 y el tope se pone en 0.03.
 *
 * El margen de identificación se remide igual. Coste en umbral de mantener el
 * FPIR bajo al crecer la galería (1500 desconocidos, enrollo de 5):
 *
 * | galería | FPIR @0.94 | FPIR @0.95 | FPIR @0.96 |
 * | --- | --- | --- | --- |
 * | 1   | 0.00 % | 0.00 % | 0.00 % |
 * | 3   | 0.13 % | 0.07 % | 0.00 % |
 * | 10  | 0.80 % | 0.07 % | 0.00 % |
 * | 100 | 8.87 % | 1.33 % | 0.27 % |
 * | 200 | 17.07 % | 2.87 % | 0.27 % |
 *
 * Con 0.005·log10(N+1)·3 (tope 0.03) el umbral va de 0.93 en galería de uno a
 * 0.96 en galería de cientos, que es justo la curva que pide la tabla.
 */
export function adaptiveThreshold(
  intraMean: number,
  intraStd: number,
  gallerySize: number,
  interConditionCosine: number | null = null,
): number {
  // Cobertura: 1 − intraMean. Un sub-cluster clonado (mean 1) no suma nada.
  const coverage = clamp((1 - intraMean) * 0.22, 0, 0.03);
  const dispersion = clamp(intraStd * 0.3, 0, 0.015);
  // Multi-condición: cuanto más separadas las nubes, más espacio ocupa la
  // identidad. El ancla es 0.95 y no 0.9 porque la separación REAL entre dos
  // condiciones de la misma persona es 0.98–0.99, no 0.6: con el ancla vieja
  // este término era cero siempre y no compensaba nada.
  const spread =
    interConditionCosine === null ? 0 : clamp((0.95 - interConditionCosine) * 0.3, 0, 0.02);
  const identificationMargin =
    gallerySize > 1 ? Math.min(0.03, 0.005 * Math.log10(gallerySize + 1) * 3) : 0;
  return clamp(
    BASE_COSINE_THRESHOLD + coverage + dispersion + spread + identificationMargin,
    MIN_COSINE_THRESHOLD,
    MAX_COSINE_THRESHOLD,
  );
}

/**
 * Acota un umbral ya compuesto (adaptativo + penalizaciones) al rango
 * operativo. Existe porque las penalizaciones se suman **después** de
 * `adaptiveThreshold`, y sin este segundo acotado `MAX_COSINE_THRESHOLD` no
 * sería un techo real: con galería grande y muchas muestras guardadas el umbral
 * se colaba por encima de 0.96 sin comprar nada de FPIR y costando FRR. Medido
 * con galería de 100: el techo colado en 0.9626 daba TPIR 82.5 % con el mismo
 * FPIR (0.267 %) que el techo real en 0.96, que da 88 %.
 */
export function clampThreshold(value: number): number {
  return clamp(value, MIN_COSINE_THRESHOLD, MAX_COSINE_THRESHOLD);
}

/**
 * Penalización por mandar varios descriptores en un mismo `identify`.
 *
 * El servidor se queda con el mejor de los N descriptores, así que el score del
 * impostor es el máximo de N intentos. Sin compensar, mandar más descriptores
 * baja el FRR a costa del FAR.
 *
 * **El coeficiente anterior (0.015·log2 N, tope 0.035) venía de vectores
 * sintéticos donde los N descriptores eran tiradas independientes.** Los del
 * cliente real no lo son: son variantes de augmentación del MISMO frame
 * (espejo, brillo, giro, encuadre) y están casi pegadas — medido, el espejo
 * queda a coseno 0.992 de la identidad y la variante "claro" a 0.9996.
 *
 * Medido con las variantes de verdad, galería de 100, 1000 desconocidos:
 *
 * | descriptores | p99 impostor | p05 dueño |
 * | --- | --- | --- |
 * | 1 | 0.9511 | 0.9516 |
 * | 3 | 0.9516 | 0.9551 |
 * | 7 | 0.9550 | 0.9555 |
 *
 * Pasar de 1 a 7 sube al impostor 0.0039. Ese es el tamaño real de la
 * penalización, un orden de magnitud menos que 0.035 — que en la escala nueva
 * habría rechazado al dueño en cada login.
 */
export function multiProbePenalty(probeCount: number): number {
  if (probeCount <= 1) return 0;
  return Math.min(0.005, 0.0015 * Math.log2(probeCount));
}

/**
 * Penalización por el `max` sobre las **muestras guardadas**.
 *
 * `multiProbePenalty` cubría los descriptores del *probe*, pero no había nada
 * para el otro lado: el motor puntúa con `max` sobre el centroide **y cada
 * muestra almacenada** de cada condición. La plantilla real del vault guardaba
 * 2 condiciones × 15 muestras = 32 comparaciones por probe, y el máximo de 32
 * intentos también infla al impostor.
 *
 * El efecto es real pero **mucho menor de lo que parece**, porque las muestras
 * de una misma persona están muy correlacionadas entre sí. Aislado (centroide
 * fijo de 5, galería de 38 identidades con ≥22 fotos, 1500 desconocidos):
 *
 * | muestras almacenadas | p50 impostor | p99 impostor |
 * | --- | --- | --- |
 * | 0 (solo centroide) | 0.9182 | 0.9481 |
 * | 5  | 0.9196 | 0.9488 |
 * | 10 | 0.9208 | 0.9501 |
 * | 20 | 0.9226 | 0.9520 |
 *
 * 20 muestras suben el p99 impostor 0.0039. `0.001·log2(1+K)` con tope 0.005
 * sigue esa curva por arriba (K=20 → 0.0044), que es el lado seguro.
 */
export function storedSamplesPenalty(sampleCount: number): number {
  if (sampleCount <= 1) return 0;
  return Math.min(0.005, 0.001 * Math.log2(1 + sampleCount));
}

/**
 * Coherencia de **un** sub-cluster. Se aplica por condición y nunca sobre la
 * mezcla de todas: un enrollo legítimo con lentes + sin lentes baja la media
 * global por diseño, y medirlo en bloque rechazaría justo los enrollos que más
 * falta hacen.
 *
 * Los dos límites también estaban calibrados a ojo y también eran demasiado
 * laxos. Medido sobre LFW: cinco fotos de la **misma** persona dan intraMean
 * 0.9502 (p50), 0.9140 (p05) y 0.8877 en el peor caso de 203 identidades;
 * cinco fotos de cinco personas **distintas** dan como mucho 0.8702. El gate
 * anterior (0.62) aceptaba sin pestañear un "enrollo" de cinco desconocidos.
 * El enrollo real es además de una sola sesión y mide 0.956–0.997, así que 0.88
 * le deja muchísimo margen.
 *
 * `intraStd` de la misma persona: p95 0.0426, máximo 0.0787. El límite pasa de
 * 0.14 a 0.10.
 */
export function enrollmentQuality(samples: number[][]): { ok: boolean; reason: string } {
  if (samples.length < 4) {
    return { ok: false, reason: "Se necesitan al menos 4 capturas válidas de la misma persona." };
  }
  const { mean, std } = intraStats(samples);
  if (mean < 0.88) {
    return { ok: false, reason: "Las capturas no parecen de la misma persona. Repite el enrollo con mejor luz." };
  }
  if (std > 0.1) {
    return { ok: false, reason: "Hay demasiada variación entre capturas. Mantén una distancia estable a la cámara." };
  }
  return { ok: true, reason: "ok" };
}

export type ConditionSamples = { label: string; samples: number[][] };

/**
 * Calidad de un enrollo multi-condición.
 *
 * 1. Cada condición tiene que ser un cluster por sí misma (`enrollmentQuality`).
 * 2. Los centroides de las condiciones tienen que seguir siendo *la misma cara*
 *    (`MIN_INTER_CONDITION_COSINE`). Sin esta segunda comprobación, "usa lentes"
 *    sería una forma trivial de meter a dos personas bajo una sola identidad.
 */
export function enrollmentQualityByCondition(conditions: ConditionSamples[]): {
  ok: boolean;
  reason: string;
} {
  if (conditions.length === 0) {
    return { ok: false, reason: "No se recibió ninguna condición de captura." };
  }
  const labels = new Set<string>();
  for (const condition of conditions) {
    if (labels.has(condition.label)) {
      return { ok: false, reason: `La condición "${condition.label}" está repetida.` };
    }
    labels.add(condition.label);
    const quality = enrollmentQuality(condition.samples);
    if (!quality.ok) {
      return { ok: false, reason: `[${condition.label}] ${quality.reason}` };
    }
  }

  const centroids = conditions.map((condition) => meanVector(condition.samples));
  for (let i = 0; i < centroids.length; i += 1) {
    for (let j = i + 1; j < centroids.length; j += 1) {
      const similarity = cosine(centroids[i], centroids[j]);
      if (similarity < MIN_INTER_CONDITION_COSINE) {
        return {
          ok: false,
          reason:
            `Las capturas de "${conditions[i].label}" y "${conditions[j].label}" no parecen de la misma persona ` +
            `(similitud ${similarity.toFixed(2)}). Repite el enrollo tú solo frente a la cámara.`,
        };
      }
    }
  }
  return { ok: true, reason: "ok" };
}

/** Coseno mínimo entre centroides de condiciones. `null` si solo hay una. */
export function interConditionCosine(centroids: number[][]): number | null {
  if (centroids.length < 2) return null;
  let min = 1;
  for (let i = 0; i < centroids.length; i += 1) {
    for (let j = i + 1; j < centroids.length; j += 1) {
      min = Math.min(min, cosine(centroids[i], centroids[j]));
    }
  }
  return min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
