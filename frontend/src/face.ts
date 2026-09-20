import type * as FaceApi from "@vladmandic/face-api";
import type { FaceLandmarks68 } from "@vladmandic/face-api";
import { cachingFetch, markModelLoad, MODEL_URL } from "./models";
import { loadMesh } from "./mesh";
import {
  augmentLevelForCost,
  AUGMENT_BUDGET_MS,
  minAugmentation,
  profile as profileByName,
  profileForLatency,
  type AugmentationLevel,
  type ComputeBackend,
  type DeviceProfile,
} from "./perf";
import { selectBackend, type BackendReport } from "./tfbackend";

export { AUGMENT_BUDGET_MS };
export type { AugmentationLevel };

/**
 * face-api se carga **bajo demanda**, no en el bundle inicial.
 *
 * Son ~1.2 MB minificados (tfjs completo con los backends CPU, WebGL y WASM
 * dentro) que el visitante de la portada no necesita para leer "Entra con tu
 * cara" y decidir si pulsa el botón. Con el `import` estático, todo eso entraba
 * en el chunk de arranque y bloqueaba el primer render.
 *
 * `loadModels()` sigue llamándose al montar la app, así que el prefetch ocurre
 * igual — pero en paralelo con la pantalla ya pintada, no antes de ella.
 */
let api: typeof FaceApi | null = null;
let loading: Promise<void> | null = null;
let modelsReady = false;

async function faceApi(): Promise<typeof FaceApi> {
  api ??= await import("@vladmandic/face-api");
  return api;
}

// ---------------------------------------------------------------------------
// Perfil activo
// ---------------------------------------------------------------------------

/**
 * Se arranca en `medio`, no en `alto`: el perfil real se decide con la latencia
 * medida de las primeras detecciones, y mientras tanto conviene el valor que no
 * castiga a nadie. Empezar en `alto` haría que un teléfono lento pagara al menos
 * un frame a 224/416 con 7 variantes antes de que la medición lo rescatara.
 */
let active: DeviceProfile = profileByName("medio");
let backend: ComputeBackend = "webgl";

export function deviceProfile(): DeviceProfile {
  return active;
}

export function computeBackend(): ComputeBackend {
  return backend;
}

/** La cambia el bucle de captura cuando la ventana de latencias dice otra cosa. */
export function setDeviceProfile(next: DeviceProfile): void {
  active = next;
  // El techo de augmentación es del perfil; la calibración por variante solo
  // puede bajarlo más, nunca subirlo por encima de lo que el perfil permite.
  resolveAugmentation();
}

export type LoadReport = {
  backend: BackendReport;
  profile: DeviceProfile;
  ms: number;
};

let loadReport: LoadReport | null = null;

export function modelReport(): LoadReport | null {
  return loadReport;
}

/**
 * Carga face-api, elige backend verificado y baja los pesos desde nuestro propio
 * origen con caché. Es idempotente y concurrente-segura: dos llamadas a la vez
 * comparten la misma promesa en vez de bajar los pesos dos veces.
 */
