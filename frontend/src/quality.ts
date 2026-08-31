/**
 * Diagnóstico de calidad de captura: *por qué* no está capturando.
 *
 * ## Por qué existe este módulo
 *
 * El umbral del motor se recalibró contra caras reales y subió a coseno 0.93
 * (clamps 0.92–0.96). Con un listón así, **la captura mediocre que antes pasaba
 * ahora rechaza**: la calidad del frame dejó de ser un detalle y pasó a ser la
 * variable que decide si alguien entra. Una interfaz que ante un fallo dice
 * "Mete la cara en el óvalo" no está ayudando — está describiendo el síntoma.
 *
 * Aquí se traduce lo que `face.ts` ya mide (score del detector, tamaño de caja,
 * frontalidad, nitidez laplaciana) y lo que se añadió para esto (luminancia de
 * la cara y del fondo) a **una sola causa concreta**: demasiado lejos, demasiado
 * cerca, poca luz, contraluz, cara girada, imagen movida, fuera del encuadre.
 *
 * ## Es puro a propósito
 *
 * No toca `window`, `document` ni face-api: entra un objeto de números y sale un
 * veredicto. Eso lo hace testeable con `node:test` sin navegador, igual que
 * `perf.ts`, y es lo que permite fijar por test que "cerca" y "lejos" no puedan
 * dispararse a la vez o que el estabilizador no cambie de texto en dos frames.
 *
 * ## Lo que NO hace
 *
 * No compara nada contra el servidor ni conoce el umbral del motor. El 401 de
 * `/api/identify` es opaco a propósito —devolver score/threshold convierte el
 * endpoint en un oráculo de hill-climbing—, así que la única ayuda legítima tras
 * un login fallido es la que sale de estos números, que son del cliente y no
 * dicen nada del vault. Ver `adviceAfterFailure`.
 */

/**
 * Fotometría de un frame. La calcula `face.ts` sobre un parche a resolución
 * nativa; `null` cuando todavía no se ha muestreado (la fotometría corre con
 * cadencia propia, no en cada vuelta del bucle).
 */
export type Photometry = {
  /** Luminancia media de la cara, 0–1. */
  luma: number;
  /** Luminancia media del frame entero, 0–1. Con la de la cara da el contraluz. */
  background: number;
  /** Varianza del laplaciano normalizada, 0–1. Mismo criterio que `focusScore`. */
  sharpness: number;
};

export type FrameSignals = {
  /** ¿Hay cara en el frame? Si es `false`, el resto de campos no significan nada. */
  detected: boolean;
  /** Score del detector, 0–1. */
  score: number;
  /**
   * Ancho de la caja dividido por el **lado corto** del frame.
   *
   * El lado corto y no el ancho: el recorte alineado abarca ≈1.3 × el ancho de
   * la caja (`FACE_SPAN` 3.1 × distancia interocular), y lo primero que se sale
   * del frame al acercarse es el alto. Normalizando por el lado corto, el mismo
   * número significa lo mismo en 16:9 y en 4:3.
   */
  boxRatio: number;
  /** Desviación del centro de la cara respecto al centro del frame, 0–1 (0.5 = borde). */
  offset: number;
  /** Yaw absoluto (desplazamiento de la nariz / distancia interocular). */
  yaw: number;
  /** Roll absoluto en radianes. */
  roll: number;
  photo: Photometry | null;
};

/**
 * Arma las señales de un frame a partir de números crudos.
 *
 * Vive aquí y no en `face.ts` para que la normalización —lo que se divide por
 * qué— sea testeable sin navegador. `face.ts` aporta la caja, el score, los
 * ángulos y la fotometría; esta función solo los pone en la misma escala.
 */
export function buildSignals(input: {
  score: number;
  boxWidth: number;
  centerX: number;
  centerY: number;
  frameWidth: number;
  frameHeight: number;
  yaw: number;
  roll: number;
  photo: Photometry | null;
}): FrameSignals {
  const short = Math.max(1, Math.min(input.frameWidth, input.frameHeight));
  const offsetX = Math.abs(input.centerX - input.frameWidth / 2) / Math.max(1, input.frameWidth);
  const offsetY = Math.abs(input.centerY - input.frameHeight / 2) / Math.max(1, input.frameHeight);
  return {
    detected: true,
    score: input.score,
    boxRatio: input.boxWidth / short,
    offset: Math.max(offsetX, offsetY),
    yaw: Math.abs(input.yaw),
    roll: Math.abs(input.roll),
    photo: input.photo,
  };
}

