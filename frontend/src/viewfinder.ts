import type { Box } from "./face";
import type { ChallengeId } from "./liveness";

/**
 * Encuadre digital: la cámara no tiene motor, así que el recorte hace de
 * pan/tilt/zoom. El óvalo se queda quieto; el frame se mueve debajo para
 * mantener la cara (y en el parpadeo, los ojos) en el centro, a un tamaño
 * que el detector y el EAR puedan leer.
 *
 * No se puede alejar más que el frame entero (`ZOOM_MIN = 1`): no hay margen
 * alrededor del sensor. Acercarse sí, hasta un tope por gesto —en perfil un
 * zoom fuerte recorta la oreja justo cuando hay que medir yaw.
 */

export type ViewMode = "wide" | "face" | "eyes";

export const ZOOM_MIN = 1;
export const ZOOM_MAX_WIDE = 1.45;
export const ZOOM_MAX_FACE = 1.85;
export const ZOOM_MAX_EYES = 2.15;

/** Qué fracción del lado corto debe ocupar la caja. Si ya la llena, zoom = 1. */
export const TARGET_RATIO_WIDE = 0.38;
export const TARGET_RATIO_FACE = 0.46;
export const TARGET_RATIO_EYES = 0.52;

export type ViewWindow = { sx: number; sy: number; sw: number; sh: number };

/** Óvalo y escenario en píxeles CSS. El recorte tiene que llenar ESTO, no el frame. */
export type OvalAim = {
  stageW: number;
  stageH: number;
  oval: { cx: number; cy: number; rx: number; ry: number };
};

export function viewModeFor(challenge: ChallengeId): ViewMode {
  if (challenge === "blink") return "eyes";
  if (challenge === "left" || challenge === "right") return "wide";
  return "face";
}

export function targetRatio(mode: ViewMode): number {
  if (mode === "eyes") return TARGET_RATIO_EYES;
  if (mode === "wide") return TARGET_RATIO_WIDE;
  return TARGET_RATIO_FACE;
}

export function maxZoom(mode: ViewMode): number {
  if (mode === "eyes") return ZOOM_MAX_EYES;
  if (mode === "wide") return ZOOM_MAX_WIDE;
  return ZOOM_MAX_FACE;
}