export async function loadModels(): Promise<void> {
  if (modelsReady) return;
  loading ??= (async () => {
    const started = performance.now();
    const faceapi = await faceApi();

    /*
     * El `fetch` con caché se instala ANTES de pedir ningún peso, y hay que
     * instalarlo en DOS sitios. Costó una medición descubrirlo:
     *
     * 1. `faceapi.env` — por aquí pasan los **manifiestos** (`*-weights_manifest.json`),
     *    que son 32 kB de los 7 MB.
     * 2. `tf.env().platform.fetch` — por aquí pasan los **shards de pesos**
     *    (`*.bin`), que son los 6.95 MB restantes. face-api delega la carga de
     *    pesos en `tf.io.loadWeights`, y tfjs usa su propio `fetch` de
     *    plataforma, no el de face-api.
     *
     * Con solo el primero, el banco de medición contra 3G daba lo mismo con
     * caché fría que caliente: se cacheaban los manifiestos y se volvía a bajar
     * el 99 % de los bytes en cada visita.
     *
     * Y el `env` de face-api se escribe directamente, **no** con
     * `env.monkeyPatch({ fetch })`: `monkeyPatch` reconstruye
     * `createCanvasElement` como `() => new Canvas()` aunque solo le pases
     * `fetch`, y en el navegador `Canvas` es `HTMLCanvasElement`, así que la
     * siguiente detección muere con "Illegal constructor". Está pensado para
     * Node, donde `Canvas` sí es un constructor.
     */
    faceapi.env.getEnv().fetch = cachingFetch as typeof fetch;
    const platform = (
      faceapi.tf as unknown as { env?: () => { platform?: { fetch?: typeof fetch } } }
    ).env?.()?.platform;
    if (platform) platform.fetch = cachingFetch as typeof fetch;

    const report = await selectBackend(faceapi);
    backend = report.backend;
    /*
     * Perfil de partida: `medio`, acotado por el backend.
     *
     * La primera versión extrapolaba el perfil del coste de la convolución de
     * prueba (`probeMs × 12`) y salía mal: esa convolución paga la compilación
     * del primer shader de WebGL, así que en un M2 medía cientos de milisegundos
     * y aterrizaba en `minimo` — el mejor equipo posible arrancaba con el perfil
     * del peor. Extrapolar de una medida contaminada es peor que no extrapolar:
     * el bucle tiene latencias reales en menos de un segundo.
     */
    setDeviceProfile(profileForLatency(profileByName("medio").frameBudgetMs, report.backend));

    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      loadMesh().catch((error) => {
        console.warn("[facelogin] MediaPipe no cargó; el seguimiento usa face-api.", error);
      }),
    ]);
    modelsReady = true;
    const ms = performance.now() - started;
    markModelLoad(ms);
    loadReport = { backend: report, profile: active, ms };
  })().catch((error) => {
    // Un fallo no debe dejar la promesa memorizada: el botón "Reintentar" tiene
    // que poder volver a intentarlo de verdad.
    loading = null;
    throw error;
  });
  return loading;
}

export type Box = { x: number; y: number; width: number; height: number };

export type TrackedFace = {
  box: Box;
  score: number;
  landmarks: FaceLandmarks68;
  framed: boolean;
  /** 0–1. Combina score de detección, tamaño de caja, frontalidad y nitidez. */
  quality: number;
};

/**
 * Dos detectores, no uno.
 *
 * El seguimiento en vivo solo tiene que decir dónde está la cara: barato y
 * permisivo. La extracción corre una vez por captura y decide la calidad del
 * descriptor que acabará en el vault: cara grande, score alto.
 *
 * Lo que cambió en el pase multi-dispositivo es que el `inputSize` **ya no es
 * una constante**: sale del perfil. 224/416 sigue siendo el valor medido y es el
 * techo; los perfiles lentos lo bajan, ninguno lo sube. Los umbrales de score sí
 * son constantes, porque son parte de la lógica de calidad, no de rendimiento.
 */
const TRACK_SCORE = 0.4;
const EXTRACT_SCORE = 0.6;

/**
 * Dos mínimos de caja, y a propósito distintos:
 *
 * - `MIN_TRACK_BOX` es el mínimo para *seguir* la cara. Se mantiene bajo para
 *   poder dibujar la malla y decirle al usuario "acércate" en vez de quedarnos
 *   mudos.
 * - `MIN_SAMPLE_BOX` es el mínimo para *extraer* un descriptor. Es el que manda
 *   y el único que decide si una captura entra al enrollo.
 */
export const MIN_TRACK_BOX = 64;
export const MIN_SAMPLE_BOX = 80;

function trackingDetector(faceapi: typeof FaceApi) {
  return new faceapi.TinyFaceDetectorOptions({
    inputSize: active.trackInputSize,
    scoreThreshold: TRACK_SCORE,
  });
}

function extractionDetector(faceapi: typeof FaceApi) {
  return new faceapi.TinyFaceDetectorOptions({
    inputSize: active.extractInputSize,
    scoreThreshold: EXTRACT_SCORE,
  });
}

