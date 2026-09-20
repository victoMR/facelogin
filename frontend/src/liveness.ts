import type { FaceLandmarks68 } from "@vladmandic/face-api";

export type ChallengeId = "center" | "blink" | "left" | "right";

/**
 * Guía tipo Face ID: un punto que recorrer, no una lista de órdenes.
 * El parpadeo se mira en el mismo vídeo, en segundo plano.
 */
export const glanceChallenges: ChallengeId[] = ["center", "left", "right"];
export const enrollChallenges: ChallengeId[] = glanceChallenges;
/**
 * Aparato ya de confianza: un vistazo de frente. La liveness sale del
 * movimiento de la malla y de un parpadeo natural, no de más gestos.
 */
export const trustedChallenges: ChallengeId[] = ["center"];
export const loginChallenges: ChallengeId[] = glanceChallenges;

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

/**
 * Apertura de ojos. Solo EAR: mezclar la altura del párpado / cara dejaba el
 * valor clavado y el parpadeo real no se veía.
 */
export function eyeSignal(landmarks: FaceLandmarks68): { raw: number; left: number; right: number } {
  const left = ear(landmarks.getLeftEye());
  const right = ear(landmarks.getRightEye());
  return { left, right, raw: (left + right) / 2 };
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

/** Media de los 3 valores altos, descartando el máximo si hay bastante historia. */
function robustHigh(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const end = sorted.length - (sorted.length >= 8 ? 1 : 0);
  const start = Math.max(0, end - Math.min(3, end));
  const slice = sorted.slice(start, end);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function smooth(prev: number, next: number, started: boolean): number {
  return started ? 0.8 * next + 0.2 * prev : next;
}

/**
 * Parpadeo de prueba de vida, no de comodidad.
 *
 * Sin lentes el EAR cae fuerte (0.30 → 0.08). Con lentes los 68 puntos se
 * quedan en la montura: el “abierto” ya parece 0.16 y el cierre apenas baja
 * 0.03. Un max() de un reflejo deja el ratio inalcanzable y el paso 4 se
 * atasca en «ábrelos». El pico es robusto, cada ojo cuenta por su lado y el
 * umbral se encoge si la señal viene comprimida. El jitter de una foto
 * (caídas de ~0.015, a menudo en un solo ojo) no llega.
 */
/** Frames de ojos abiertos antes de aceptar un cierre. Evita el falso blink al volver de un giro. */
export const BLINK_ARM_FRAMES = 5;

export class BlinkTracker {
  value = 0;
  peak = 0;
  ratio = 1;
  phase: "open" | "closed" = "open";
  closedFrames = 0;
  /** EAR aplastado por montura o reflejo: umbrales más cortos. */
  compressed = false;
  /** Un ciclo cierre→apertura válido. La muestra se toma en el frame siguiente. */
  won = false;
  private left = 0;
  private right = 0;
  private recent: number[] = [];
  private recentLeft: number[] = [];
  private recentRight: number[] = [];
  /** Muestras de ojos ABIERTOS. No se contaminan si el usuario mantiene el cierre. */
  private openSamples: number[] = [];
  private openLeft = 0;
  private openRight = 0;
  private trough = 1;
  private lastBlink = 0;
  private started = false;
  private deepClose = false;
  private liveFrames = 0;

  reset(): void {
    this.clearCycle();
    this.value = 0;
    this.peak = 0;
    this.ratio = 1;
    this.compressed = false;
    this.left = 0;
    this.right = 0;
    this.recent = [];
    this.recentLeft = [];
    this.recentRight = [];
    this.openSamples = [];
    this.openLeft = 0;
    this.openRight = 0;
    this.started = false;
  }

  /** Olvida un ciclo a medias, no la baseline de ojos abiertos. */
  clearCycle(): void {
    this.phase = "open";
    this.closedFrames = 0;
    this.won = false;
    this.trough = 1;
    this.lastBlink = 0;
    this.deepClose = false;
    this.liveFrames = 0;
  }

  /**
   * Durante frente / espera: los ojos deberían estar abiertos.
   * Ahí se fija el “abierto” personal, que el cierre de un segundo no puede borrar.
   */
  noteOpen(raw: number, left: number = raw, right: number = raw): void {
    this.value = smooth(this.value, raw, this.started);
    this.left = smooth(this.left, left, this.started);
    this.right = smooth(this.right, right, this.started);
    this.started = true;
    this.rememberOpen(this.value, this.left, this.right);
    this.peak = this.openPeak();
    this.ratio = this.value / Math.max(this.peak, 1e-3);
  }

  private rememberOpen(mean: number, left: number, right: number): void {
    this.openSamples.push(mean);
    if (this.openSamples.length > 20) this.openSamples.shift();
    this.openLeft = this.openLeft <= 0 ? left : Math.max(this.openLeft * 0.7 + left * 0.3, left * 0.85);
    this.openRight = this.openRight <= 0 ? right : Math.max(this.openRight * 0.7 + right * 0.3, right * 0.85);
  }

  private openPeak(): number {
    if (this.openSamples.length >= 3) return Math.max(robustHigh(this.openSamples), 0.12);
    if (this.recent.length === 0) return Math.max(this.peak, 0.12);
    return Math.max(robustHigh(this.recent), 0.12);
  }

  feed(
    raw: number,
    left: number = raw,
    right: number = raw,
    hint?: { glasses?: boolean },
  ): "blink" | "open" | "closed" {
    this.value = smooth(this.value, raw, this.started);
    this.left = smooth(this.left, left, this.started);
    this.right = smooth(this.right, right, this.started);
    this.started = true;

    this.recent.push(this.value);
    this.recentLeft.push(this.left);
    this.recentRight.push(this.right);
    if (this.recent.length > 24) {
      this.recent.shift();
      this.recentLeft.shift();
      this.recentRight.shift();
    }

    const peak = this.openPeak();
    const leftPeak = Math.max(this.openLeft, peak * 0.9, 0.1);
    const rightPeak = Math.max(this.openRight, peak * 0.9, 0.1);
    this.peak = peak;
    this.ratio = this.value / peak;
    const drop = peak - this.value;
    const leftRatio = this.left / leftPeak;
    const rightRatio = this.right / rightPeak;
    const leftDrop = leftPeak - this.left;
    const rightDrop = rightPeak - this.right;

    this.compressed = Boolean(hint?.glasses) || peak <= 0.22 || Math.abs(this.left - this.right) > 0.07;

    // El “abierto” solo lo fija noteOpen. Si aquí se actualizara el pico, un
    // cierre largo (los 68 puntos no se hunden) lo convertiría en la nueva
    // baseline y el paso de ojos no terminaba nunca.

    const strongClose = this.ratio <= 0.82 && drop >= 0.028;
    const bothClose =
      leftRatio <= 0.88 &&
      rightRatio <= 0.88 &&
      leftDrop >= (this.compressed ? 0.012 : 0.02) &&
      rightDrop >= (this.compressed ? 0.012 : 0.02);
    const glassesClose =
      this.compressed && this.ratio <= 0.9 && drop >= Math.max(0.012, peak * 0.1);
    const closed = strongClose || bothClose || glassesClose;
    const reopenAt = this.compressed ? 0.78 : 0.86;
    const minDip = this.compressed ? Math.max(0.014, peak * 0.1) : 0.035;
    const holdNeed = this.compressed ? 2 : 1;

    this.liveFrames += 1;
    if (this.liveFrames <= BLINK_ARM_FRAMES) {
      this.phase = "open";
      this.closedFrames = 0;
      this.deepClose = false;
      this.won = false;
      return "open";
    }

    if (this.phase === "open") {
      if (closed) {
        this.phase = "closed";
        this.trough = this.value;
        this.closedFrames = 1;
        this.deepClose = true;
      }
      return this.phase;
    }

    this.trough = Math.min(this.trough, this.value);
    if (closed) {
      this.closedFrames += 1;
      return "closed";
    }
    if (this.ratio < reopenAt) return "closed";

    const dip = peak - this.trough;
    const held = this.closedFrames >= holdNeed;
    this.phase = "open";
    this.closedFrames = 0;
    if (held && this.deepClose && dip >= minDip && Date.now() - this.lastBlink > 400) {
      this.lastBlink = Date.now();
      this.deepClose = false;
      this.won = true;
      return "blink";
    }
    this.deepClose = false;
    return "open";
  }
}

/**
 * Una foto (papel o pantalla) es un plano rígido: los puntos se mueven juntos,
 * el EAR casi no cambia y el yaw apenas recorre rango. Una cara viva no.
 */
export class PlanarPad {
  private prev: { x: number; y: number }[] | null = null;
  private residuals: number[] = [];
  private ears: number[] = [];
  private blinks: number[] = [];
  private reliefs: number[] = [];
  minYaw = Infinity;
  maxYaw = -Infinity;

  feed(
    positions: { x: number; y: number }[],
    yaw: number,
    ear: number,
    blink = 0,
    relief = 1,
  ): void {
    this.minYaw = Math.min(this.minYaw, yaw);
    this.maxYaw = Math.max(this.maxYaw, yaw);
    this.ears.push(ear);
    if (this.ears.length > 40) this.ears.shift();
    this.blinks.push(blink);
    if (this.blinks.length > 40) this.blinks.shift();
    this.reliefs.push(relief);
    if (this.reliefs.length > 40) this.reliefs.shift();

    const idx = [8, 27, 30, 36, 45, 48, 54];
    const pts = idx.map((i) => positions[i]).filter(Boolean);
    if (pts.length < 5) return;
    if (!this.prev || this.prev.length !== pts.length) {
      this.prev = pts;
      return;
    }
    const dx = pts.reduce((sum, point, i) => sum + point.x - this.prev![i].x, 0) / pts.length;
    const dy = pts.reduce((sum, point, i) => sum + point.y - this.prev![i].y, 0) / pts.length;
    let residual = 0;
    for (let i = 0; i < pts.length; i += 1) {
      residual += Math.hypot(pts[i].x - this.prev[i].x - dx, pts[i].y - this.prev[i].y - dy);
    }
    residual /= pts.length;
    this.prev = pts;
    this.residuals.push(residual);
    if (this.residuals.length > 24) this.residuals.shift();
  }

  get yawSpan(): number {
    if (!Number.isFinite(this.minYaw)) return 0;
    return this.maxYaw - this.minYaw;
  }

  get earSpan(): number {
    if (this.ears.length < 10) return 1;
    return Math.max(...this.ears) - Math.min(...this.ears);
  }

  get blinkSpan(): number {
    if (this.blinks.length < 10) return 1;
    return Math.max(...this.blinks) - Math.min(...this.blinks);
  }

  get meanResidual(): number {
    if (this.residuals.length === 0) return 1;
    return this.residuals.reduce((sum, value) => sum + value, 0) / this.residuals.length;
  }

  photoLikely(): boolean {
    if (this.residuals.length < 16) return false;
    const flatMotion = this.meanResidual < 0.9 && this.earSpan < 0.04 && this.yawSpan < 0.12;
    const deadEyes = this.blinks.length >= 16 && this.blinkSpan < 0.08;
    return flatMotion && deadEyes;
  }
}

export function poseMetYaw(id: Exclude<ChallengeId, "blink">, yaw: number): boolean {
  if (id === "center") return Math.abs(yaw) < 0.12;
  if (id === "left") return yaw < -0.18;
  return yaw > 0.18;
}

export function poseMet(id: Exclude<ChallengeId, "blink">, landmarks: FaceLandmarks68): boolean {
  return poseMetYaw(id, screenYaw(landmarks));
}

/**
 * Apertura mínima de ojos para extraer un descriptor.
 *
 * El reto de parpadeo se daba por superado en cuanto el ojo empezaba a abrirse,
 * y la captura salía de ese instante: el frame con los párpados a medio camino,
 * el peor de toda la sesión, y encima era el único que se mandaba al login.
 * Aquí se espera a que el ojo haya vuelto a abrirse del todo.
 */
export const OPEN_EYE_RATIO = 0.84;
/** Con lentes el “abierto” ya es bajo; 0.84 del pico de un reflejo no se alcanza. */
export const OPEN_EYE_RATIO_GLASSES = 0.78;

export function eyesOpenForSample(tracker: BlinkTracker): boolean {
  if (tracker.phase !== "open") return false;
  const need = tracker.compressed ? OPEN_EYE_RATIO_GLASSES : OPEN_EYE_RATIO;
  return tracker.ratio >= need;
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
