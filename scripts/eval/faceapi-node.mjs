/**
 * `@vladmandic/face-api` corriendo en Node, con **el mismo pipeline que el
 * navegador**: TinyFaceDetector (inputSize 416, score 0.6) → landmarks 68 →
 * recorte alineado por ojos 150×150 → `computeFaceDescriptor`.
 *
 * Sin `canvas` ni `tfjs-node`: los modelos se cargan desde el disco
 * (`frontend/public/models`, los mismos binarios verificados por SHA-256 que
 * sirve el front) y el recorte alineado se hace con muestreo bilineal en JS,
 * replicando exactamente la transformación afín de `alignedFace()`.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

/** Mismos valores que el perfil `alto`/`medio` de `frontend/src/perf.ts`. */
export const EXTRACT_INPUT_SIZE = 416;
export const EXTRACT_SCORE = 0.6;
/** Constantes de alineación copiadas de `frontend/src/face.ts`. */
const ALIGNED_SIZE = 150;
const FACE_SPAN = 3.1;
const CENTER_DROP = 0.45;

let faceapi = null;

export async function loadFaceApi() {
  if (faceapi) return faceapi;
  const api = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
  const { setWasmPaths } = require("@tensorflow/tfjs-backend-wasm");
  const wasmDir =
    path.join(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm/package.json")), "dist") +
    path.sep;
  setWasmPaths(wasmDir);
  await api.tf.setBackend("wasm");
  await api.tf.ready();

  const models = path.join(ROOT, "frontend", "public", "models");
  await api.nets.tinyFaceDetector.loadFromDisk(models);
  await api.nets.faceLandmark68Net.loadFromDisk(models);
  await api.nets.faceRecognitionNet.loadFromDisk(models);
  faceapi = api;
  return api;
}

/** JPEG → {data: Uint8ClampedArray RGBA, width, height}. */
export function decodeJpeg(file) {
  const jpeg = require("jpeg-js");
  return jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
}

function centroid(points) {
  const n = points.length || 1;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / n, y: y / n };
}

/**
 * Recorte canónico 150×150, equivalente pixel a pixel al `alignedFace()` del
 * front para la variante identidad: se invierte la misma matriz afín
 * (translate 75 → rotate −roll → scale zoom → translate −centro) y se muestrea
 * el origen con bilineal. Fuera de la imagen se devuelve 0, igual que el canvas
 * transparente del navegador.
 */
export const IDENTITY = {
  name: "identidad", mirror: false, rotationDeg: 0, scale: 1, brightness: 1, gamma: 1, contrast: 1,
};
/** Nivel `light` de `frontend/src/face.ts`: es el que corre en el perfil por defecto. */
export const VARIANTS_LIGHT = [
  IDENTITY,
  { ...IDENTITY, name: "espejo", mirror: true },
  { ...IDENTITY, name: "claro", brightness: 1.18, gamma: 0.88 },
];

/** Misma tabla de tono que `applyTone()` del front. */
function toneTable(variant) {
  if (variant.brightness === 1 && variant.gamma === 1 && variant.contrast === 1) return null;
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = (i / 255) * variant.brightness;
    value = Math.pow(Math.max(value, 0), variant.gamma);
    value = (value - 0.5) * variant.contrast + 0.5;
    table[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
  }
  return table;
}

export function alignedPixels(image, landmarks, variant = IDENTITY) {
  const leftEye = centroid(landmarks.getLeftEye());
  const rightEye = centroid(landmarks.getRightEye());
  const mouth = centroid(landmarks.getMouth());
  const interocular = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (!Number.isFinite(interocular) || interocular < 8) return null;

  const eyeMid = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const center = {
    x: eyeMid.x + CENTER_DROP * (mouth.x - eyeMid.x),
    y: eyeMid.y + CENTER_DROP * (mouth.y - eyeMid.y),
  };
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const zoom = ALIGNED_SIZE / (interocular * FACE_SPAN * variant.scale);
  // El canvas aplica rotate(−roll + giro) y, si hay espejo, scale(−1, 1) ANTES.
  const angle = roll - (variant.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const mirror = variant.mirror ? -1 : 1;
  const table = toneTable(variant);

  const { data, width, height } = image;
  const out = new Float32Array(ALIGNED_SIZE * ALIGNED_SIZE * 3);
  for (let dy = 0; dy < ALIGNED_SIZE; dy += 1) {
    const v = (dy + 0.5 - ALIGNED_SIZE / 2) / zoom;
    for (let dx = 0; dx < ALIGNED_SIZE; dx += 1) {
      const u = (mirror * (dx + 0.5 - ALIGNED_SIZE / 2)) / zoom;
      const sx = center.x + cos * u - sin * v - 0.5;
      const sy = center.y + sin * u + cos * v - 0.5;
      const o = (dy * ALIGNED_SIZE + dx) * 3;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * width + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + width * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c += 1) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        const value = top * (1 - fy) + bottom * fy;
        out[o + c] = table ? table[Math.round(Math.min(255, Math.max(0, value)))] : value;
      }
    }
  }
  return out;
}

function toTensor(api, image) {
  const { data, width, height } = image;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
    rgb[i * 3] = data[j];
    rgb[i * 3 + 1] = data[j + 1];
    rgb[i * 3 + 2] = data[j + 2];
  }
  return api.tf.tensor3d(rgb, [height, width, 3]);
}

/**
 * Descriptor de 128-d de la cara más prominente del JPEG, o `null` si el
 * detector no la encuentra (imagen que el sistema real tampoco aceptaría).
 */
/**
 * Un descriptor por variante de augmentación (por defecto, solo la identidad).
 * Devuelve `null` si el detector no encuentra cara: esa imagen tampoco habría
 * pasado el gate de extracción del navegador.
 */
export async function describeFile(file, variants = [IDENTITY]) {
  const api = await loadFaceApi();
  const image = decodeJpeg(file);
  const input = toTensor(api, image);
  try {
    const result = await api
      .detectSingleFace(
        input,
        new api.TinyFaceDetectorOptions({
          inputSize: EXTRACT_INPUT_SIZE,
          scoreThreshold: EXTRACT_SCORE,
        }),
      )
      .withFaceLandmarks();
    if (!result) return null;
    const out = [];
    for (const variant of variants) {
      const pixels = alignedPixels(image, result.landmarks, variant);
      if (!pixels) return null;
      const aligned = api.tf.tensor3d(pixels, [ALIGNED_SIZE, ALIGNED_SIZE, 3]);
      try {
        const descriptor = await api.computeFaceDescriptor(aligned);
        if (!(descriptor instanceof Float32Array)) return null;
        out.push(Array.from(descriptor));
      } finally {
        aligned.dispose();
      }
    }
    return variants.length === 1 ? out[0] : out;
  } finally {
    input.dispose();
  }
}