// ---------------------------------------------------------------------------
// Augmentación: la palanca de rendimiento
// ---------------------------------------------------------------------------

/**
 * Se arranca en `light` y se **sube** a `full` si el equipo responde. La
 * decisión vive en `perf.ts` (`augmentLevelForCost`), que es puro y por tanto
 * testeable sin navegador; aquí solo queda el estado y la palanca pública.
 */
let augmentationLevel: AugmentationLevel = "light";
/** Nivel que salió de medir el coste por variante. `null` = todavía no se midió. */
let measuredLevel: AugmentationLevel | null = null;
/** Nivel impuesto desde código con `setAugmentationLevel`. Manda sobre todo lo demás. */
let manualLevel: AugmentationLevel | null = null;

export function getAugmentationLevel(): AugmentationLevel {
  return augmentationLevel;
}

export function setAugmentationLevel(level: AugmentationLevel): void {
  manualLevel = level;
  resolveAugmentation();
}

/**
 * El nivel efectivo se **recalcula**, no se acumula.
 *
 * La primera versión hacía `augmentationLevel = min(augmentationLevel, perfil)`
 * en cada cambio de perfil, y eso es un trinquete: bastaba un instante en
 * `minimo` —por ejemplo, un perfil inicial mal estimado— para que la
 * augmentación quedara en `off` el resto de la sesión aunque el equipo
 * demostrara después que aguanta siete variantes. Derivándolo de sus dos
 * fuentes (lo medido y el techo del perfil) el nivel puede volver a subir
 * cuando el perfil sube.
 */
function resolveAugmentation(): void {
  const forced = manualLevel ?? storedLevel();
  augmentationLevel = forced ?? minAugmentation(measuredLevel ?? "light", active.augment);
}

function storedLevel(): AugmentationLevel | null {
  try {
    const value = localStorage.getItem("facelogin.augment");
    return value === "off" || value === "light" || value === "full" ? value : null;
  } catch {
    return null;
  }
}

/** Coste medido de la última extracción, por variante. Lo usa la UI para estimar el enrollo. */
let lastVariantMs = 0;

export function variantCostMs(): number {
  return lastVariantMs;
}

/**
 * Ajusta el nivel con el coste real **por variante**, acotado además por el
 * techo del perfil: en `bajo` no hay medición que devuelva `full`.
 */
export function calibrateAugmentation(msPorVariante: number): AugmentationLevel {
  measuredLevel = augmentLevelForCost(msPorVariante, null);
  resolveAugmentation();
  return augmentationLevel;
}

type Variant = {
  name: string;
  /** Grados extra de rotación sobre la alineación canónica. */
  rotationDeg: number;
  /** Multiplicador del recorte: >1 recorta más contexto. */
  scale: number;
  mirror: boolean;
  /** Multiplicador de brillo. */
  brightness: number;
  /** Exponente de gamma. */
  gamma: number;
  contrast: number;
};

const IDENTITY: Variant = {
  name: "alineada",
  rotationDeg: 0,
  scale: 1,
  mirror: false,
  brightness: 1,
  gamma: 1,
  contrast: 1,
};

/**
 * Las variantes se generan **sobre el frame**, dentro de la transformación de
 * alineación: rotación y escala son parámetros del recorte, y brillo/gamma/
 * contraste son un filtro sobre el píxel. No se toca el vector de 128-d: un
 * descriptor ya perdió la información que haría falta para sintetizar variantes,
 * y hacerlo solo ensancharía el cluster y subiría el FAR.
 */
const VARIANTS: Record<AugmentationLevel, Variant[]> = {
  off: [IDENTITY],
  light: [
    IDENTITY,
    { ...IDENTITY, name: "espejo", mirror: true },
    { ...IDENTITY, name: "claro", brightness: 1.18, gamma: 0.88 },
  ],
  full: [
    IDENTITY,
    { ...IDENTITY, name: "espejo", mirror: true },
    { ...IDENTITY, name: "claro", brightness: 1.2, gamma: 0.85 },
    { ...IDENTITY, name: "oscuro", brightness: 0.84, gamma: 1.18, contrast: 1.08 },
    { ...IDENTITY, name: "giro+", rotationDeg: 6 },
    { ...IDENTITY, name: "giro-", rotationDeg: -6 },
    { ...IDENTITY, name: "encuadre", scale: 1.09 },
  ],
};

