/**
 * Perfil de rendimiento por dispositivo.
 *
 * Este módulo es **deliberadamente puro**: no toca `window`, `document`,
 * `navigator` ni face-api. Todo lo que decide —qué perfil sale de una latencia
 * medida, cuándo avisar de degradación, cuántas variantes de augmentación
 * aguanta el equipo, cuánto esperar hasta el siguiente frame— es aritmética
 * sobre números, y por eso se puede probar con `node:test` sin navegador ni
 * modelos. Los módulos que sí tocan el DOM (`face.ts`, `camera.ts`,
 * `FaceCapture.tsx`) importan de aquí, nunca al revés.
 *
 * La alternativa —adivinar el perfil por `navigator.hardwareConcurrency`,
 * `deviceMemory` o el user agent— se descartó: son proxies malos. Un teléfono de
 * 8 núcleos con una GPU saturada y sin WebGL va peor que un portátil de 2
 * núcleos, y `deviceMemory` ni siquiera existe en Safari. Se mide el tiempo real
 * de las primeras detecciones y se decide con eso.
 */

export type ProfileName = "alto" | "medio" | "bajo" | "minimo";

/** Backend de cómputo de tfjs que acabó tocando, ya verificado. */
export type ComputeBackend = "webgl" | "wasm" | "cpu";

export type AugmentationLevel = "off" | "light" | "full";

export type DeviceProfile = {
  name: ProfileName;
  /** `inputSize` del detector de seguimiento en vivo. */
  trackInputSize: number;
  /**
   * `inputSize` del detector de extracción. 416 es el valor medido del que
   * habla el README y **es el techo**: los perfiles solo lo bajan, nunca lo
   * suben. Bajarlo degrada los landmarks (el recorte sigue saliendo del frame a
   * resolución completa), y eso es exactamente el listón de UX que se baja en un
   * equipo que no da para más.
   */
  extractInputSize: number;
  /** Presupuesto por vuelta del bucle en vivo, en ms. Es una cadencia objetivo, no un `setTimeout`. */
  frameBudgetMs: number;
  /** Techo de augmentación del perfil. La calibración por variante puede bajarlo más. */
  augment: AugmentationLevel;
  /** Resolución que se le pide a `getUserMedia`. */
  capture: { width: number; height: number };
  /**
   * Tope de `devicePixelRatio` para el canvas del óvalo. En un móvil con DPR 3
   * un canvas de 400×800 CSS son 2.9 M de píxeles que se repintan en cada
   * frame **además** de la detección: en gama baja es un coste comparable al de
   * la propia red.
   */
  maxDpr: number;
};

const PROFILES: Record<ProfileName, DeviceProfile> = {
  alto: {
    name: "alto",
    trackInputSize: 224,
    extractInputSize: 416,
    frameBudgetMs: 33,
    augment: "full",
    capture: { width: 1280, height: 720 },
    maxDpr: 2,
  },
  medio: {
    name: "medio",
    trackInputSize: 224,
    extractInputSize: 416,
    frameBudgetMs: 66,
    augment: "light",
    capture: { width: 960, height: 540 },
    maxDpr: 2,
  },
  bajo: {
    name: "bajo",
    trackInputSize: 160,
    extractInputSize: 320,
    frameBudgetMs: 125,
    augment: "off",
    capture: { width: 640, height: 480 },
    maxDpr: 1.5,
  },
  minimo: {
    name: "minimo",
    trackInputSize: 128,
    extractInputSize: 256,
    frameBudgetMs: 250,
    augment: "off",
    capture: { width: 480, height: 360 },
    maxDpr: 1,
  },
};

/** De mejor a peor. Es el orden que usan `adjustProfile` y los topes por backend. */
export const PROFILE_ORDER: ProfileName[] = ["alto", "medio", "bajo", "minimo"];

export function profile(name: ProfileName): DeviceProfile {
  return PROFILES[name];
}

