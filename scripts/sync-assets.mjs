#!/usr/bin/env node
/**
 * Copia a `frontend/public/` los binarios que la app necesita servir **desde su
 * propio origen**: los pesos de face-api y los `.wasm` del backend WASM de tfjs.
 *
 * Por qué un script y no archivos commiteados:
 *
 * - Son 7.6 MB de binarios. En git envejecen mal y se desincronizan de la
 *   versión del paquete en cuanto alguien actualiza `@vladmandic/face-api`.
 * - Copiándolos desde `node_modules` la versión de los pesos y la del código que
 *   los interpreta **no pueden divergir**, que es exactamente el fallo que un
 *   CDN con `@latest` produce en silencio.
 *
 * Se ejecuta solo en `predev`, `prebuild` y `pretest` del workspace frontend.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "frontend", "public");

/** Solo las tres redes que la app usa. Las otras cuatro del paquete son 6 MB de más. */
const MODELS = [
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model.bin",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model.bin",
];

/**
 * `tfjs-backend-wasm.wasm` es el fallback sin SIMD; `-simd` es el que toca en
 * cualquier navegador de esta década. El `-threaded-simd` solo entra si la
 * página está cross-origin isolated (COOP/COEP), que aquí no lo está: se copia
 * igualmente para que `setWasmPaths` no tenga un hueco si mañana se activa.
 */
const WASM = [
  ["dist", "tfjs-backend-wasm.wasm"],
  ["dist", "tfjs-backend-wasm-simd.wasm"],
  ["dist", "tfjs-backend-wasm-threaded-simd.wasm"],
  ["wasm-out", "tfjs-backend-wasm-threaded-simd.worker.js"],
];

function copyInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return statSync(to).size;
}

let total = 0;
const digests = {};

const modelSrc = join(root, "node_modules", "@vladmandic", "face-api", "model");
for (const name of MODELS) {
  const from = join(modelSrc, name);
  if (!existsSync(from)) throw new Error(`Falta ${from}. ¿Corriste npm install?`);
  const to = join(publicDir, "models", name);
  total += copyInto(from, to);
  digests[`/models/${name}`] = createHash("sha256").update(readFileSync(to)).digest("base64");
}

const wasmSrc = join(root, "node_modules", "@tensorflow", "tfjs-backend-wasm");
for (const [dir, name] of WASM) {
  const from = join(wasmSrc, dir, name);
  if (!existsSync(from)) continue;
  total += copyInto(from, join(publicDir, "tfjs", name));
}

/**
 * Huellas de los pesos. No son SRI de `<script>` (estos binarios los pide
 * `fetch`, no una etiqueta), pero sirven para lo mismo: la caché los verifica
 * antes de servir una entrada, así que un blob corrupto o manipulado en el
 * `CacheStorage` del navegador se descarta en vez de acabar en la red neuronal.
 */
const mpWasm = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
if (existsSync(mpWasm)) {
  for (const name of readdirSync(mpWasm)) {
    const from = join(mpWasm, name);
    if (!statSync(from).isFile()) continue;
    total += copyInto(from, join(publicDir, "mediapipe", "wasm", name));
  }
}

const TASK_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const taskDest = join(publicDir, "mediapipe", "face_landmarker.task");
if (!existsSync(taskDest) || statSync(taskDest).size < 1_000_000) {
  const response = await fetch(TASK_URL);
  if (!response.ok) throw new Error(`No se pudo bajar Face Landmarker (${response.status}).`);
  mkdirSync(dirname(taskDest), { recursive: true });
  writeFileSync(taskDest, Buffer.from(await response.arrayBuffer()));
}
total += statSync(taskDest).size;
digests["/mediapipe/face_landmarker.task"] = createHash("sha256").update(readFileSync(taskDest)).digest("base64");

writeFileSync(
  join(root, "frontend", "src", "model-digests.json"),
  `${JSON.stringify(digests, null, 2)}\n`,
);

const mb = (total / 1024 / 1024).toFixed(1);
console.log(`[sync-assets] ${MODELS.length} pesos + wasm + malla 478 en frontend/public (${mb} MB)`);