// ---------------------------------------------------------------------------
// Alineación por landmarks
// ---------------------------------------------------------------------------

/**
 * Lado del recorte alineado. La red de reconocimiento reescala a 150×150, así
 * que generar más resolución solo cuesta tiempo.
 */
const ALIGNED_SIZE = 150;

/**
 * El recorte se define con los **ojos**, no con la caja del detector.
 *
 * La caja de TinyFaceDetector baila entre frames varios píxeles; la distancia
 * interocular y el punto medio ojos–boca son mucho más estables. Rotar a roll 0
 * y escalar a distancia interocular fija elimina de raíz una parte grande de la
 * varianza del descriptor — más que cualquier augmentación.
 *
 * `FACE_SPAN` mantiene el encuadre resultante parecido al de la caja del
 * detector (≈3.1 × distancia interocular): la red de reconocimiento se entrenó
 * con recortes de ese estilo y alejarse de él degradaría el descriptor en vez de
 * mejorarlo.
 */
const FACE_SPAN = 3.1;
/** Cuánto se baja el centro desde el punto medio de los ojos hacia la boca. */
const CENTER_DROP = 0.45;

function centroid(points: { x: number; y: number }[]): { x: number; y: number } {
  const n = points.length || 1;
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / n,
    y: points.reduce((sum, p) => sum + p.y, 0) / n,
  };
}

let alignedCanvas: HTMLCanvasElement | null = null;

function scratchCanvas(): HTMLCanvasElement {
  alignedCanvas ??= document.createElement("canvas");
  alignedCanvas.width = ALIGNED_SIZE;
  alignedCanvas.height = ALIGNED_SIZE;
  return alignedCanvas;
}

/** Recorte canónico de la cara: roll 0, escala fija, centrado en ojos–boca. */
export function alignedFace(
  source: CanvasImageSource,
  landmarks: FaceLandmarks68,
  variant: Variant,
): HTMLCanvasElement | null {
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
  const span = interocular * FACE_SPAN * variant.scale;

  const canvas = scratchCanvas();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const zoom = ALIGNED_SIZE / span;
  ctx.save();
  ctx.clearRect(0, 0, ALIGNED_SIZE, ALIGNED_SIZE);
  ctx.translate(ALIGNED_SIZE / 2, ALIGNED_SIZE / 2);
  if (variant.mirror) ctx.scale(-1, 1);
  ctx.rotate(-roll + (variant.rotationDeg * Math.PI) / 180);
  ctx.scale(zoom, zoom);
  ctx.translate(-center.x, -center.y);
  ctx.drawImage(source, 0, 0);
  ctx.restore();

  applyTone(ctx, variant);
  return canvas;
}

/** Brillo, gamma y contraste sobre el recorte ya alineado. */
function applyTone(ctx: CanvasRenderingContext2D, variant: Variant): void {
  if (variant.brightness === 1 && variant.gamma === 1 && variant.contrast === 1) return;
  const image = ctx.getImageData(0, 0, ALIGNED_SIZE, ALIGNED_SIZE);
  const data = image.data;
  // Tabla de 256 entradas: evita pow() por subpíxel (150×150×3 = 67 500 llamadas).
  const table = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let value = (i / 255) * variant.brightness;
    value = Math.pow(Math.max(value, 0), variant.gamma);
    value = (value - 0.5) * variant.contrast + 0.5;
    table[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = table[data[i]];
    data[i + 1] = table[data[i + 1]];
    data[i + 2] = table[data[i + 2]];
  }
  ctx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------------------
// Calidad de captura
// ---------------------------------------------------------------------------

/** Varianza del laplaciano sobre luminancia: proxy barato de enfoque. */
function focusScore(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, ALIGNED_SIZE, ALIGNED_SIZE);
  const gray = new Float32Array(ALIGNED_SIZE * ALIGNED_SIZE);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < ALIGNED_SIZE - 1; y += 2) {
    for (let x = 1; x < ALIGNED_SIZE - 1; x += 2) {
      const i = y * ALIGNED_SIZE + x;
      const lap =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - ALIGNED_SIZE] - gray[i + ALIGNED_SIZE];
      sum += lap;
      sumSq += lap * lap;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const variance = sumSq / count - (sum / count) ** 2;
  // ~150 de varianza ya es una cara nítida; por encima no aporta.
  return Math.min(1, variance / 150);
}