/** Señales de "no hay nadie delante". */
export const NO_FACE: FrameSignals = {
  detected: false,
  score: 0,
  boxRatio: 0,
  offset: 0,
  yaw: 0,
  roll: 0,
  photo: null,
};

export type QualityIssue =
  | "ninguno"
  | "sin-cara"
  | "fuera"
  | "lejos"
  | "cerca"
  | "contraluz"
  | "oscuro"
  | "quemado"
  | "girado"
  | "inclinado"
  | "movido"
  | "dudosa";

export type QualityVerdict = {
  issue: QualityIssue;
  /** Frase corta y accionable. Es la que se pone en grande cuando bloquea. */
  message: string;
  /** Una frase más, para la línea pequeña. Vacía cuando no aporta. */
  hint: string;
  /**
   * `true` cuando la causa impide capturar por sí sola (no hay cara, está fuera
   * del encuadre, está demasiado lejos). En ese caso la instrucción del gesto
   * pasa a segundo plano: girar la cabeza no sirve de nada si no te vemos.
   */
  blocking: boolean;
  /** Cuánto se pasa del límite, 0–1. Solo se usa para ordenar candidatas. */
  severity: number;
};

export const OK: QualityVerdict = {
  issue: "ninguno",
  message: "",
  hint: "",
  blocking: false,
  severity: 0,
};

// ---------------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------------

/**
 * Todos los límites de abajo son **de aviso**, y van por dentro de los límites
 * duros de `face.ts` (`sampleGate`: score ≥ 0.5, caja ≥ 80 px, centro dentro del
 * 26 % del frame). Esa distancia es deliberada: el objetivo es corregir *antes*
 * de fallar, no explicar el fallo después. Si el aviso saltara justo en el
 * límite duro, el usuario se enteraría de que está lejos en el mismo instante en
 * que la captura ya se descartó.
 */

/**
 * Por debajo de esto, "acércate".
 *
 * 0.33 del lado corto son 178 px en un frame de 960×540, que es justo donde
 * `captureQuality` satura su término de tamaño (`box.width / 180`). Por debajo,
 * cada píxel perdido es calidad perdida de verdad; por encima no se gana nada.
 * El límite duro (80 px = 0.148) queda muy por debajo.
 */
export const FAR_RATIO = 0.33;

/**
 * Por encima de esto, "aléjate".
 *
 * El recorte alineado abarca ≈1.3 × el ancho de la caja. Con la caja a 0.62 del
 * lado corto, el recorte pide 0.81 de ese lado: todavía cabe. Más cerca y el
 * recorte empieza a incluir lienzo vacío por arriba o por abajo, y el descriptor
 * sale de una cara recortada.
 */
export const NEAR_RATIO = 0.62;

/** Aviso de descentrado. El gate duro corta en 0.26; se avisa en 0.19. */
export const OFFSET_LIMIT = 0.19;

/**
 * Yaw a partir del cual se pide mirar de frente.
 *
 * `poseScore` anula la frontalidad en yaw 0.35 y `poseMet("center")` exige menos
 * de 0.12. 0.22 queda en medio: ya duele en el descriptor, todavía no bloquea.
 */
export const YAW_LIMIT = 0.22;

/** Roll (cabeza inclinada) en radianes. `poseScore` se anula en 0.6 rad (34°). */
export const ROLL_LIMIT = 0.3;

/** Luminancia media de la cara por debajo de la cual falta luz. */
export const DARK_LUMA = 0.28;

/** Por encima de esto la cara está quemada y se pierden los rasgos. */
export const BRIGHT_LUMA = 0.86;

/**
 * Contraluz: el fondo tiene que ser bastante más claro que la cara **y** la cara
 * tiene que estar apagada. Solo la primera condición marcaría contraluz a
 * cualquiera bien iluminado delante de una pared blanca.
 */
export const BACKLIGHT_RATIO = 1.9;
export const BACKLIGHT_FACE_LUMA = 0.45;

