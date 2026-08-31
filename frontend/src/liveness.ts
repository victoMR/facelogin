import type { FaceLandmarks68 } from "@vladmandic/face-api";

export type ChallengeId = "center" | "blink" | "left" | "right";

export const enrollChallenges: ChallengeId[] = ["center", "blink", "left", "right", "blink"];
export const loginChallenges: ChallengeId[] = ["center", "blink"];

export function challengeLabel(id: ChallengeId): string {
  switch (id) {
    case "center":
      return "Mira de frente y quédate quieto";
    case "blink":
      return "Cierra los ojos un instante y ábrelos";
    case "left":
      return "Gira el rostro hacia la izquierda del óvalo";
    case "right":
      return "Gira el rostro hacia la derecha del óvalo";
  }
}

function hypot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points: { x: number; y: number }[]): { x: number; y: number } {
  const n = points.length || 1;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / n,
    y: points.reduce((sum, point) => sum + point.y, 0) / n,
  };
}

function ear(eye: { x: number; y: number }[]): number {
  const vertical = (hypot(eye[1], eye[5]) + hypot(eye[2], eye[4])) / 2;
  const horizontal = Math.max(hypot(eye[0], eye[3]), 1e-3);
  return vertical / horizontal;
}

/** Señal de parpadeo: el ojo más cerrado + altura de párpado / cara. */
export function eyeSignal(landmarks: FaceLandmarks68): { raw: number; left: number; right: number } {
  const left = ear(landmarks.getLeftEye());
  const right = ear(landmarks.getRightEye());
  const leftH = hypot(landmarks.getLeftEye()[1], landmarks.getLeftEye()[5]);
  const rightH = hypot(landmarks.getRightEye()[1], landmarks.getRightEye()[5]);
  const faceH = Math.max(hypot(landmarks.positions[8], landmarks.positions[27]), 1);
  const lid = (leftH + rightH) / 2 / faceH;
  return {
    left,
    right,
    raw: Math.min(left, right, lid * 4.2),
  };
}

export function rawYaw(landmarks: FaceLandmarks68): number {
  const nose = landmarks.getNose()[3];
  const left = centroid(landmarks.getLeftEye());
  const right = centroid(landmarks.getRightEye());
  const span = Math.max(right.x - left.x, 1);
  return (nose.x - (left.x + right.x) / 2) / span;
}

export function screenYaw(landmarks: FaceLandmarks68): number {
  return -rawYaw(landmarks);
}

export class BlinkTracker {
  value = 0;
  peak = 0;
  ratio = 1;
  phase: "open" | "closed" = "open";
  private trough = 1;
  private lastBlink = 0;
  private started = false;

  feed(raw: number): "blink" | "open" | "closed" {
    this.value = this.started ? 0.82 * raw + 0.18 * this.value : raw;
    this.started = true;

    if (this.value > this.peak) this.peak = this.value;
    else this.peak = this.peak * 0.992 + this.value * 0.008;

    const peak = Math.max(this.peak, 0.12);
    this.ratio = this.value / peak;
    const drop = peak - this.value;
    const closed = this.ratio <= 0.9 || drop >= 0.018;

    if (this.phase === "open") {
      if (closed) {
        this.phase = "closed";
        this.trough = this.value;
      }
      return this.phase;
    }

    this.trough = Math.min(this.trough, this.value);
    if (closed) return "closed";

    const dip = peak - this.trough;
    const recovered = this.ratio >= 0.93 || this.value > this.trough + 0.012;
    this.phase = "open";
    if (recovered && dip >= 0.016 && Date.now() - this.lastBlink > 280) {
      this.lastBlink = Date.now();
      return "blink";
    }
    return "open";
  }
}

export function poseMet(id: Exclude<ChallengeId, "blink">, landmarks: FaceLandmarks68): boolean {
  const yaw = screenYaw(landmarks);
  if (id === "center") return Math.abs(yaw) < 0.12;
  if (id === "left") return yaw < -0.18;
  return yaw > 0.18;
}

/**
 * Apertura mínima de ojos para extraer un descriptor.
 *
 * El reto de parpadeo se daba por superado en cuanto el ojo empezaba a abrirse,
 * y la captura salía de ese instante: el frame con los párpados a medio camino,
 * el peor de toda la sesión, y encima era el único que se mandaba al login.
 * Aquí se espera a que el ojo haya vuelto a abrirse del todo.
 */
export const OPEN_EYE_RATIO = 0.92;

export function eyesOpenForSample(tracker: BlinkTracker): boolean {
  return tracker.phase === "open" && tracker.ratio >= OPEN_EYE_RATIO;
}

// ---------------------------------------------------------------------------
// Condiciones de enrollo
// ---------------------------------------------------------------------------

/**
 * Condición de captura declarada por el usuario.
 *
 * **No se detectan los lentes automáticamente.** Los detectores de lentes en 2D
 * son poco fiables con reflejos, monturas finas o luz lateral, y el usuario sabe
 * la respuesta sin margen de error. Se pregunta y ya.
 */
export type ConditionId = "con-lentes" | "sin-lentes" | "default";

export type EnrollCondition = {
  id: ConditionId;
  title: string;
  hint: string;
};

export const SINGLE_CONDITION: EnrollCondition[] = [
  { id: "default", title: "Captura", hint: "Mira a la cámara con luz pareja." },
];

/**
 * Con lentes primero y sin lentes después: quitárselos a mitad del enrollo es
 * más natural que ponérselos, y deja la última tanda con la cara despejada.
 */
export const GLASSES_CONDITIONS: EnrollCondition[] = [
  { id: "con-lentes", title: "Con lentes", hint: "Ponte los lentes como los usas a diario." },
  { id: "sin-lentes", title: "Sin lentes", hint: "Quítate los lentes y repite los gestos." },
];