/**
 * Yaw (desplazamiento de la nariz normalizado por la distancia interocular) y
 * roll (radianes) de una cara.
 *
 * Se extrajo de `poseScore` **sin tocar su aritmética**: los mismos dos números
 * que puntúan la frontalidad son los que la interfaz necesita para decir "mira
 * de frente" o "endereza la cabeza", y calcularlos dos veces con fórmulas
 * parecidas-pero-no-iguales es cómo el diagnóstico acaba contradiciendo a la
 * calidad que de verdad se guarda.
 */
export function poseAngles(landmarks: FaceLandmarks68): { yaw: number; roll: number } {
  const leftEye = centroid(landmarks.getLeftEye());
  const rightEye = centroid(landmarks.getRightEye());
  const nose = landmarks.getNose()[3];
  const span = Math.max(rightEye.x - leftEye.x, 1);
  return {
    yaw: Math.abs((nose.x - (leftEye.x + rightEye.x) / 2) / span),
    roll: Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)),
  };
}

/** Frontalidad: 1 mirando de frente, 0 muy girado o inclinado. */
function poseScore(landmarks: FaceLandmarks68): number {
  const { yaw, roll } = poseAngles(landmarks);
  return Math.max(0, 1 - yaw / 0.35) * Math.max(0, 1 - roll / 0.6);
}

/**
 * Calidad de una captura, 0–1. Sirve para dos cosas: descartar frames malos y
 * ordenar los descriptores del login para mandar solo los mejores.
 */
export function captureQuality(
  box: Box,
  score: number,
  landmarks: FaceLandmarks68,
  aligned: HTMLCanvasElement | null,
): number {
  const size = Math.min(1, box.width / 180);
  const focus = aligned ? focusScore(aligned) : 0.5;
  return 0.35 * score + 0.2 * size + 0.25 * poseScore(landmarks) + 0.2 * focus;
}

// ---------------------------------------------------------------------------
// Fotometría en vivo
// ---------------------------------------------------------------------------

/**
 * Lado del parche de cara, en píxeles del frame **sin reescalar**.
 *
 * A resolución nativa y no reescalado, porque la mitad de lo que se mide aquí es
 * nitidez: un parche obtenido reduciendo la cara entera a 96×96 sale nítido
 * aunque la cara esté movida — el reescalado destruye justo la señal que
 * interesa. 96×96 son 9 216 píxeles, un `getImageData` de 36 kB.
 */
const PHOTO_PATCH = 96;

/** Miniatura del frame entero para la luminancia de fondo. 24×24 basta y sobra. */
const PHOTO_THUMB = 24;

let photoCanvas: HTMLCanvasElement | null = null;
let thumbCanvas: HTMLCanvasElement | null = null;
let lastPhotoMs = 0;

/** Coste de la última fotometría. Va a "Rendimiento", para que se pueda auditar. */
export function photometryCostMs(): number {
  return lastPhotoMs;
}

function scratch(which: "photo" | "thumb", size: number): HTMLCanvasElement {
  const existing = which === "photo" ? photoCanvas : thumbCanvas;
  const canvas = existing ?? document.createElement("canvas");
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  if (which === "photo") photoCanvas = canvas;
  else thumbCanvas = canvas;
  return canvas;
}