/**
 * Umbrales de latencia **de una detección de seguimiento** (detector +
 * landmarks), en ms.
 *
 * No son números elegidos aparte: **son el presupuesto de frame de cada
 * perfil**. La regla es "te toca el perfil X si tu latencia medida cabe dentro
 * del presupuesto de X", que es la única definición que no se contradice a sí
 * misma — un perfil cuyo umbral fuera mayor que su presupuesto estaría
 * prometiendo unos fps que no puede dar.
 *
 * Medido en un M2 con Chrome y WebGL sobre Metal (`npm run test:perf`):
 * `detectSingleFace(224).withFaceLandmarks()` = 24.6 ms, dentro de los 33 del
 * perfil `alto`. Con el umbral anterior de 25 ms ese equipo caía a `medio` por
 * 0.4 ms.
 */
export const LATENCY_MS: Record<Exclude<ProfileName, "minimo">, number> = {
  alto: PROFILES.alto.frameBudgetMs,
  medio: PROFILES.medio.frameBudgetMs,
  bajo: PROFILES.bajo.frameBudgetMs,
};

/**
 * Techo por backend. Medido, no supuesto (M2, Chrome, `npm run test:perf`;
 * medianas de `detectSingleFace(224).withFaceLandmarks()`):
 *
 * | backend | 1× | 4× | 6× | descriptor 1× |
 * | --- | --- | --- | --- | --- |
 * | webgl (Metal) | 24.6 | 28.3 | 31.7 | 17.5 |
 * | wasm (SIMD) | 16.1 | 71.4 | 108.0 | 17.0 |
 * | cpu | 375.3 | 1583.5 | 2390.5 | 466.6 |
 *
 * Dos cosas que la tabla dice y la intuición no:
 *
 * - **WASM en reposo gana a WebGL** en el detector chico (16.1 vs 24.6 ms): a
 *   224 px el coste de subir la textura y leerla de vuelta pesa más que el
 *   cálculo. Aun así se le deja el techo en `medio`, y el motivo está en la
 *   misma tabla: entre 1× y 4× WASM se multiplica por 4.4 y WebGL por 1.15.
 *   Un equipo en WASM no tiene margen — cualquier trabajo de fondo lo tumba—, y
 *   `alto` compromete 7 variantes por captura y una cámara de 720p. El techo es
 *   el seguro contra un precipicio que la medición en reposo no puede ver.
 * - **`cpu` solo aguanta `minimo`, y por eso ese es su techo.** Con el perfil
 *   `medio` un equipo en CPU mide 380 ms por frame de seguimiento (224 px) y
 *   1.4 s por captura: inservible. Metido en `minimo` (128/256) el mismo equipo
 *   mide 80 ms por frame y ~0.9 s por captura, que es lento pero completable.
 *   Ese techo es lo que separa "lento" de "roto", así que no puede subir aunque
 *   la primera medición salga optimista — y el aviso de degradación es "grave"
 *   igualmente, porque a 4× o 6× ni `minimo` salva a CPU (ver README).
 */
export const BACKEND_CAP: Record<ComputeBackend, ProfileName> = {
  webgl: "alto",
  wasm: "medio",
  cpu: "minimo",
};

function cap(name: ProfileName, ceiling: ProfileName): ProfileName {
  return PROFILE_ORDER.indexOf(name) < PROFILE_ORDER.indexOf(ceiling) ? ceiling : name;
}

/** Perfil que corresponde a una latencia medida, ya acotado por el backend. */
export function profileForLatency(medianMs: number, backend: ComputeBackend): DeviceProfile {
  let name: ProfileName;
  if (!Number.isFinite(medianMs) || medianMs <= 0) name = "medio";
  else if (medianMs <= LATENCY_MS.alto) name = "alto";
  else if (medianMs <= LATENCY_MS.medio) name = "medio";
  else if (medianMs <= LATENCY_MS.bajo) name = "bajo";
  else name = "minimo";
  return PROFILES[cap(name, BACKEND_CAP[backend])];
}

/**
 * Histéresis. Sin ella, un equipo que mide 24 ms y luego 26 ms rebota entre
 * `alto` y `medio` cada segundo, y cada rebote cambia el `inputSize` del
 * detector — que en tfjs implica recompilar shaders y tirar la caché de
 * texturas. El rebote costaría más que el perfil que intenta corregir.
 */
export const HYSTERESIS = 0.25;