export function minZoom(_mode: ViewMode): number {
  return ZOOM_MIN;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Escala que dejaría la caja en `target` del lado corto, acotada al gesto.
 *
 * `ratio * scale ≈ target`: si la cara ocupa 0.23 del frame, en modo ojos
 * queremos 0.52, así que el recorte va a ~2.3×.
 */
export function targetScale(box: Box, frameW: number, frameH: number, mode: ViewMode): number {
  const short = Math.min(frameW, frameH);
  const ratio = box.width / Math.max(short, 1);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return ZOOM_MIN;
  return clamp(targetRatio(mode) / ratio, ZOOM_MIN, maxZoom(mode));
}

export function coverFit(
  frameW: number,
  frameH: number,
  stageW: number,
  stageH: number,
): { scale: number; ox: number; oy: number } {
  const scale = Math.max(stageW / frameW, stageH / frameH);
  return { scale, ox: (stageW - frameW * scale) / 2, oy: (stageH - frameH * scale) / 2 };
}

/**
 * Recorte que deja la cara dentro del óvalo.
 *
 * El fallo anterior medía la caja contra el frame (960×540). En un monitor el
 * óvalo es otra geometría: el zoom llenaba el sensor y recortaba la nariz.
 * Aquí se compara la cara ya proyectada (object-fit: cover) con el anillo.
 * Si ya lo llena, zoom = 1. Si no, se acerca y se panea al centro del óvalo.
 */
export function targetView(
  box: Box,
  frameW: number,
  frameH: number,
  mode: ViewMode,
  aim: OvalAim,
): { scale: number; cx: number; cy: number } {
  const { scale: fit, ox, oy } = coverFit(frameW, frameH, aim.stageW, aim.stageH);
  const { cx: ocx, cy: ocy, rx, ry } = aim.oval;
  const faceW = box.width * fit;
  const faceH = box.height * fit;
  const fillX = mode === "eyes" ? 0.76 : mode === "wide" ? 0.58 : 0.68;
  const fillY = mode === "eyes" ? 0.7 : mode === "wide" ? 0.54 : 0.62;
  const zoomX = (2 * rx * fillX) / Math.max(faceW, 1);
  const zoomY = (2 * ry * fillY) / Math.max(faceH, 1);
  const needed = Math.min(zoomX, zoomY);
  const scale = needed <= 1 ? ZOOM_MIN : clamp(needed, ZOOM_MIN, maxZoom(mode));

  const fcx = box.x + box.width / 2;
  const fcy = aimY(box, mode);
  const cx = fcx - (ocx - ox) / (fit * scale) + frameW / (2 * scale);
  const cy = fcy - (ocy - oy) / (fit * scale) + frameH / (2 * scale);
  return clampView(cx, cy, scale, frameW, frameH);
}

/** El recorte no puede pedir píxeles fuera del frame. */
export function clampView(
  cx: number,
  cy: number,
  scale: number,
  frameW: number,
  frameH: number,
): { cx: number; cy: number; scale: number } {
  const zoom = clamp(scale, ZOOM_MIN, ZOOM_MAX_EYES);
  const sw = frameW / zoom;
  const sh = frameH / zoom;
  return {
    scale: zoom,
    cx: clamp(cx, sw / 2, frameW - sw / 2),
    cy: clamp(cy, sh / 2, frameH - sh / 2),
  };
}

export function viewWindow(cx: number, cy: number, scale: number, frameW: number, frameH: number): ViewWindow {
  const held = clampView(cx, cy, scale, frameW, frameH);
  const sw = frameW / held.scale;
  const sh = frameH / held.scale;
  return { sx: held.cx - sw / 2, sy: held.cy - sh / 2, sw, sh };
}

/**
 * Caja medida en el frame ya recortado → coordenadas del frame completo.
 *
 * El seguimiento corre sobre el recorte; el viewfinder tiene que pensar en el
 * sensor entero. Sin este mapeo, una cara ya ampliada parece “del tamaño
 * bueno” y el zoom se apaga en el siguiente frame.
 */
export function remapBox(box: Box, window: ViewWindow, destW: number, destH: number): Box {
  return {
    x: window.sx + box.x * (window.sw / destW),
    y: window.sy + box.y * (window.sh / destH),
    width: box.width * (window.sw / destW),
    height: box.height * (window.sh / destH),
  };
}

/** En ojos, el centro sube hacia los párpados; en el resto, hacia ojos–boca. */
export function aimY(box: Box, mode: ViewMode): number {
  return box.y + box.height * (mode === "eyes" ? 0.32 : 0.42);
}

export class Viewfinder {
  scale = 1;
  cx = 0;
  cy = 0;
  private primed = false;

  reset(): void {
    this.scale = 1;
    this.cx = 0;
    this.cy = 0;
    this.primed = false;
  }

  window(frameW: number, frameH: number): ViewWindow {
    this.ensure(frameW, frameH);
    return viewWindow(this.cx, this.cy, this.scale, frameW, frameH);
  }

  follow(box: Box | null, frameW: number, frameH: number, mode: ViewMode, aim?: OvalAim): void {
    this.ensure(frameW, frameH);
    if (!box) {
      this.scale += (1 - this.scale) * 0.35;
      this.cx += (frameW / 2 - this.cx) * 0.28;
      this.cy += (frameH / 2 - this.cy) * 0.28;
      const held = clampView(this.cx, this.cy, this.scale, frameW, frameH);
      this.scale = held.scale;
      this.cx = held.cx;
      this.cy = held.cy;
      return;
    }

    const want =
      aim && aim.stageW > 8 && aim.stageH > 8 && aim.oval.rx > 4
        ? targetView(box, frameW, frameH, mode, aim)
        : clampView(
            box.x + box.width / 2,
            aimY(box, mode),
            targetScale(box, frameW, frameH, mode),
            frameW,
            frameH,
          );
    // El pan va más rápido que el zoom: se siente seguimiento, no un “punch in”.
    const pan = mode === "wide" ? 0.22 : 0.3;
    const zoom = 0.18;
    this.scale += (want.scale - this.scale) * zoom;
    this.cx += (want.cx - this.cx) * pan;
    this.cy += (want.cy - this.cy) * pan;
    const held = clampView(this.cx, this.cy, this.scale, frameW, frameH);
    this.scale = held.scale;
    this.cx = held.cx;
    this.cy = held.cy;
  }

  private ensure(frameW: number, frameH: number): void {
    if (this.primed) return;
    this.cx = frameW / 2;
    this.cy = frameH / 2;
    this.scale = 1;
    this.primed = true;
  }
}

/**
 * Copia el recorte al canvas de análisis, al mismo tamaño del frame.
 *
 * El detector y los landmarks hablan de este lienzo. A zoom 1 es una copia
 * idéntica; por encima, el recorte se estira y los ojos ganan píxeles.
 */
export function applyView(
  source: HTMLCanvasElement,
  dest: HTMLCanvasElement,
  view: Viewfinder,
): HTMLCanvasElement {
  if (dest.width !== source.width || dest.height !== source.height) {
    dest.width = source.width;
    dest.height = source.height;
  }
  const ctx = dest.getContext("2d");
  if (!ctx) return source;
  if (view.scale <= 1.01) {
    ctx.drawImage(source, 0, 0);
    return dest;
  }
  const { sx, sy, sw, sh } = view.window(source.width, source.height);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dest.width, dest.height);
  return dest;
}
