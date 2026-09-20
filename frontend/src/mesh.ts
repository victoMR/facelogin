import type { Box } from "./face";

/**
 * Malla 3D en el cliente: MediaPipe Face Landmarker (478 puntos + blendshapes +
 * matriz de pose). No es Face ID —no hay TrueDepth ni enclave— pero es el mapa
 * geométrico que se puede calcular desde una webcam.
 *
 * La identidad sigue siendo FaceNet 128 (face-api). Esto sustituye el
 * seguimiento 68 + EAR, que no veía un cierre de ojos real.
 */

export const SHAPE_DIM = 64;
export const MESH_WASM_URL = "/mediapipe/wasm";
export const MESH_MODEL_URL = "/mediapipe/face_landmarker.task";

/**
 * 21 puntos estables (nariz, ojos, boca, mentón, pómulos) × xyz = 63, más un
 * pad. Se alinean a la cara canónica para que un giro no cambie la firma.
 */
export const SHAPE_INDICES = [
  1, 4, 6, 10, 33, 133, 263, 362, 61, 291, 13, 14, 152, 234, 454, 127, 356, 168, 199, 98, 327,
] as const;

export type MeshPoint = { x: number; y: number; z: number };

export type FaceMesh = {
  box: Box;
  score: number;
  points: MeshPoint[];
  pixels: MeshPoint[];
  blinkLeft: number;
  blinkRight: number;
  yaw: number;
  pitch: number;
  roll: number;
  depthRelief: number;
  irisOffset: number;
  /** Apertura y gestos de boca (0–1). Sirve para el reto de palabras. */
  mouth: number;
  matrix: number[] | null;
};

type Landmarker = {
  detectForVideo: (
    image: HTMLCanvasElement | HTMLVideoElement,
    timestamp: number,
  ) => {
    faceLandmarks: { x: number; y: number; z: number }[][];
    faceBlendshapes: { categories: { categoryName: string; score: number }[] }[];
    facialTransformationMatrixes: { rows: number; columns: number; data: number[] }[];
  };
  close: () => void;
};

let landmarker: Landmarker | null = null;
let loading: Promise<void> | null = null;

export function meshReady(): boolean {
  return landmarker !== null;
}

export async function loadMesh(): Promise<void> {
  if (landmarker) return;
  loading ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(MESH_WASM_URL);
    const options = {
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    };
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MESH_MODEL_URL, delegate: "GPU" },
      });
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MESH_MODEL_URL, delegate: "CPU" },
      });
    }
  })();
  await loading;
}

export function trackMesh(
  source: HTMLCanvasElement | HTMLVideoElement,
  timestamp: number,
): FaceMesh | null {
  if (!landmarker) return null;
  const width =
    source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const height =
    source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (width < 8 || height < 8) return null;
  try {
    const result = landmarker.detectForVideo(source, timestamp);
    const points = result.faceLandmarks[0];
    if (!points || points.length < 400) return null;
    const blends = result.faceBlendshapes[0]?.categories ?? [];
    const matrix = result.facialTransformationMatrixes[0]?.data ?? null;
    return buildMesh(points, blends, matrix, width, height);
  } catch {
    return null;
  }
}

export function buildMesh(
  points: { x: number; y: number; z: number }[],
  blends: { categoryName: string; score: number }[],
  matrix: number[] | null,
  width: number,
  height: number,
): FaceMesh {
  const blinkLeft = blend(blends, "eyeBlinkLeft");
  const blinkRight = blend(blends, "eyeBlinkRight");
  const pose = poseFromMatrix(matrix);
  const landmarkYaw = meshYaw(points);
  return {
    box: meshBox(points, width, height),
    score: 1,
    points,
    pixels: points.map((point) => ({
      x: point.x * width,
      y: point.y * height,
      z: point.z,
    })),
    blinkLeft,
    blinkRight,
    // El yaw de los gestos usa las mismas unidades que face-api (nariz / ojos),
    // no los radianes de la matriz: si no, 0.18 ya no significa “gira”.
    yaw: landmarkYaw,
    pitch: pose?.pitch ?? 0,
    roll: pose?.roll ?? meshRoll(points),
    depthRelief: depthRelief(points),
    irisOffset: irisOffset(points),
    mouth: mouthArticulation(blends),
    matrix,
  };
}

export function blend(blends: { categoryName: string; score: number }[], name: string): number {
  const found = blends.find((item) => item.categoryName === name);
  return found ? Math.min(1, Math.max(0, found.score)) : 0;
}

/**
 * Articulación labial marcada: mandíbula + embudo + puckering + comisuras.
 * Una foto o un vídeo mudo casi no recorre este rango; decir “rimbombante” sí.
 */
export function mouthArticulation(blends: { categoryName: string; score: number }[]): number {
  const jaw = blend(blends, "jawOpen");
  const funnel = blend(blends, "mouthFunnel");
  const pucker = blend(blends, "mouthPucker");
  const lower =
    (blend(blends, "mouthLowerDownLeft") + blend(blends, "mouthLowerDownRight")) / 2;
  const smile = (blend(blends, "mouthSmileLeft") + blend(blends, "mouthSmileRight")) / 2;
  return Math.min(1, jaw * 0.42 + funnel * 0.22 + pucker * 0.18 + lower * 0.12 + smile * 0.06);
}