/**
 * Nitidez por debajo de la cual se dice "estás movido".
 *
 * Es el límite más conservador de todos a propósito: la varianza del laplaciano
 * depende de la textura de la piel, del vello facial y de la resolución que dé
 * la cámara, así que un límite alto acusaría de moverse a gente quieta. 0.12
 * sobre la escala de `focusScore` (varianza 150 = nítido) solo salta con desenfoque
 * o movimiento evidentes.
 */
export const BLUR_LIMIT = 0.12;

/** Score del detector por debajo del cual algo pasa, aunque el resto cuadre. */
export const LOW_SCORE = 0.62;

/**
 * Peso de cada causa al ordenar.
 *
 * No es un gusto: sigue los coeficientes de `captureQuality`
 * (score 0.35, tamaño 0.20, frontalidad 0.25, nitidez 0.20) más el hecho de que
 * encuadre y distancia también arrastran al score del detector. Lo que decide
 * cuál se enseña es `peso × severidad`, así que un problema pequeño de un factor
 * importante no tapa uno grave de otro.
 */
const PRIORITY: Record<Exclude<QualityIssue, "ninguno">, number> = {
  "sin-cara": 10,
  fuera: 6,
  lejos: 4,
  cerca: 3.4,
  contraluz: 3,
  oscuro: 2.6,
  quemado: 2.2,
  girado: 2,
  movido: 1.8,
  inclinado: 1.2,
  dudosa: 0.8,
};

const TEXT: Record<Exclude<QualityIssue, "ninguno">, { message: string; hint: string }> = {
  "sin-cara": {
    message: "No te vemos",
    hint: "Ponte delante de la cámara, con la cara dentro del óvalo.",
  },
  fuera: {
    message: "Céntrate en el óvalo",
    hint: "Mueve la cabeza —o el teléfono— hasta que quede en medio.",
  },
  lejos: {
    message: "Acércate un poco",
    hint: "Tu cara tiene que llenar el óvalo, no quedarse dentro de él.",
  },
  cerca: {
    message: "Aléjate un poco",
    hint: "Estás tan cerca que la barbilla y la frente se salen.",
  },
  contraluz: {
    message: "Tienes la luz detrás",
    hint: "Gírate hacia la ventana o la lámpara, en vez de darle la espalda.",
  },
  oscuro: {
    message: "Falta luz en tu cara",
    hint: "Enciende una luz o ponte de frente a la que haya.",
  },
  quemado: {
    message: "Demasiada luz directa",
    hint: "Apártate del foco o baja el brillo: se pierden tus rasgos.",
  },
  girado: {
    message: "Mira de frente",
    hint: "Gira la cara hacia la cámara, no hacia la pantalla.",
  },
  inclinado: {
    message: "Endereza la cabeza",
    hint: "Ojos a la misma altura, sin ladear.",
  },
  movido: {
    message: "Quédate quieto",
    hint: "La imagen sale movida; apoya el teléfono o para un segundo.",
  },
  dudosa: {
    message: "No acabamos de verte bien",
    hint: "Prueba con más luz de frente o acércate un poco.",
  },
};

function verdict(issue: Exclude<QualityIssue, "ninguno">, severity: number): QualityVerdict {
  return {
    issue,
    ...TEXT[issue],
    // `diagnose` no sabe si el frame se está descartando: eso lo decide el gate
    // de `face.ts`. Ver `resolveBlocking`, que es quien pone este campo.
    blocking: false,
    severity: Math.min(1, Math.max(0, severity)),
  };
}

/**
 * Qué es lo que más está costando ahora mismo. **Una sola causa**, la de mayor
 * `peso × severidad`.
 *
 * `expect` dice qué pose pide el gesto en curso: durante "gira a la izquierda"
 * el yaw alto es lo que se está pidiendo, así que no puede diagnosticarse como
 * un defecto. Sin ese matiz la interfaz se contradiría a sí misma —"gira la
 * cabeza" arriba y "mira de frente" debajo—, que es exactamente el tipo de ruido
 * que hace que la gente deje de leer.
 */
