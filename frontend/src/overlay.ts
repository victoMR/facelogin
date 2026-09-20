import type { FaceLandmarks68 } from "@vladmandic/face-api";

/**
 * Estado del anillo. Es la **única** señal continua de la pantalla: dice a la
 * vez "te veo" (`track`), "te veo bien" (`framed`), "algo de la imagen va mal"
 * (`warn`) y "acabo de disparar" (`blink` / `shot`).
 *
 * `warn` es lo que sustituye a los medidores de luz y nitidez: esos dos
 * chismes ocupaban primer plano de forma permanente para comunicar un estado
 * binario que el anillo ya podía teñir de ámbar.
 */
export type Lock = "none" | "track" | "framed" | "warn" | "blink" | "shot";

/**
 * La malla de landmarks: **apagada**.
 *
 * Se dibujaba sobre la cara en cada vuelta del bucle como acuse de "te veo".
 * Ese trabajo lo hace ahora el anillo, que ya cambia de color con el encuadre,
 * y la malla solo añadía ruido encima justo de lo que la persona está mirando
 * —su propia cara— además de recordarle que la están midiendo.
 *
 * Se conserva como ayuda de depuración porque para calibrar `poseAngles` o
 * `eyeSignal` no hay sustituto: hay que ver dónde caen los 68 puntos. Se
 * enciende **en el build**, con `VITE_FACELOGIN_MESH=1`; `setMeshDebug` está
 * para poder apagarla y encenderla dentro de esa sesión.
 *
 * En un build normal no es que esté apagada: **no se envía**. Nadie importa
 * `setMeshDebug`, así que Rollup demuestra que `mesh` es siempre `false` y se
 * lleva por delante el mapeo de los 68 puntos, las cadenas y los trazos. Son
 * 0.6 kB menos en el chunk de la captura, medidos.
 */
// Sin `?.` a propósito: Vite sustituye `import.meta.env.VITE_*` de forma
// **estática**, y el encadenamiento opcional rompe esa sustitución. Con `?.` el
// build dejaba `({}).VITE_FACELOGIN_MESH`, o sea la bandera clavada a `false`
// aunque se pasara la variable — un interruptor que no enciende.
let mesh = import.meta.env.VITE_FACELOGIN_MESH === "1";

export function setMeshDebug(on: boolean): void {
  mesh = on;
}

export function meshDebug(): boolean {
  return mesh;
}

const CHAINS: number[][] = [
  range(0, 16),
  range(17, 21),
  range(22, 26),
  range(27, 30),
  range(31, 35),
  [...range(36, 41), 36],
  [...range(42, 47), 42],
  [...range(48, 59), 48],
  [...range(60, 67), 60],
];

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function mapPoint(
  point: { x: number; y: number },
  vw: number,
  vh: number,
  cw: number,
  ch: number,
): { x: number; y: number } {
  const scale = Math.max(cw / vw, ch / vh);
  return {
    x: point.x * scale + (cw - vw * scale) / 2,
    y: point.y * scale + (ch - vh * scale) / 2,
  };
}

export type Oval = { cx: number; cy: number; rx: number; ry: number };

/**
 * Zonas del escenario que ya están ocupadas por interfaz, en píxeles CSS: la
 * cabecera (cancelar, título, contador, puntos de progreso) y el pie
 * (instrucción, causa, medidores).
 */
export type Insets = { top: number; bottom: number };

const NO_INSETS: Insets = { top: 0, bottom: 0 };

/**
 * Geometría del óvalo, en píxeles CSS del escenario.
 *
 * Vive aquí y **solo aquí** porque la dibujan dos capas distintas: el canvas
 * (que recorta la viñeta y pinta la malla) y el anillo de progreso, que es un
 * `<svg>` del DOM para poder animarse con CSS y respetar `prefers-reduced-motion`.
 * Si las dos capas calcularan la elipse por su cuenta, cualquier retoque
 * dejaría el anillo desalineado del recorte.
 *
 * ## Por qué hay `insets` y no un número fijo
 *
 * La versión anterior centraba el óvalo en el viewport entero y lo acotaba con
 * `height * 0.28`. En un móvil en vertical eso funcionaba de casualidad —manda
 * el ancho— pero en un monitor de 1280×820 el óvalo medía 596 px de alto y se
 * comía el pie: la instrucción y la causa acababan escritas **dentro** del
 * óvalo, encima de la parte de la imagen que la viñeta deja clara, que es
 * justamente donde peor contraste hay.
 *
 * Ahora el óvalo se calcula en el hueco que queda libre entre cabecera y pie, y
 * esos dos los mide la interfaz con un `ResizeObserver`: si el diagnóstico añade
 * una línea, el óvalo se aparta solo. El vídeo sigue ocupando la pantalla
 * entera; lo único que se mueve es la guía.
 *
 * `usable * 0.36` sale de la proporción del propio óvalo: con `ry = 1.3 · rx`,
 * que quepa entero exige `rx ≤ usable / 2.6 = usable · 0.385`. 0.36 deja un
 * respiro para que no bese los bordes.
 *
 * ## Por qué además hay un tope con la altura del escenario
 *
 * Los dos límites de arriba garantizan que el óvalo **quepa**, no que pida una
 * distancia razonable. Al vaciar el pie de medidores y consejos, `usable` creció
 * ~180 px y el óvalo con él: en un monitor de 1280×800 pasaba a medir 452 px de
 * ancho, y llenarlo exigía acercarse hasta `boxRatio ≈ 0.57`, a un pelo de
 * `NEAR_RATIO` (0.62), donde la propia interfaz dice "aléjate". El óvalo pedía
 * justo lo que el diagnóstico castiga.
 *
 * El tercer término lo arregla con la geometría real del vídeo. El `<video>` va
 * con `object-fit: cover`, y con una cámara apaisada (16:9, 4:3) dentro de un
 * escenario más vertical manda la altura: la escala es `alto / altoFrame`, así
 * que una cara que ocupa `r` del lado corto del frame se ve en pantalla con
 * `r · alto` píxeles de ancho. Querer que llenar el óvalo signifique `r ≈ 0.46`
 * —el centro de la banda buena, 0.33–0.62— es pedir `2·rx ≈ 0.46 · alto`, o sea
 * `rx ≤ alto · 0.23`. Es el único de los tres términos que mira a la cámara y no
 * al hueco libre.
 */
