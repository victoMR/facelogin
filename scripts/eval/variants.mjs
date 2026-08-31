/**
 * Descriptores de las **variantes de augmentación** para un conjunto de probes.
 *
 * Sirve para medir `multiProbePenalty` con datos reales: el cliente manda
 * varios descriptores del mismo frame y el servidor se queda con el mejor, así
 * que el score del impostor es el máximo de N. Cuánto sube ese máximo depende
 * de lo correlacionadas que estén las variantes, y eso solo se sabe midiéndolo
 * con las variantes de verdad (espejo, brillo, giro, encuadre), no con tiradas
 * independientes.
 */
import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, LFW_DIR } from "./dataset.mjs";
import { IDENTITY, describeFile } from "./faceapi-node.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DATA_DIR, "variantes");
const LIST = path.join(CACHE, "files.json");
export const DIM = 128;

/** Nivel `full` de `frontend/src/face.ts`. Las 3 primeras son el nivel `light`. */
export const VARIANTS = [
  IDENTITY,
  { ...IDENTITY, name: "espejo", mirror: true },
  { ...IDENTITY, name: "claro", brightness: 1.2, gamma: 0.85 },
  { ...IDENTITY, name: "oscuro", brightness: 0.84, gamma: 1.18, contrast: 1.08 },
  { ...IDENTITY, name: "giro+", rotationDeg: 6 },
  { ...IDENTITY, name: "giro-", rotationDeg: -6 },
  { ...IDENTITY, name: "encuadre", scale: 1.09 },
];

const paths = (shard) => ({
  bin: path.join(CACHE, `shard-${shard}.bin`),
  idx: path.join(CACHE, `shard-${shard}.json`),
});

async function runShard(shard, workers) {
  const files = JSON.parse(readFileSync(LIST, "utf8"));
  const mine = files.filter((_, i) => i % workers === shard);
  const values = new Float32Array(mine.length * VARIANTS.length * DIM);
  const names = [];
  for (const relative of mine) {
    const list = await describeFile(path.join(LFW_DIR, relative), VARIANTS);
    if (!list) continue;
    for (let v = 0; v < VARIANTS.length; v += 1) {
      values.set(list[v], (names.length * VARIANTS.length + v) * DIM);
    }
    names.push(relative);
  }
  const { bin, idx } = paths(shard);
  writeFileSync(bin, Buffer.from(values.buffer, 0, names.length * VARIANTS.length * DIM * 4));
  writeFileSync(idx, JSON.stringify({ shard, names }));
}

if (process.argv[2] === "--shard") {
  await runShard(Number(process.argv[3]), Number(process.argv[4]));
}

/** `Map<ruta, number[][]>`: una lista de 7 descriptores por imagen. */
export async function loadVariants(files, { workers = 6, log = () => {} } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const previous = existsSync(LIST) ? readFileSync(LIST, "utf8") : null;
  const wanted = JSON.stringify(files);
  const complete =
    previous === wanted &&
    Array.from({ length: workers }, (_, s) => paths(s)).every(({ bin, idx }) => existsSync(bin) && existsSync(idx));
  if (!complete) {
    writeFileSync(LIST, wanted);
    log(`extrayendo ${VARIANTS.length} variantes de ${files.length} probes (solo la primera vez)`);
    await Promise.all(
      Array.from({ length: workers }, (_, shard) =>
        new Promise((resolve, reject) => {
          fork(path.join(HERE, "variants.mjs"), ["--shard", String(shard), String(workers)]).on(
            "exit",
            (code) => (code === 0 ? resolve() : reject(new Error(`shard ${shard} salió con ${code}`))),
          );
        }),
      ),
    );
  }
  const map = new Map();
  for (let shard = 0; shard < workers; shard += 1) {
    const { bin, idx } = paths(shard);
    const { names } = JSON.parse(readFileSync(idx, "utf8"));
    const buffer = readFileSync(bin);
    const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    names.forEach((name, i) => {
      const base = i * VARIANTS.length * DIM;
      map.set(
        name,
        VARIANTS.map((_, v) => Array.from(values.subarray(base + v * DIM, base + (v + 1) * DIM))),
      );
    });
  }
  return map;
}