/**
 * Reajuste en caliente: como mucho **un escalón** por decisión, y solo si la
 * medida se pasa del umbral con margen. Bajar es más fácil que subir, a
 * propósito: quedarse corto molesta, quedarse largo congela la pantalla.
 */
export function adjustProfile(
  current: ProfileName,
  medianMs: number,
  backend: ComputeBackend,
): ProfileName {
  const ceiling = BACKEND_CAP[backend];
  const index = PROFILE_ORDER.indexOf(current);
  const target = PROFILE_ORDER.indexOf(profileForLatency(medianMs, backend).name);

  if (target > index) {
    // Degradar: basta con superar el umbral del perfil actual sin margen extra.
    return cap(PROFILE_ORDER[index + 1], ceiling);
  }
  if (target < index) {
    // Promover: hay que ir cómodamente por debajo del umbral del perfil de
    // arriba, no rozarlo.
    const better = PROFILE_ORDER[index - 1];
    const bar = LATENCY_MS[better as Exclude<ProfileName, "minimo">];
    if (bar !== undefined && medianMs <= bar * (1 - HYSTERESIS)) return cap(better, ceiling);
  }
  return cap(current, ceiling);
}

// ---------------------------------------------------------------------------
// Augmentación
// ---------------------------------------------------------------------------

/**
 * Presupuesto **por variante** (no por captura). Si un descriptor cuesta más de
 * `full` ms, el equipo no aguanta 7 variantes; si pasa de `light`, ninguna.
 *
 * Los números salen de la aritmética del enrollo, no de un gusto: son 5 gestos
 * (10 si hay lentes). A 120 ms por variante, `full` son 7 × 120 × 5 = 4.2 s solo
 * de extracción; a 320 ms, `light` son 3 × 320 × 5 = 4.8 s. Pasado eso, el
 * enrollo deja de parecer una pausa y empieza a parecer una app colgada.
 */
export const AUGMENT_BUDGET_MS = { full: 120, light: 320 };

export const VARIANT_COUNT: Record<AugmentationLevel, number> = { off: 1, light: 3, full: 7 };

const AUGMENT_ORDER: AugmentationLevel[] = ["full", "light", "off"];

/** El más conservador de dos niveles. `off` gana siempre. */
export function minAugmentation(a: AugmentationLevel, b: AugmentationLevel): AugmentationLevel {
  return AUGMENT_ORDER.indexOf(a) > AUGMENT_ORDER.indexOf(b) ? a : b;
}

/**
 * Nivel que aguanta el equipo según el coste real **por variante**. `forced`
 * (de `localStorage`) manda sobre la medición: si alguien fija un nivel a mano,
 * se respeta.
 */
export function augmentLevelForCost(
  msPorVariante: number,
  forced?: AugmentationLevel | null,
): AugmentationLevel {
  if (forced) return forced;
  if (!Number.isFinite(msPorVariante) || msPorVariante < 0) return "light";
  if (msPorVariante > AUGMENT_BUDGET_MS.light) return "off";
  if (msPorVariante > AUGMENT_BUDGET_MS.full) return "light";
  return "full";
}

/**
 * Estimación del enrollo completo con un perfil y un coste por variante dados.
 * Es lo que se usa para decidir si hay que avisar al usuario **antes** de que se
 * plante delante de la cámara diez minutos.
 */
export function enrollEstimateMs(
  level: AugmentationLevel,
  msPorVariante: number,
  gestos: number,
  condiciones = 1,
): number {
  return VARIANT_COUNT[level] * msPorVariante * gestos * condiciones;
}

// ---------------------------------------------------------------------------
// Degradación honesta
// ---------------------------------------------------------------------------

/** Por debajo de esto el bucle en vivo deja de parecer vídeo y parece diapositivas. */
export const MIN_USABLE_FPS = 4;
/**
 * Coste de extracción de un enrollo completo por encima del cual hay que
 * anunciarlo en vez de sorprender con él.
 *
 * Son **solo** los descriptores: no incluye lo que el usuario tarda en girar la
 * cabeza. Y es el número que importa, porque ese tiempo es congelación pura —el
 * anillo parado mientras la red trabaja—, repartido entre 5 gestos. 12 s son 2.4 s
 * de pausa por gesto, que es donde una app deja de parecer lenta y empieza a
 * parecer rota.
 *
 * Con la calibración en su sitio el producto está acotado: si el coste sube, el
 * nivel baja. Llegar a 12 s exige ~1.2 s por variante con `off` y dos
 * condiciones, o sea un equipo genuinamente al límite.
 */