/** 1 = ojos abiertos, 0 = cerrados. Misma escala que el EAR histórico. */
export function opennessFromBlink(left: number, right: number): { raw: number; left: number; right: number } {
  return {
    left: 1 - left,
    right: 1 - right,
    raw: 1 - (left + right) / 2,
  };
}

export function lookingAtCamera(mesh: FaceMesh, yawLimit = 0.24): boolean {
  return mesh.irisOffset < 0.28 && Math.abs(mesh.yaw) < yawLimit;
}

export function meshBox(points: MeshPoint[], width: number, height: number): Box {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const pad = 0.04;
  const x = Math.max(0, minX - pad) * width;
  const y = Math.max(0, minY - pad) * height;
  return {
    x,
    y,
    width: Math.min(width - x, (maxX - minX + pad * 2) * width),
    height: Math.min(height - y, (maxY - minY + pad * 2) * height),
  };
}

/** Yaw de la malla: nariz vs centro de los ojos, como el 68-point. */
export function meshYaw(points: MeshPoint[]): number {
  const nose = points[1];
  const left = points[33];
  const right = points[263];
  if (!nose || !left || !right) return 0;
  const span = Math.max(right.x - left.x, 1e-3);
  return -((nose.x - (left.x + right.x) / 2) / span);
}

export function meshRoll(points: MeshPoint[]): number {
  const left = points[33];
  const right = points[263];
  if (!left || !right) return 0;
  return Math.atan2(right.y - left.y, right.x - left.x);
}

/**
 * Relieves de profundidad: la nariz debe estar más cerca (z más negativo) que
 * las orejas. Una foto plana a veces sigue “inventando” Z; por eso esto solo
 * refuerza, no decide solo.
 */
export function depthRelief(points: MeshPoint[]): number {
  const nose = points[1]?.z;
  const left = points[234]?.z;
  const right = points[454]?.z;
  if (nose === undefined || left === undefined || right === undefined) return 0;
  return Math.max(0, (left + right) / 2 - nose);
}

/** Desviación de los iris respecto al centro del ojo. 0 = mira a cámara. */
export function irisOffset(points: MeshPoint[]): number {
  const right = gaze(points[33], points[133], points[468]);
  const left = gaze(points[263], points[362], points[473]);
  return Math.max(right, left);
}

function gaze(outer?: MeshPoint, inner?: MeshPoint, iris?: MeshPoint): number {
  if (!outer || !inner || !iris) return 1;
  const mid = (outer.x + inner.x) / 2;
  const width = Math.max(Math.abs(inner.x - outer.x), 1e-3);
  return Math.abs(iris.x - mid) / width;
}

export function poseFromMatrix(matrix: number[] | null): { yaw: number; pitch: number; roll: number } | null {
  if (!matrix || matrix.length < 16) return null;
  const r00 = matrix[0];
  const r02 = matrix[2];
  const r10 = matrix[4];
  const r11 = matrix[5];
  const r12 = matrix[6];
  const r22 = matrix[10];
  return {
    yaw: Math.atan2(r02, r22),
    pitch: Math.atan2(-r12, Math.hypot(r00, r22) || 1e-3),
    roll: Math.atan2(r10, r11),
  };
}

export function shapeSignature(points: MeshPoint[], matrix: number[] | null = null): number[] {
  if (points.length < 400) return [];
  const picked = SHAPE_INDICES.map((index) => points[index]).filter(Boolean);
  if (picked.length < 16) return [];

  const aligned = matrix && matrix.length >= 16 ? picked.map((point) => invert(point, matrix)) : picked;
  const mid = {
    x: aligned.reduce((sum, point) => sum + point.x, 0) / aligned.length,
    y: aligned.reduce((sum, point) => sum + point.y, 0) / aligned.length,
    z: aligned.reduce((sum, point) => sum + point.z, 0) / aligned.length,
  };
  const left = points[33];
  const right = points[263];
  const scale = Math.max(
    Math.hypot(right.x - left.x, right.y - left.y, (right.z ?? 0) - (left.z ?? 0)),
    1e-3,
  );

  const out: number[] = [];
  for (const point of aligned) {
    out.push((point.x - mid.x) / scale, (point.y - mid.y) / scale, (point.z - mid.z) / scale);
  }
  while (out.length < SHAPE_DIM) out.push(0);
  return out.slice(0, SHAPE_DIM);
}

export function meanShape(shapes: number[][]): number[] {
  const usable = shapes.filter((shape) => shape.length === SHAPE_DIM);
  if (usable.length === 0) return [];
  const mean = new Array<number>(SHAPE_DIM).fill(0);
  for (const shape of usable) {
    for (let i = 0; i < SHAPE_DIM; i += 1) mean[i] += shape[i];
  }
  for (let i = 0; i < SHAPE_DIM; i += 1) mean[i] /= usable.length;
  const norm = Math.hypot(...mean) || 1;
  return mean.map((value) => value / norm);
}

function invert(point: MeshPoint, matrix: number[]): MeshPoint {
  const tx = matrix[3];
  const ty = matrix[7];
  const tz = matrix[11];
  const dx = point.x - tx;
  const dy = point.y - ty;
  const dz = point.z - tz;
  return {
    x: matrix[0] * dx + matrix[4] * dy + matrix[8] * dz,
    y: matrix[1] * dx + matrix[5] * dy + matrix[9] * dz,
    z: matrix[2] * dx + matrix[6] * dy + matrix[10] * dz,
  };
}
