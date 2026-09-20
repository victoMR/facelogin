/**
 * Confianza de que hay un humano vivo delante, no un vídeo o una foto.
 *
 * Señales que ya medimos en la sesión (no se inventan otras):
 * - parpadeo (blendshapes / EAR)
 * - residual no plano (la cara no se mueve como un cartón)
 * - recorrido de yaw si hubo giros
 * - relieve Z de la malla
 * - recorrido de la boca
 *
 * Por debajo del umbral se dispara el captcha de tres palabras: un vídeo
 * grabado de un login anterior no conoce las palabras de esta ronda.
 */

export const HUMAN_CAPTCHA_SCORE = 0.52;
export const ENROLL_CAPTCHA_SCORE = 0.35;
export const WORD_MOUTH_SPAN = 0.14;

export type HumanSignals = {
  yawSpan: number;
  blinkSpan: number;
  residual: number;
  depthRelief: number;
  seenBlink: boolean;
  mouthSpan: number;
  frames: number;
  /** Si la sesión no pidió giros, el yaw bajo no es sospechoso. */
  glanced: boolean;
};

export type HumanReport = {
  score: number;
  captcha: boolean;
  reasons: string[];
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function humanConfidence(signals: HumanSignals): HumanReport {
  const blinkHit = signals.seenBlink ? 0.2 : 0;
  const blinkRange = clamp01(signals.blinkSpan / 0.28) * 0.14;
  const motion = clamp01(signals.residual / 1.5) * 0.2;
  const yaw = signals.glanced ? clamp01(signals.yawSpan / 0.28) * 0.14 : 0.14;
  const depth = clamp01(signals.depthRelief / 0.07) * 0.16;
  const mouth = clamp01(signals.mouthSpan / 0.2) * 0.16;
  const score = Number((blinkHit + blinkRange + motion + yaw + depth + mouth).toFixed(3));

  const reasons: string[] = [];
  if (!signals.seenBlink && signals.blinkSpan < 0.1) reasons.push("ojos planos");
  if (signals.residual < 0.45) reasons.push("movimiento rígido");
  if (signals.glanced && signals.yawSpan < 0.1) reasons.push("sin giro vivo");
  if (signals.depthRelief < 0.018) reasons.push("poca profundidad");
  if (signals.mouthSpan < 0.06) reasons.push("boca inmóvil");

  const starved = signals.frames >= 16 && signals.residual < 0.35 && !signals.seenBlink;
  const captcha = score < HUMAN_CAPTCHA_SCORE || reasons.length >= 2 || starved;
  return { score, captcha, reasons };
}

/** Recorre el máximo–mínimo de una señal (boca, audio) en una ventana corta. */
export class SpanTracker {
  private values: number[] = [];

  constructor(private readonly cap = 48) {}

  feed(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.cap) this.values.shift();
  }

  get span(): number {
    return this.windowSpan(this.values.length);
  }

  windowSpan(n = 24): number {
    const slice = this.values.slice(-n);
    if (slice.length < 4) return 0;
    return Math.max(...slice) - Math.min(...slice);
  }

  reset(): void {
    this.values = [];
  }
}

export function foldSpeech(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-zñü\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Una palabra rimbombante a menudo se corta en el reconocedor.
 * Si tiene 10+ letras, basta un tronco largo y único.
 */
export function wordHeard(transcript: string, word: string): boolean {
  const hay = foldSpeech(transcript);
  const needle = foldSpeech(word).replace(/\s/g, "");
  if (!needle) return false;
  if (hay.replace(/\s/g, "").includes(needle)) return true;
  if (needle.length >= 10) {
    const stem = needle.slice(0, Math.max(8, Math.floor(needle.length * 0.55)));
    return hay.replace(/\s/g, "").includes(stem);
  }
  return hay.split(" ").includes(needle);
}

export function wordsHeard(transcript: string, words: string[]): boolean[] {
  return words.map((word) => wordHeard(transcript, word));
}