function meanLuma(data: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4) / 255;
}

/**
 * Luz y nitidez del frame, para el diagnóstico en vivo.
 *
 * **No corre en cada vuelta del bucle**: el llamador la espacia (ver
 * `PHOTO_EVERY` en `FaceCapture`). Es barata —dos `drawImage` pequeños y dos
 * `getImageData`— pero no gratis, y el presupuesto de frame del perfil ya está
 * medido y comprometido. Espaciarla mantiene el coste por debajo del ruido sin
 * perder utilidad: la luz de una habitación no cambia en 200 ms.
 *
 * La luminancia de fondo sale del frame entero, cara incluida. Es a propósito:
 * incluir la cara acerca las dos medias y hace el detector de contraluz más
 * conservador, que es el lado por el que conviene equivocarse.
 */
export function samplePhotometry(
  frame: HTMLCanvasElement,
  box: Box,
): { luma: number; background: number; sharpness: number } | null {
  const started = performance.now();
  const side = Math.round(Math.min(PHOTO_PATCH, Math.max(24, box.width * 0.6)));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const sx = Math.round(Math.min(Math.max(cx - side / 2, 0), Math.max(0, frame.width - side)));
  const sy = Math.round(Math.min(Math.max(cy - side / 2, 0), Math.max(0, frame.height - side)));
  if (side < 8 || frame.width < side || frame.height < side) return null;

  const patch = scratch("photo", side);
  const pctx = patch.getContext("2d", { willReadFrequently: true });
  const thumb = scratch("thumb", PHOTO_THUMB);
  const tctx = thumb.getContext("2d", { willReadFrequently: true });
  if (!pctx || !tctx) return null;

  pctx.drawImage(frame, sx, sy, side, side, 0, 0, side, side);
  tctx.drawImage(frame, 0, 0, PHOTO_THUMB, PHOTO_THUMB);

  const { data } = pctx.getImageData(0, 0, side, side);
  const gray = new Float32Array(side * side);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Mismo laplaciano y misma normalización que `focusScore`, para que "nítido"
  // signifique lo mismo en el aviso en vivo y en la calidad que se guarda.
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < side - 1; y += 1) {
    for (let x = 1; x < side - 1; x += 1) {
      const i = y * side + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - side] - gray[i + side];
      sum += lap;
      sumSq += lap * lap;
      count += 1;
    }
  }
  const variance = count === 0 ? 0 : sumSq / count - (sum / count) ** 2;

  const result = {
    luma: meanLuma(data),
    background: meanLuma(tctx.getImageData(0, 0, PHOTO_THUMB, PHOTO_THUMB).data),
    sharpness: Math.min(1, variance / 150),
  };
  lastPhotoMs = performance.now() - started;
  return result;
}

// ---------------------------------------------------------------------------
// Seguimiento y extracción
// ---------------------------------------------------------------------------

/**
 * Copia el frame actual del vídeo a un canvas propio.
 *
 * Congelando el frame, el liveness, el gate de calidad y el descriptor hablan
 * todos del mismo píxel: antes `extractDescriptor` volvía a detectar sobre un
 * frame NUEVO y el descriptor enviado podía venir de otro instante.
 */
export function grabFrame(
  video: HTMLVideoElement,
  into?: HTMLCanvasElement,
): HTMLCanvasElement | null {
  if (video.readyState < 2 || video.videoWidth < 8) return null;
  const canvas = into ?? document.createElement("canvas");
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  return canvas;
}

/** Seguimiento en vivo: rápido, permisivo, solo para la UI y el liveness. */
export async function trackLandmarks(
  input: HTMLVideoElement | HTMLCanvasElement,
): Promise<TrackedFace | null> {
  if (input instanceof HTMLVideoElement && (input.readyState < 2 || input.videoWidth < 8)) {
    return null;
  }
  const faceapi = await faceApi();
  const result = await faceapi.detectSingleFace(input, trackingDetector(faceapi)).withFaceLandmarks();
  if (!result || result.detection.box.width < MIN_TRACK_BOX) return null;

  const { box, score } = result.detection;
  const dims = sourceDims(input);
  const plain: Box = { x: box.x, y: box.y, width: box.width, height: box.height };
  return {
    box: plain,
    score,
    landmarks: result.landmarks,
    framed: sampleGate(plain, score, dims, false),
    // Sin nitidez: en el bucle en vivo no se paga un getImageData por frame.
    quality: captureQuality(plain, score, result.landmarks, null),
  };
}

