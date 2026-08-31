/**
 * Generador de descriptores sintéticos para medir recall, FAR y FRR sin cámara.
 *
 * **Los sintéticos ya no eligen el umbral.** Eso se hace con caras reales en
 * `npm run eval:threshold` (LFW). Aquí solo se comprueban propiedades del
 * motor —que el índice recupere, que el margen mande, que dos personas no
 * quepan bajo una identidad— con vectores cuyos parámetros están **tomados de
 * esa medición**, no inventados.
 *
 * Modelo: cada identidad es una dirección unitaria `p` en 128-d. Una *condición*
 * (con lentes / sin lentes) desplaza esa dirección a lo largo de un eje `g`
 * ortogonal a `p`; cada captura añade ruido gaussiano.
 *
 * - `crossCosine`: coseno entre los centroides de las dos condiciones.
 * - `withinCosine`: coseno medio entre capturas de la MISMA condición.
 *
 * Los valores medidos están en `MEDIDO`. La versión anterior de este fichero
 * usaba `crossCosine` 0.60–0.62 y `withinCosine` 0.93 "porque en FaceNet-128
 * unos lentes mueven el descriptor a distancia 0.55–0.85". Eso era falso por
 * dos motivos: la conversión distancia→coseno suponía vectores unitarios (no lo
 * son, ‖d‖ = 1.43) y, sobre todo, la separación real entre dos condiciones de
 * la misma persona es 0.98–0.99, no 0.62.
 */
import { cosine, l2Normalize } from "../matcher.js";

export const DIM = 128;

/**
 * Parámetros medidos sobre caras reales (`npm run eval:threshold`, LFW).
 * Cualquier test que necesite un número de estos lo saca de aquí, para que no
 * vuelva a haber constantes sintéticas sueltas contradiciendo la medición.
 */
export const MEDIDO = {
  /**
   * `intraMean` de un enrollo real de una condición. El vault de producción
   * midió 0.956–0.997; cinco fotos de la misma persona en LFW dan 0.9502 (p50)
   * y 0.8877 en el peor caso de 203 identidades.
   */
  withinCosine: 0.96,
  /**
   * Coseno entre los centroides de dos condiciones de la MISMA persona.
   * Producción (con lentes / sin lentes): **0.9907**. Partiendo en dos las
   * fotos de 42 identidades de LFW: media 0.9845, p05 0.9755, mínimo 0.9444.
   */
  crossCosine: 0.98,
  /**
   * Separación cerca del límite de lo que el alta acepta. No se pone en 0.92
   * clavado porque `crossCosine` fija la separación entre los CENTROS y el
   * coseno entre los centroides medidos baja unas milésimas por el ruido de
   * las capturas: a 0.93 el alta ya rebota por 0.9199.
   */
  crossCosineLimite: 0.95,
  /**
   * Calidad del frame de login. Los dos valores están elegidos para que el
   * score resultante (máximo contra centroide + 5 muestras) reproduzca la
   * distribución MEDIDA de los logins genuinos en LFW —2850 probes retenidos,
   * enrollo de 5— que es p05 0.9513, p50 0.9711, p95 0.9829:
   *
   * - `bueno` 0.95 → p50 0.9711, el login típico.
   * - `mediocre` 0.93 → p05 0.9513, la cola mala.
   *
   * El sintético tiene la cola izquierda más corta que la realidad, así que
   * hace falta un valor distinto para cada punto de la distribución; por eso
   * son dos y no uno.
   */
  probeCosine: { bueno: 0.95, mediocre: 0.93 },
  /**
   * Bandas de impostor. Medido en los 6000 pares oficiales de LFW, el coseno
   * entre dos personas distintas es 0.8370 de media, p95 0.8915, p99 0.9093 y
   * máximo 0.9269. La banda `extremo` llega al 0.94 a propósito: por encima del
   * máximo observado, para que el FAR medido no salga trivialmente 0.
   */
  impostor: { parecido: [0.84, 0.9], extremo: [0.9, 0.94] },
} as const;

export function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(next: () => number): number {
  const u = Math.max(next(), Number.EPSILON);
  const v = Math.max(next(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomUnit(next: () => number): number[] {
  return l2Normalize(Array.from({ length: DIM }, () => gaussian(next)));
}

/** Componente de `raw` ortogonal a `base`, normalizada. */
export function orthogonalTo(base: number[], raw: number[]): number[] {
  const projection = cosine(raw, base);
  return l2Normalize(raw.map((value, i) => value - projection * base[i]));
}

/** Vector unitario a coseno exacto `target` respecto a `base`. */
export function atCosine(base: number[], target: number, next: () => number): number[] {
  const orthogonal = orthogonalTo(base, randomUnit(next));
  const sin = Math.sqrt(1 - target * target);
  return l2Normalize(base.map((value, i) => target * value + sin * orthogonal[i]));
}

/**
 * Captura ruidosa alrededor de `center`, con `sigma` elegido para que el coseno
 * medio entre dos capturas quede cerca de `withinCosine`.
 */
export function noisySample(center: number[], sigma: number, next: () => number): number[] {
  return l2Normalize(center.map((value) => value + sigma * gaussian(next)));
}

/** Sigma que produce, aproximadamente, el coseno par a par pedido. */
export function sigmaFor(withinCosine: number): number {
  // Con ruido isotrópico de varianza sigma² por dimensión sobre un unitario,
  // E[cos entre dos capturas] ≈ 1 / (1 + DIM·sigma²).
  return Math.sqrt((1 / withinCosine - 1) / DIM);
}

export type Persona = {
  identity: number[];
  conditionCenters: number[][];
  /** Capturas por condición. */
  samplesByCondition: number[][][];
};

/**
 * Persona con `conditionCount` condiciones separadas a coseno `crossCosine`
 * entre sí, con `perCondition` capturas cada una.
 */
export function makePersona(
  next: () => number,
  options: {
    crossCosine: number;
    withinCosine: number;
    perCondition: number;
    conditionCount?: number;
  },
): Persona {
  const { crossCosine, withinCosine, perCondition, conditionCount = 2 } = options;
  const identity = randomUnit(next);
  const sigma = sigmaFor(withinCosine);

  // Dos centros a coseno `crossCosine` entre sí: p ± α·g con
  // cos = (1 − α²)/(1 + α²)  ⇒  α = sqrt((1 − cos)/(1 + cos)).
  const axis = orthogonalTo(identity, randomUnit(next));
  const alpha = Math.sqrt((1 - crossCosine) / (1 + crossCosine));
  const centers =
    conditionCount === 1
      ? [identity]
      : [
          l2Normalize(identity.map((value, i) => value + alpha * axis[i])),
          l2Normalize(identity.map((value, i) => value - alpha * axis[i])),
        ];

  return {
    identity,
    conditionCenters: centers,
    samplesByCondition: centers.map((center) =>
      Array.from({ length: perCondition }, () => noisySample(center, sigma, next)),
    ),
  };
}