export const SLOW_ENROLL_MS = 12_000;

export type Degradation = {
  level: "ninguna" | "aviso" | "grave";
  message: string;
};

/**
 * Qué decirle al usuario. La regla es no mentir en ninguna dirección: ni
 * disculparse en un MacBook, ni fingir que un teléfono de 2018 va fino mientras
 * el anillo tarda quince segundos en moverse.
 */
export function degradation(input: {
  profile: ProfileName;
  backend: ComputeBackend;
  fps: number;
  enrollEstimateMs?: number;
}): Degradation {
  const { profile: name, backend, fps } = input;

  if (fps > 0 && fps < MIN_USABLE_FPS) {
    return {
      level: "grave",
      message: `Tu dispositivo va a ${fps.toFixed(1)} imágenes por segundo. Va a funcionar, pero cada paso tarda: no muevas la cara hasta que el anillo avance.`,
    };
  }
  if (backend === "cpu") {
    return {
      level: "grave",
      message:
        "Este navegador no da aceleración por GPU ni WASM, así que el reconocimiento corre en JavaScript puro. Funciona, pero muy despacio.",
    };
  }
  if (name === "minimo") {
    return {
      level: "grave",
      message:
        "Detectamos un equipo lento. Bajamos la calidad de la cámara y del análisis para que no se congele; ponte en un sitio con buena luz.",
    };
  }
  if ((input.enrollEstimateMs ?? 0) > SLOW_ENROLL_MS) {
    return {
      level: "aviso",
      message: "Esto va a tardar un poco más de lo normal en tu dispositivo. No cierres la pantalla.",
    };
  }
  if (name === "bajo") {
    return {
      level: "aviso",
      message: "Ajustamos la calidad hacia abajo para que vaya fluido en tu dispositivo.",
    };
  }
  return { level: "ninguna", message: "" };
}

// ---------------------------------------------------------------------------
// Medición
// ---------------------------------------------------------------------------

/**
 * Ventana deslizante de latencias con **mediana**, no media.
 *
 * La media la arruina un solo frame malo, y en un móvil los hay siempre: un GC,
 * la compilación del primer shader, el navegador redibujando la barra de
 * direcciones al hacer scroll. Con la media, un único pico de 900 ms degrada el
 * perfil de un equipo que va bien.
 */
export class LatencyWindow {
  private readonly values: number[] = [];

  constructor(private readonly size = 12) {}

  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values.push(ms);
    if (this.values.length > this.size) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  median(): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  clear(): void {
    this.values.length = 0;
  }
}

/**
 * Cuánto esperar antes del siguiente frame.
 *
 * En un equipo rápido devuelve el resto del presupuesto (no tiene sentido correr
 * la red 120 veces por segundo si la cámara da 30). En uno lento devuelve 0: el
 * bucle ya va tarde y encolar una espera solo añadiría latencia a un frame que
 * de todas formas llegará cuando llegue.
 *
 * La clave del bucle no está aquí sino en quién lo llama: **nunca se programa un
 * frame nuevo hasta que el anterior ha resuelto su promesa**. Con `setInterval`
 * —o con un `setTimeout` fijo más corto que la detección— cada vuelta encola
 * trabajo sobre una cola que ya no se vacía, y el equipo lento no se ralentiza:
 * se muere.
 */
export function nextFrameDelay(lastFrameMs: number, budgetMs: number): number {
  if (!Number.isFinite(lastFrameMs) || lastFrameMs < 0) return budgetMs;
  return Math.max(0, budgetMs - lastFrameMs);
}

/**
 * Frames por segundo sostenidos, deducidos de la latencia mediana y el
 * presupuesto: el bucle no puede ir más rápido que el más lento de los dos.
 */
export function sustainedFps(medianFrameMs: number, budgetMs: number): number {
  const period = Math.max(medianFrameMs, budgetMs);
  return period > 0 ? 1000 / period : 0;
}