export type Extraction = {
  descriptors: number[][];
  quality: number;
  level: AugmentationLevel;
  ms: number;
  /** Desglose por etapa. Es lo que hace medible el pase de rendimiento. */
  detectMs: number;
  alignMs: number;
  describeMs: number;
};

/**
 * Extrae los descriptores de un frame **ya congelado**.
 *
 * Vuelve a detectar con el detector de extracción (más caro y más exigente) y
 * **vuelve a aplicar `sampleGate`** sobre esa detección: bastaba antes con que
 * el frame del liveness pasara el gate para que el descriptor —sacado de otro
 * frame y sin comprobar nada— acabara en el vault.
 */
export async function extractDescriptors(
  frame: HTMLCanvasElement,
  options: { relaxCenter?: boolean; level?: AugmentationLevel } = {},
): Promise<Extraction | null> {
  const faceapi = await faceApi();
  const started = performance.now();
  const result = await faceapi
    .detectSingleFace(frame, extractionDetector(faceapi))
    .withFaceLandmarks();
  const detectMs = performance.now() - started;
  if (!result) return null;

  const { box, score } = result.detection;
  const plain: Box = { x: box.x, y: box.y, width: box.width, height: box.height };
  if (!sampleGate(plain, score, sourceDims(frame), options.relaxCenter ?? false)) return null;

  const level = options.level ?? augmentationLevel;
  const descriptors: number[][] = [];
  let quality = 0;
  let alignMs = 0;
  let describeMs = 0;

  for (const variant of VARIANTS[level]) {
    const alignStart = performance.now();
    const aligned = alignedFace(frame, result.landmarks, variant);
    alignMs += performance.now() - alignStart;
    if (!aligned) continue;
    if (variant === IDENTITY) {
      quality = captureQuality(plain, score, result.landmarks, aligned);
    }
    // El recorte ya viene alineado y recortado: `computeFaceDescriptor` lo toma
    // tal cual y se salta su propia detección.
    const describeStart = performance.now();
    const descriptor = await faceapi.computeFaceDescriptor(aligned);
    describeMs += performance.now() - describeStart;
    if (descriptor instanceof Float32Array) descriptors.push(Array.from(descriptor));
  }

  if (descriptors.length === 0) return null;
  const ms = performance.now() - started;
  // El coste por variante que interesa es el de *producir un descriptor más*,
  // no el de la captura entera: la detección de extracción se paga una sola vez
  // por captura y metida en el promedio haría parecer caras las variantes.
  lastVariantMs = (alignMs + describeMs) / Math.max(descriptors.length, 1);
  if (measuredLevel === null) calibrateAugmentation(lastVariantMs);
  return { descriptors, quality, level, ms, detectMs, alignMs, describeMs };
}

function sourceDims(input: HTMLVideoElement | HTMLCanvasElement): {
  width: number;
  height: number;
} {
  return input instanceof HTMLVideoElement
    ? { width: input.videoWidth, height: input.videoHeight }
    : { width: input.width, height: input.height };
}

export function sampleGate(
  box: Box,
  score: number,
  dims: { width: number; height: number },
  relaxCenter: boolean,
): boolean {
  const slop = relaxCenter ? 0.38 : 0.26;
  const minScore = relaxCenter ? 0.42 : 0.5;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return (
    score >= minScore &&
    box.width >= MIN_SAMPLE_BOX &&
    box.height >= MIN_SAMPLE_BOX &&
    Math.abs(cx - dims.width / 2) < dims.width * slop &&
    Math.abs(cy - dims.height / 2) < dims.height * slop
  );
}