export function diagnose(
  signals: FrameSignals,
  expect: "frontal" | "perfil" = "frontal",
): QualityVerdict {
  if (!signals.detected) return verdict("sin-cara", 1);

  const candidates: QualityVerdict[] = [];
  const add = (issue: Exclude<QualityIssue, "ninguno">, severity: number) => {
    if (severity > 0) candidates.push(verdict(issue, severity));
  };

  add("fuera", (signals.offset - OFFSET_LIMIT) / (0.5 - OFFSET_LIMIT));
  add("lejos", (FAR_RATIO - signals.boxRatio) / FAR_RATIO);
  add("cerca", (signals.boxRatio - NEAR_RATIO) / NEAR_RATIO);

  if (expect === "frontal") {
    add("girado", (signals.yaw - YAW_LIMIT) / YAW_LIMIT);
  }
  add("inclinado", (signals.roll - ROLL_LIMIT) / ROLL_LIMIT);

  const photo = signals.photo;
  if (photo) {
    const backlight = photo.luma > 0 ? photo.background / photo.luma : 0;
    if (photo.luma < BACKLIGHT_FACE_LUMA && backlight > BACKLIGHT_RATIO) {
      add("contraluz", (backlight - BACKLIGHT_RATIO) / BACKLIGHT_RATIO);
    } else {
      add("oscuro", (DARK_LUMA - photo.luma) / DARK_LUMA);
      add("quemado", (photo.luma - BRIGHT_LUMA) / (1 - BRIGHT_LUMA));
    }
    add("movido", (BLUR_LIMIT - photo.sharpness) / BLUR_LIMIT);
  }

  add("dudosa", (LOW_SCORE - signals.score) / LOW_SCORE);

  let best: QualityVerdict | null = null;
  let bestWeight = 0;
  for (const candidate of candidates) {
    const weight = PRIORITY[candidate.issue as Exclude<QualityIssue, "ninguno">] * candidate.severity;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = candidate;
    }
  }
  return best ?? OK;
}

/**
 * Decide si la causa **bloquea**, y lo decide el gate, no el aviso.
 *
 * Esto salió de verlo funcionando: los límites de aviso de arriba van todos por
 * dentro de los duros de `sampleGate` —a propósito, para poder corregir antes de
 * fallar— así que hay una franja en la que la interfaz dice "acércate un poco" y
 * la captura **sí** entra. Marcar ahí el titular como bloqueante era mentira: la
 * pantalla gritaba un arreglo que no hacía falta, y un instante después el
 * anillo avanzaba igual.
 *
 * La regla honesta es una sola: bloquea lo que el gate está rechazando de
 * verdad. Si el frame pasa, la causa baja a consejo y la instrucción del gesto
 * se queda arriba. Si el frame no pasa y encima ninguna causa saltó —queda el
 * mínimo de **alto** de caja, que no tiene aviso propio porque una cara nunca es
 * más ancha que alta— se dice "dudosa" en vez de quedarse mudo, que era el fallo
 * original.
 */
export function resolveBlocking(v: QualityVerdict, framed: boolean): QualityVerdict {
  if (framed) return v.blocking ? { ...v, blocking: false } : v;
  if (v.issue === "ninguno") return { ...verdict("dudosa", 0.5), blocking: true };
  return { ...v, blocking: true };
}

// ---------------------------------------------------------------------------
// Estabilizador
// ---------------------------------------------------------------------------

/** Vueltas seguidas con el mismo veredicto antes de creérselo. */
export const STABLE_FRAMES = 4;

/**
 * Tiempo mínimo que un mensaje se queda en pantalla, en ms.
 *
 * El bucle corre a 15–30 fps: sin esto, el texto cambiaría cada 40 ms y sería
 * ilegible aunque cada frase fuese correcta. Los frames solos no bastan como
 * medida —en un equipo rápido cuatro frames son 130 ms— así que hacen falta las
 * dos condiciones. 600 ms es aproximadamente lo que tarda alguien en leer tres
 * palabras y empezar a reaccionar.
 */
export const MIN_DWELL_MS = 600;