export function ovalGeometry(width: number, height: number, insets: Insets = NO_INSETS): Oval {
  const usable = Math.max(height - insets.top - insets.bottom, 1);
  const rx = Math.max(Math.min(width * 0.4, usable * 0.36, height * 0.23), 1);
  return { cx: width / 2, cy: insets.top + usable / 2, rx, ry: rx * 1.3 };
}

/**
 * La elipse como `path`, empezando arriba y en sentido horario.
 *
 * Un `<ellipse>` de SVG arranca su trazo a las 3 en punto, y el anillo de
 * progreso tiene que empezar a llenarse desde arriba. Con dos arcos se controla
 * el punto de partida sin rotar nada (rotar una elipse intercambiaría los ejes).
 */
/** Puntos alrededor del óvalo: a dónde mirar, como Face ID. */
export function glanceDots(oval: Oval): { id: "center" | "left" | "right"; x: number; y: number }[] {
  return [
    { id: "center", x: oval.cx, y: oval.cy - oval.ry - 20 },
    { id: "left", x: oval.cx - oval.rx - 20, y: oval.cy },
    { id: "right", x: oval.cx + oval.rx + 20, y: oval.cy },
  ];
}

export function ovalPath({ cx, cy, rx, ry }: Oval): string {
  return `M ${cx} ${cy - ry} A ${rx} ${ry} 0 1 1 ${cx} ${cy + ry} A ${rx} ${ry} 0 1 1 ${cx} ${cy - ry}`;
}

/**
 * Viñeta. **El contorno del óvalo no se pinta aquí**: lo dibuja el anillo de
 * progreso en SVG, que además de marcar el borde muestra cuánto falta. Dos
 * contornos superpuestos se veían sucios y no podían coincidir en grosor.
 *
 * Y **la malla tampoco se pinta**, salvo con `setMeshDebug(true)`. El coste que
 * sí se paga ahora es el `drawImage` del recorte (el viewfinder sigue la cara);
 * los 68 puntos y las polilíneas siguen fuera del bundle normal.
 */
function sourceSize(source: HTMLVideoElement | HTMLCanvasElement): { w: number; h: number } {
  return source instanceof HTMLVideoElement
    ? { w: source.videoWidth, h: source.videoHeight }
    : { w: source.width, h: source.height };
}

export function drawCapture(
  canvas: HTMLCanvasElement,
  /**
   * Píxeles que se ven dentro del óvalo. Puede ser el vídeo crudo o el recorte
   * del viewfinder: el anillo no se mueve; cambia lo que hay debajo.
   */
  source: HTMLVideoElement | HTMLCanvasElement,
  landmarks: FaceLandmarks68 | null,
  lock: Lock,
  /**
   * Tope de `devicePixelRatio`, que llega del perfil de rendimiento.
   *
   * Este canvas se repinta en **cada vuelta del bucle**, y su coste es
   * cuadrático en el DPR. En un móvil con DPR 3 y una pantalla de 412×915 CSS
   * el búfer real son 3.4 M de píxeles: rellenar la viñeta y trazar la malla
   * ahí cuesta, en gama baja, lo mismo que la propia detección. A 1× la
   * viñeta se ve idéntica (es un relleno plano) y la malla apenas pierde un
   * pelo de suavidad, que es un cambio invisible al lado de duplicar los fps.
   */
  maxDpr = 2,
  /** Cabecera y pie ya ocupados. El óvalo se centra en lo que queda. */
  insets: Insets = NO_INSETS,
  /**
   * Si es false, solo se pinta la viñeta y se ve el `<video>` debajo.
   * El blit del recorte solo hace falta cuando hay zoom digital.
   */
  paintSource = true,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const src = sourceSize(source);
  if (paintSource && src.w >= 8 && src.h >= 8) {
    const cover = Math.max(width / src.w, height / src.h);
    const dw = src.w * cover;
    const dh = src.h * cover;
    ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }

  const { cx, cy, rx, ry } = ovalGeometry(width, height, insets);

  // Todo lo que queda fuera del óvalo se oscurece. Cumple dos funciones: dirige
  // la mirada al centro y le da al texto blanco un fondo con contraste suficiente
  // aunque detrás haya una pared blanca en movimiento.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2, true);
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.fill("evenodd");
  ctx.restore();

  if (!mesh || !landmarks || src.w < 8) return;

  const points = landmarks.positions.map((point) => mapPoint(point, src.w, src.h, width, height));

  // Solo con `setMeshDebug(true)`. Ya no es acuse de recibo para nadie: es el
  // diagrama con el que se calibran `poseAngles` y `eyeSignal`.
  ctx.strokeStyle = lock === "none" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.34)";
  ctx.lineWidth = 1;
  for (const chain of CHAINS) {
    ctx.beginPath();
    chain.forEach((index, offset) => {
      const point = points[index];
      if (offset === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }

  if (lock === "blink" || lock === "shot") {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const index of range(36, 47)) {
      const point = points[index];
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
