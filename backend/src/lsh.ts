import { hmacBucket } from "./crypto.js";

const TABLES = 10;
const BITS = 8;

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
  return Array.from({ length: TABLES }, () =>
    Array.from({ length: BITS }, () => Array.from({ length: dim }, () => gaussian(rng))),
  );
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function lshKeys(vector: number[], planes: number[][][], hmacSecret: string): string[] {
  return planes.map((table, tableIndex) => {
    const bits = table.map((plane) => (dot(vector, plane) >= 0 ? "1" : "0")).join("");
    return hmacBucket(hmacSecret, tableIndex, bits);
  });
}