/**
 * Cuánto tiene que aguantar un bloqueo antes de que el consejo **sustituya** a
 * la instrucción del gesto, en ms.
 *
 * `MIN_DWELL_MS` resuelve un problema distinto: que el texto no parpadee. Este
 * resuelve el que se vio probándolo con una cara de verdad — alguien que se está
 * colocando pasa por "no te vemos", "céntrate", "acércate" en cosa de un segundo
 * mientras ya se está corrigiendo solo, y un titular que salta a la primera es
 * ruido que además tapa el gesto que había que hacer.
 *
 * 1400 ms es aproximadamente el tiempo que tarda alguien en acabar un
 * movimiento que ya había empezado. Por debajo, la pantalla habla encima del
 * usuario; por encima, se queda callada cuando de verdad hace falta.
 *
 * Ojo con la suma: el veredicto todavía tiene que pasar por el estabilizador
 * (4 vueltas **y** 600 ms) antes de que este reloj empiece a contar, así que el
 * peor caso hasta ver el consejo son ~2 s. Es deliberado: el caso de verdad
 * bloqueante —no hay nadie delante— no se arregla solo y esperar dos segundos no
 * cuesta nada; el caso frecuente —te estás colocando— se arregla solo y no
 * merece un titular.
 */
export const COACH_DELAY_MS = 1400;

/**
 * ¿Toca ya cambiar el titular por el consejo?
 *
 * Vive aquí, junto al estabilizador que produce `heldMs`, y no en el componente:
 * es la regla de "cuándo hablar", que es exactamente lo que este módulo decide.
 */
export function coachReady(verdict: QualityVerdict, heldMs: number): boolean {
  return verdict.blocking && verdict.issue !== "ninguno" && heldMs >= COACH_DELAY_MS;
}

/**
 * Causas que ensucian la imagen sin impedir la captura.
 *
 * Son justo las que enseñaban los medidores de "Luz" y "Nitidez". El gate las
 * deja pasar, así que nunca bloquean y nunca se llevan el titular; lo que hacen
 * ahora es teñir el anillo de ámbar. Sigue habiendo texto para ellas, pero en la
 * región `aria-live`, no como un bloque más en pantalla.
 */
const IMAGE_ISSUES: ReadonlySet<QualityIssue> = new Set<QualityIssue>([
  "oscuro",
  "quemado",
  "contraluz",
  "movido",
]);

/** ¿Debe el anillo avisar de que la imagen no acompaña? */
export function imageWarning(verdict: QualityVerdict): boolean {
  return IMAGE_ISSUES.has(verdict.issue);
}

/**
 * Antihistérico del diagnóstico.
 *
 * El detector pierde la cara un frame de cada tantos —un parpadeo, una mano que
 * pasa— y la fotometría se mueve con cualquier sombra. Mostrar el veredicto
 * crudo haría parpadear el texto. Aquí un veredicto nuevo tiene que repetirse
 * `STABLE_FRAMES` vueltas seguidas **y** haber pasado `MIN_DWELL_MS` desde el
 * último cambio antes de sustituir al que está en pantalla.
 */
export class StableDiagnosis {
  private shown: QualityVerdict = OK;
  private pending: QualityIssue = "ninguno";
  private streak = 0;
  private changedAt = 0;

  constructor(
    private readonly frames = STABLE_FRAMES,
    private readonly dwellMs = MIN_DWELL_MS,
  ) {}

  /** Devuelve el veredicto que debe estar en pantalla ahora. */
  update(next: QualityVerdict, now: number): QualityVerdict {
    if (this.changedAt === 0) this.changedAt = now;

    if (next.issue === this.pending) this.streak += 1;
    else {
      this.pending = next.issue;
      this.streak = 1;
    }

    if (next.issue === this.shown.issue) {
      // Mismo problema: se refresca la severidad sin reiniciar el reloj.
      this.shown = next;
      return this.shown;
    }
    if (this.streak >= this.frames && now - this.changedAt >= this.dwellMs) {
      this.shown = next;
      this.changedAt = now;
    }
    return this.shown;
  }

  get current(): QualityVerdict {
    return this.shown;
  }

  /**
   * Cuánto lleva en pantalla el veredicto que se está mostrando, en ms.
   *
   * `changedAt` ya existía y ya se movía en el único sitio correcto —cuando el
   * veredicto **mostrado** cambia, no cuando cambia el crudo—, así que el
   * retardo del consejo sale de leerlo, no de un segundo temporizador que se
   * desincronizaría con este.
   */
  heldMs(now: number): number {
    return this.changedAt === 0 ? 0 : Math.max(0, now - this.changedAt);
  }

