/**
 * Extrae un descriptor de 128-d por imagen de LFW y lo cachea en disco.
 *
 * La extracción es cara (~70 ms/imagen en WASM) y **determinista**: mismo JPEG,
 * mismos modelos, mismo vector. Se cachea en `.eval-data/descriptors/` como
 * Float32 crudo + índice JSON, así que la primera ejecución tarda ~7 min con 6
 * procesos y las siguientes son instantáneas. Ese es el mecanismo que hace
 * reproducible el banco: los números no dependen de volver a correr la red.
 *
 * El sharding es por índice (`i % workers === shard`), no por reparto dinámico,
 * para que cada shard contenga siempre las mismas imágenes.
 */
import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, LFW_DIR, listPeople } from "./dataset.mjs";
import { describeFile } from "./faceapi-node.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DATA_DIR, "descriptors");
export const DIM = 128;

function shardPaths(shard) {
  return {
    bin: path.join(CACHE, `shard-${shard}.bin`),
    idx: path.join(CACHE, `shard-${shard}.json`),
  };
}

async function runShard(shard, workers) {
  const all = [...listPeople().values()].flat();
  const mine = all.filter((_, i) => i % workers === shard);
  const { bin, idx } = shardPaths(shard);
  mkdirSync(CACHE, { recursive: true });
  const values = new Float32Array(mine.length * DIM);
  const names = [];
  let written = 0;
  for (const relative of mine) {
    const descriptor = await describeFile(path.join(LFW_DIR, relative));
    if (!descriptor) continue;
    values.set(descriptor, written * DIM);
    names.push(relative);
    written += 1;
    if (names.length % 200 === 0) process.send?.({ shard, done: names.length, total: mine.length });
  }
  writeFileSync(bin, Buffer.from(values.buffer, 0, written * DIM * 4));
  writeFileSync(idx, JSON.stringify({ shard, workers, total: mine.length, names }));
  process.send?.({ shard, done: names.length, total: mine.length, finished: true });
}

if (process.argv[2] === "--shard") {
  await runShard(Number(process.argv[3]), Number(process.argv[4]));
}

/**
 * `Map<ruta relativa, Float32Array(128)>` con los descriptores de todo LFW.
 * Las imágenes en las que el detector no encuentra cara **no aparecen**: son
 * las que el sistema real tampoco aceptaría, y contarlas como fallo de umbral
 * mezclaría dos cosas distintas.
 */
export async function loadDescriptors({ workers = 6, log = () => {} } = {}) {
  const complete = Array.from({ length: workers }, (_, s) => shardPaths(s)).every(
    ({ bin, idx }) => existsSync(bin) && existsSync(idx),
  );
  if (!complete) {
    log(`extrayendo descriptores con ${workers} procesos (solo la primera vez)`);
    const progress = new Array(workers).fill(0);
    await Promise.all(
      Array.from({ length: workers }, (_, shard) =>
        new Promise((resolve, reject) => {
          const child = fork(path.join(HERE, "descriptors.mjs"), ["--shard", String(shard), String(workers)]);
          child.on("message", (m) => {
            progress[m.shard] = m.done;
            const total = progress.reduce((a, b) => a + b, 0);
            if (total % 1000 < workers) log(`  ${total} imágenes procesadas`);
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shard ${shard} salió con ${code}`))));
        }),
      ),
    );
  }
  const map = new Map();
  for (let shard = 0; shard < workers; shard += 1) {
    const { bin, idx } = shardPaths(shard);
    const { names } = JSON.parse(readFileSync(idx, "utf8"));
    const buffer = readFileSync(bin);
    const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    names.forEach((name, i) => map.set(name, values.subarray(i * DIM, (i + 1) * DIM)));
  }
  return map;
}
