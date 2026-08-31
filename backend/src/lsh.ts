import { hmacBucket } from "./crypto.js";

/**
 * LSH de hiperplanos aleatorios.
 *
 * Con planos gaussianos, P(bit coincide) = 1 − arccos(s)/π para similitud coseno s.
 * Con TABLES tablas de BITS bits y consulta exacta, el recall de una identidad
 * genuina es 1 − (1 − p^BITS)^TABLES: ~47 % a coseno 0.60. Demasiado bajo para auth.
 *
 * Se indexa con la clave exacta (`lshKeys`) y se consulta con multi-probe a
 * distancia Hamming 1 (`lshProbeKeys`), que sube el recall a >95 % a coseno 0.60
 * sin ensuciar el índice.
 */
export const LSH_TABLES = 10;
export const LSH_BITS = 8;

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function buildPlanes(seed: string, dim: number): number[][][] {
  const rng = mulberry32(hashSeed(seed));
  return Array.from({ length: LSH_TABLES }, () =>
    Array.from({ length: LSH_BITS }, () => Array.from({ length: dim }, () => gaussian(rng))),
  );
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function bitsOf(vector: number[], table: number[][]): string {
  return table.map((plane) => (dot(vector, plane) >= 0 ? "1" : "0")).join("");
}

function flipBit(bits: string, index: number): string {
  const flipped = bits[index] === "1" ? "0" : "1";
  return bits.slice(0, index) + flipped + bits.slice(index + 1);
}

/** Claves de indexación: una cubeta exacta por tabla. */
export function lshKeys(vector: number[], planes: number[][][], hmacSecret: string): string[] {
  return planes.map((table, tableIndex) =>
    hmacBucket(hmacSecret, tableIndex, bitsOf(vector, table)),
  );
}

/** Claves de consulta: la cubeta exacta más todas las vecinas a Hamming 1. */
export function lshProbeKeys(vector: number[], planes: number[][][], hmacSecret: string): string[] {
  const keys: string[] = [];
  planes.forEach((table, tableIndex) => {
    const bits = bitsOf(vector, table);
    keys.push(hmacBucket(hmacSecret, tableIndex, bits));
    for (let i = 0; i < bits.length; i += 1) {
      keys.push(hmacBucket(hmacSecret, tableIndex, flipBit(bits, i)));
    }
  });
  return keys;
}