  reset(): void {
    this.shown = OK;
    this.pending = "ninguno";
    this.streak = 0;
    this.changedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Indicadores de luz y nitidez
// ---------------------------------------------------------------------------

export type MeterLevel = "baja" | "correcta" | "alta" | "desconocida";

/**
 * Nivel de luz en palabras.
 *
 * Se enseñaba en primer plano, con barrita y todo, junto al de nitidez. Los dos
 * medidores estaban puestos siempre, decían casi siempre lo mismo y competían
 * con la instrucción por la mirada de alguien que estaba intentando girar la
 * cabeza. Ahora el aviso de que la imagen no acompaña lo da el anillo (ámbar), y
 * estas palabras viven en "Detalles técnicos" y en la región `aria-live`: donde
 * se pueden consultar sin estorbar.
 *
 * Siguen siendo **palabras** y no solo un color, por lo de siempre: un indicador
 * que solo cambia de tono no le dice nada a quien no distingue verde de ámbar.
 */
export function lightLevel(photo: Photometry | null): MeterLevel {
  if (!photo) return "desconocida";
  if (photo.luma < DARK_LUMA) return "baja";
  if (photo.luma > BRIGHT_LUMA) return "alta";
  return "correcta";
}

export function sharpnessLevel(photo: Photometry | null): MeterLevel {
  if (!photo) return "desconocida";
  return photo.sharpness < BLUR_LIMIT ? "baja" : "correcta";
}

/*
 * Aquí vivían `lightFill` y `sharpnessFill`, que devolvían un 0–1 para el ancho
 * de las barritas. Sin barritas no hay nada que rellenar, y mantener el cálculo
 * costaba dos escrituras en el estado de React por muestreo de fotometría solo
 * para mover cuatro píxeles.
 */

// ---------------------------------------------------------------------------
// Después de un fallo
// ---------------------------------------------------------------------------

/**
 * Calidad por debajo de la cual una toma se considera floja.
 *
 * **Es una heurística de interfaz, no una constante medida.** Sale de la propia
 * fórmula de `captureQuality` (0.35·score + 0.2·tamaño + 0.25·frontalidad +
 * 0.2·nitidez): una toma buena de verdad ronda 0.85, y 0.62 es donde al menos
 * dos de los cuatro factores tienen que estar a medias. Sirve para decidir si
 * merece la pena sugerir algo concreto; no decide nada del match.
 */
export const WEAK_CAPTURE = 0.62;

/**
 * Qué decirle a alguien cuyo login no coincidió.
 *
 * **La distinción la hace el cliente con sus propios números.** El 401 de
 * `/api/identify` no trae score ni umbral —y no debe traerlos: con ellos, quien
 * quisiera podría escalar un descriptor sintético hasta pasar el listón sin
 * tener cara— así que la respuesta del servidor no puede decir nada de por qué
 * falló. Lo que sí se sabe aquí es cómo salió la foto:
 *
 * - Si la mejor toma del intento fue floja, se dice y se sugiere el arreglo
 *   concreto que se estaba viendo en pantalla. Esa información ya la tenía el
 *   usuario delante; no revela nada del vault.
 * - Si la toma fue buena y aun así no hubo coincidencia, **el mensaje se queda
 *   genérico**. Acercarlo al motivo real del servidor sería justo el oráculo que
 *   el 401 opaco evita.
 */
export function adviceAfterFailure(
  bestQuality: number,
  lastIssue: QualityIssue,
): { weak: boolean; message: string } {
  if (bestQuality >= WEAK_CAPTURE) {
    return {
      weak: false,
      message:
        "No hubo coincidencia. Si es tu cuenta, vuelve a intentarlo; si nunca te registraste, configura tu rostro primero.",
    };
  }
  const known = lastIssue !== "ninguno" && lastIssue !== "dudosa" ? TEXT[lastIssue] : null;
  return {
    weak: true,
    message: known
      ? `La toma salió floja. ${known.hint} Después vuelve a intentarlo.`
      : "La toma salió floja: poca luz o demasiada distancia. Colócate mejor y vuelve a intentarlo.",
  };
}
