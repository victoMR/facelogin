import assert from "node:assert/strict";
import test from "node:test";
import { LSH_BITS, LSH_TABLES, buildPlanes, lshKeys, lshProbeKeys } from "../lsh.js";
import { cosine, l2Normalize } from "../matcher.js";

const DIM = 128;
const SECRET = "secreto-de-prueba";
const PLANES = buildPlanes("semilla-de-prueba", DIM);
const TRIALS = 400;

function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  const u = Math.max(next(), Number.EPSILON);
  const v = Math.max(next(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomUnit(next: () => number): number[] {
  return l2Normalize(Array.from({ length: DIM }, () => gaussian(next)));
}

/** Devuelve un vector unitario a coseno `target` exacto respecto a `base`. */
function atCosine(base: number[], target: number, next: () => number): number[] {
  const raw = randomUnit(next);
  const projection = cosine(raw, base);
  const orthogonal = l2Normalize(raw.map((value, i) => value - projection * base[i]));
  const sin = Math.sqrt(1 - target * target);
  return base.map((value, i) => target * value + sin * orthogonal[i]);
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((key) => set.has(key));
}

/** Recall = fracción de probes genuinos que recuperan la cubeta de su identidad. */
function measureRecall(target: number, probeKeys: (vector: number[]) => string[]): number {
  const next = rng(Math.round(target * 1000) + 7);
  let hits = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const identity = randomUnit(next);
    const probe = atCosine(identity, target, next);
    if (intersects(lshKeys(identity, PLANES, SECRET), probeKeys(probe))) hits += 1;
  }
  return hits / TRIALS;
}

const exactProbe = (vector: number[]): string[] => lshKeys(vector, PLANES, SECRET);
const multiProbe = (vector: number[]): string[] => lshProbeKeys(vector, PLANES, SECRET);

test("atCosine genera pares al coseno pedido", () => {
  const next = rng(99);
  for (const target of [0.6, 0.7, 0.82]) {
    const base = randomUnit(next);
    const pair = atCosine(base, target, next);
    assert.ok(Math.abs(cosine(base, pair) - target) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...pair) - 1) < 1e-9);
  }
});

test("lshProbeKeys incluye la cubeta exacta y sus vecinas a Hamming 1", () => {
  const next = rng(3);
  const vector = randomUnit(next);
  const exact = lshKeys(vector, PLANES, SECRET);
  const probe = lshProbeKeys(vector, PLANES, SECRET);
  assert.equal(exact.length, LSH_TABLES);
  assert.equal(probe.length, LSH_TABLES * (1 + LSH_BITS));
  assert.equal(new Set(probe).size, probe.length);
  for (const key of exact) assert.ok(probe.includes(key));
});

/**
 * Se añade 0.95 a la barrida porque **ahí es donde vive un login real**: el
 * coseno genuino medido sobre LFW es 0.9494 de media (p05 0.9137). Los tres
 * valores de antes (0.60 / 0.70 / 0.82) se conservan porque documentan el
 * comportamiento del índice en la zona difícil, pero no describen un login: a
 * coseno 0.60 no hay dos fotos de la misma persona, hay dos personas.
 */
test("multi-probe mejora el recall del índice a coseno 0.60 / 0.70 / 0.82 / 0.95", () => {
  const medido = [0.6, 0.7, 0.82, 0.95].map((target) => ({
    target,
    antes: measureRecall(target, exactProbe),
    despues: measureRecall(target, multiProbe),
  }));

  for (const { target, antes, despues } of medido) {
    console.log(
      `recall coseno ${target.toFixed(2)}: exacto ${(antes * 100).toFixed(1)} % → multi-probe ${(despues * 100).toFixed(1)} %`,
    );
    assert.ok(despues > antes, `multi-probe no mejoró a coseno ${target}`);
  }

  const [c060, c070, c082, c095] = medido;
  // En el punto de operación real el índice ya no es el cuello de botella: la
  // consulta exacta recupera casi siempre y el multi-probe la remata.
  assert.ok(c095.despues > 0.999, `recall multi-probe en el punto de operación: ${c095.despues}`);
  // La implementación original: ~47 % / ~64 % / ~86 %. Inaceptable para un login.
  assert.ok(c060.antes < 0.6, `recall exacto a 0.60 inesperadamente alto: ${c060.antes}`);
  assert.ok(c070.antes < 0.8, `recall exacto a 0.70 inesperadamente alto: ${c070.antes}`);
  assert.ok(c082.antes < 0.95, `recall exacto a 0.82 inesperadamente alto: ${c082.antes}`);

  assert.ok(c060.despues > 0.9, `recall multi-probe a 0.60 insuficiente: ${c060.despues}`);
  assert.ok(c070.despues > 0.95, `recall multi-probe a 0.70 insuficiente: ${c070.despues}`);
  assert.ok(c082.despues > 0.98, `recall multi-probe a 0.82 insuficiente: ${c082.despues}`);

  assert.ok(c060.despues - c060.antes > 0.3, "la ganancia a coseno 0.60 debería ser grande");
});

test("indexar también las muestras sube el recall de una pose fuera del centroide", () => {
  const next = rng(21);
  let soloCentroide = 0;
  let conMuestras = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const centroide = randomUnit(next);
    // Una pose que se aleja del centroide pero sigue cerca de una muestra enrolada.
    const muestra = atCosine(centroide, 0.8, next);
    const probe = atCosine(muestra, 0.85, next);
    const clavesProbe = multiProbe(probe);
    if (intersects(lshKeys(centroide, PLANES, SECRET), clavesProbe)) soloCentroide += 1;
    const conjunto = [...lshKeys(centroide, PLANES, SECRET), ...lshKeys(muestra, PLANES, SECRET)];
    if (intersects(conjunto, clavesProbe)) conMuestras += 1;
  }
  console.log(
    `recall pose lateral: solo centroide ${((soloCentroide / TRIALS) * 100).toFixed(1)} % → con muestras ${((conMuestras / TRIALS) * 100).toFixed(1)} %`,
  );
  assert.ok(conMuestras >= soloCentroide);
  assert.ok(conMuestras / TRIALS > 0.98);
});
