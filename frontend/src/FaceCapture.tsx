import { useEffect, useRef, useState } from "react";
import { cameraErrorMessage, openCamera, streamResolution } from "./camera";
import {
  computeBackend,
  deviceProfile,
  extractDescriptors,
  getAugmentationLevel,
  grabFrame,
  loadModels,
  photometryCostMs,
  poseAngles,
  sampleGate,
  samplePhotometry,
  setDeviceProfile,
  trackLandmarks,
  variantCostMs,
} from "./face";
import {
  lookingAtCamera,
  opennessFromBlink,
  shapeSignature,
  trackMesh,
  type FaceMesh,
} from "./mesh";
import {
  BlinkTracker,
  eyeSignal,
  eyesOpenForSample,
  PlanarPad,
  poseMet,
  poseMetYaw,
  screenYaw,
  type ChallengeId,
  type EnrollCondition,
} from "./liveness";
import { modelLoadStats } from "./models";
import { playCue, unlockCue } from "./feedback";
import { applyView, Viewfinder, viewModeFor } from "./viewfinder";
import {
  adjustProfile,
  degradation,
  enrollEstimateMs,
  LatencyWindow,
  nextFrameDelay,
  profile as profileByName,
  type Degradation,
  type DeviceProfile,
} from "./perf";
import {
  adviceAfterFailure,
  buildSignals,
  coachReady,
  diagnose,
  imageWarning,
  lightLevel,
  NO_FACE,
  OK,
  resolveBlocking,
  sharpnessLevel,
  StableDiagnosis,
  type MeterLevel,
  type Photometry,
  type QualityIssue,
  type QualityVerdict,
} from "./quality";
import {
  drawCapture,
  glanceDotDone,
  glanceDots,
  ovalGeometry,
  ovalPath,
  type Insets,
  type Lock,
} from "./overlay";
import { voiceChallenge, type VoiceProof } from "./api";
import { ENROLL_CAPTCHA_SCORE, humanConfidence, lastHeard, SpanTracker, wordHeard } from "./human";
import { listenSpeech, openMicMeter, speechSupported } from "./voice";

/** Una captura válida: los descriptores aumentados de un frame y su calidad. */
export type Capture = {
  condition: string;
  descriptors: number[][];
  quality: number;
  /** Firma 3D de la malla (64-d). No es una foto. */
  shape?: number[];
};

export type ModelState = "idle" | "loading" | "ready" | "error";

/** Qué se está haciendo. Cambia cómo se explica un fallo, no cómo se captura. */
export type Flow = "enroll" | "login";

/**
 * Copia de pantalla, no de la lógica.
 *
 * `challengeLabel()` de `liveness.ts` devuelve frases largas pensadas para una
 * línea de estado ("Mira de frente y quédate quieto"). Aquí la instrucción es el
 * elemento tipográfico principal y tiene que caber en una pantalla de 360 px, así
 * que se acorta. No se tocó `liveness.ts` para no rozar el módulo medido.
 */
const INSTRUCTIONS: Record<ChallengeId, string> = {
  center: "Mira aquí",
  blink: "Parpadea",
  left: "Sigue el punto",
  right: "Sigue el punto",
};

/*
 * Aquí vivía `PENDING`, la versión en minúscula de cada gesto para la línea
 * "Luego: girar la cabeza a la izquierda". Era el tercer bloque de texto del
 * pie, y solo aparecía cuando ya había un consejo ocupando el sitio de la
 * instrucción: exactamente el momento en el que menos falta hace enseñar dos
 * cosas más.
 */

/** Distingue "no hay cámara" de "no bajaron los modelos" en el mismo `catch`. */
class ModelError extends Error {}

/**
 * Cada cuántos frames se revisa el perfil. 10 a ~15 fps es menos de un segundo:
 * suficiente para reaccionar rápido, y bastante para que la mediana signifique
 * algo. Revisar en cada frame haría que un solo pico moviera el perfil, y
 * cambiar de perfil implica recompilar los shaders del nuevo `inputSize`.
 */
const PROFILE_REVIEW_FRAMES = 10;

/**
 * Vueltas del bucle con la pose superada antes de disparar la captura.
 *
 * Estaba escrito como un `3` suelto dentro del bucle. Ahora es una constante
 * porque además **se enseña**: el anillo se llena durante esas tres vueltas, así
 * que el número dejó de ser un detalle interno y pasó a ser algo que el usuario
 * ve moverse.
 */
const ENROLL_HOLD_FRAMES = 3;
/** En el login el hold corto + blink flojo dejaba pasar una foto en un segundo. */
const LOGIN_HOLD_FRAMES = 10;

/**
 * Cadencia de la fotometría, en frames.
 *
 * La luz de una habitación no cambia en 200 ms, así que medirla en cada vuelta
 * sería pagar un `getImageData` por frame para redibujar el mismo número. En los
 * perfiles con presupuesto holgado se muestrea 1 de cada 3 vueltas; en los
 * lentos, 1 de cada 6, porque ahí cada milisegundo del presupuesto ya está
 * comprometido. El coste medido sale en "Rendimiento" para que se pueda auditar
 * en vez de creérselo.
 */
function photoEvery(profile: DeviceProfile): number {
  return profile.frameBudgetMs <= 66 ? 3 : 6;
}

/** Cuánto se queda en pantalla el acuse de una captura, en ms. */
const SHOT_NOTICE_MS = 1500;

/** Métricas por etapa. Las lee "Detalles técnicos" y el banco de medición. */
export type CaptureStats = {
  profile: DeviceProfile["name"];
  backend: string;
  augment: string;
  fps: number;
  /** Mediana del frame completo. Es lo que se compara con el presupuesto del perfil. */
  frameMs: number;
  /** Última detección de seguimiento sola, sin la copia del vídeo ni el overlay. */
  trackMs: number;
  detectMs: number;
  alignMs: number;
  describeMs: number;
  variantMs: number;
  /** Coste de la última fotometría (luz + nitidez). Es el añadido del diagnóstico. */
  photoMs: number;
  frames: number;
  resolution: string;
  modelMs: number;
  modelFromCache: number;
  /** Zoom digital actual. 1 = frame entero; >1 la cámara “sigue” la cara. */
  zoom: number;
};

const EMPTY_STATS: CaptureStats = {
  profile: "medio",
  backend: "—",
  augment: "light",
  fps: 0,
  frameMs: 0,
  trackMs: 0,
  detectMs: 0,
  alignMs: 0,
  describeMs: 0,
  variantMs: 0,
  photoMs: 0,
  frames: 0,
  resolution: "—",
  modelMs: 0,
  modelFromCache: 0,
  zoom: 1,
};

/**
 * Luz y nitidez, en palabras y nada más.
 *
 * Antes esto llevaba además dos rellenos 0–1 cuantizados al 5 % para las
 * barritas. Sin barritas, lo único que queda es una palabra que cambia como
 * mucho un puñado de veces por sesión: se acabaron los re-renders por muestreo
 * de fotometría. Solo lo lee "Detalles técnicos" y la región `aria-live`.
 */
type Meters = { light: MeterLevel; sharp: MeterLevel };

const EMPTY_METERS: Meters = { light: "desconocida", sharp: "desconocida" };

/**
 * Plan de recuperación tras un fallo del servidor.
 *
 * Lo importante es `retryPhase`: **repetir solo la tanda que falló**. Antes, un
 * enrollo rechazado por el servidor tiraba las diez capturas y devolvía al
 * usuario al principio; con dos rondas de cinco gestos hechas, eso es
 * inaceptable. Las capturas viven en un ref que sobrevive al fallo, así que
 * borrar solo las de una condición y volver a pedirlas es cuestión de filtrar.
 */
type Recovery = {
  title: string;
  detail: string;
  /** Mensaje literal del servidor. Va plegado, no en la cara del usuario. */
  raw: string;
  /** Índice de la condición a repetir, o `null` si no se puede acotar. */
  retryPhase: number | null;
  retryLabel: string;
  /** No tiene sentido recapturar: la cara ya existe. */
  leave?: boolean;
};

/**
 * Aviso de degradación, ahora **solo el grave y solo en la cabecera**.
 *
 * Iba en el pie, encima de la instrucción, y era uno de los bloques de texto que
 * competían con ella. Los dos niveles no valen lo mismo: "grave" dice que la
 * captura va a ir a trompicones y cambia lo que la persona tiene que hacer
 * —esperar al anillo en vez de moverse—, mientras que "aviso" solo dice que
 * bajamos la calidad, que es información de auditoría y no de uso.
 *
 * Así que el grave se queda, arriba, pequeño y lejos de la instrucción; el aviso
 * baja a "Detalles técnicos". Los dos siguen anunciándose por `aria-live`, que
 * es donde de verdad no se pierde nada.
 */
function Degraded({ notice }: { notice: Degradation }) {
  if (notice.level !== "grave") return null;
  return (
    <p className="capture__degraded" data-level={notice.level}>
      {notice.message}
    </p>
  );
}

/**
 * Tamaño de un elemento, **en caja de borde**.
 *
 * Medía `contentRect`, que excluye el relleno. Cabecera y pie llevan los suyos
 * —16 px arriba, 34 px o más abajo por el `safe-area-inset`— así que los
 * `insets` que recibía el óvalo se quedaban unos 50 px cortos en total y la guía
 * se dibujaba más grande y más baja de lo que cabía. En un móvil con la barra de
 * inicio eso es exactamente el borde por el que el óvalo se salía.
 *
 * `borderBoxSize` es lo que hay que mirar; el `?? contentRect` es para
 * navegadores viejos, donde el fallo vuelve pero no rompe nada.
 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Separación entre tramos, en unidades de `pathLength` (el óvalo mide 100).
 *
 * No es un porcentaje fijo del tramo: con pocos gestos un hueco
 * proporcional dejaría dos comas gigantes, y con diez (el enrollo con lentes) se
 * comería el tramo entero. Se acota a un rango donde el hueco siempre se lee
 * como separación y nunca como ausencia.
 */
function segmentGap(total: number): number {
  return Math.min(3.2, Math.max(1.1, (100 / Math.max(1, total)) * 0.22));
}

/**
 * El anillo, ahora **por tramos**, al estilo del registro de Face ID.
 *
 * Antes eran dos piezas separadas que decían lo mismo dos veces: un arco continuo
 * que se llenaba (cuánto falta, en analógico) y una fila de puntos bajo el título
 * (cuántos pasos hay y en cuál voy). El arco no se podía contar y los puntos
 * estaban lejos de la cara, así que hacían falta los dos. Un tramo por gesto
 * resuelve las dos preguntas en el mismo sitio donde la persona ya está mirando
 * —su propia cara— y de un vistazo: los tramos encendidos son los hechos, los
 * apagados los que quedan.
 *
 * Sigue en SVG y no en el canvas por lo de siempre: el llenado es una transición
 * de CSS y el pulso un `@keyframes`, así que los dos desaparecen solos con
 * `prefers-reduced-motion: reduce` sin una línea de lógica extra.
 *
 * `hold` llena el tramo **en curso** durante las tres vueltas que hay que
 * aguantar la pose. Esas tres vueltas eran antes un hueco mudo en el que la
 * gente se movía justo antes del disparo.
 *
 * El `data-state` del `<svg>` es lo que sustituye a los medidores de luz y
 * nitidez: el mismo anillo se tiñe de ámbar cuando la imagen no acompaña.
 */
function ProgressRing({
  width,
  height,
  insets,
  total,
  done,
  hold,
  state,
  pulse,
  glance,
  glanceStep = 0,
}: {
  width: number;
  height: number;
  insets: Insets;
  /** Gestos de toda la sesión, rondas incluidas. Un tramo cada uno. */
  total: number;
  /** Gestos ya capturados. */
  done: number;
  /** Relleno del tramo en curso, 0–1. */
  hold: number;
  state: Lock;
  pulse: number;
  glance?: ChallengeId;
  /** Progreso de ESTA ronda (0–2). No el total de la sesión. */
  glanceStep?: number;
}) {
  if (width < 2 || height < 2) return null;
  const oval = ovalGeometry(width, height, insets);
  const path = ovalPath(oval);
  const slots = Math.max(1, total);
  const slot = 100 / slots;
  const gap = segmentGap(slots);
  const length = slot - gap;
  const held = Math.min(1, Math.max(0, hold));

  return (
    <svg className="ring" viewBox={`0 0 ${width} ${height}`} data-state={state} aria-hidden="true">
      {/* Traza tenue continua: sin ella, con pocos tramos el óvalo dejaba de
          leerse como óvalo y la guía de encuadre se perdía. */}
      <path className="ring__track" d={path} />
      {Array.from({ length: slots }, (_, index) => {
        // `stroke-dashoffset` negativo adelanta el patrón: es lo que coloca cada
        // raya en su sitio del recorrido sin tener que trocear el `path`.
        const start = -(index * slot + gap / 2);
        const filled = index < done;
        return (
          <g key={index}>
            <path
              className="ring__seg"
              d={path}
              pathLength={100}
              data-on={filled || undefined}
              style={{ strokeDasharray: `${length} ${100 - length}`, strokeDashoffset: start }}
            />
            {!filled && index === done && held > 0 && (
              <path
                className="ring__hold"
                d={path}
                pathLength={100}
                style={{
                  strokeDasharray: `${length * held} ${100 - length * held}`,
                  strokeDashoffset: start,
                }}
              />
            )}
          </g>
        );
      })}
      {pulse > 0 && <path key={pulse} className="ring__pulse" d={path} pathLength={100} />}
      {glanceDots(oval).map((dot) => (
        <circle
          key={dot.id}
          className="glance__dot"
          cx={dot.x}
          cy={dot.y}
          r={glance === dot.id ? 11 : 5}
          data-on={glance === dot.id || undefined}
          data-done={glance !== dot.id && glanceDotDone(dot.id, glanceStep) ? true : undefined}
        />
      ))}
    </svg>
  );
}

type VoiceGate =
  | { phase: "load" }
  | {
      phase: "speak";
      id: string;
      words: string[];
      spoken: boolean[];
      heard: boolean[];
      mouths: number[];
      mouthNow: number;
      transcript: string;
    }
  | { phase: "error"; message: string };

export function FaceCapture({
  title,
  flow,
  challenges,
  conditions,
  error,
  forceVoice = false,
  onComplete,
  onError,
  onCancel,
  onLogin,
}: {
  title: string;
  flow: Flow;
  challenges: ChallengeId[];
  /** La secuencia de gestos se repite una vez por condición. */
  conditions: EnrollCondition[];
  error: string;
  /** Aparato nuevo: el captcha de voz va sí o sí, no solo si la cara se ve rara. */
  forceVoice?: boolean;
  onComplete: (captures: Capture[], voice?: VoiceProof) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
  /** 409: la cara ya existe. Va a entrar, no a casa. */
  onLogin?: () => void;
}) {
  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  /**
   * Cabecera y pie se **miden**, no se estiman.
   *
   * El óvalo se centra en el hueco que dejan, así que si el diagnóstico añade
   * una línea —o si la ronda de los lentes añade su etiqueta— el óvalo se aparta
   * solo en vez de acabar debajo del texto. Estimarlo con un `@media` funcionaba
   * en el móvil de referencia y fallaba en cuanto cambiaba el contenido.
   */
  const [headRef, headSize] = useElementSize<HTMLElement>();
  const [footRef, footSize] = useElementSize<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const viewFrameRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const viewRef = useRef(new Viewfinder());
  const streamRef = useRef<MediaStream | null>(null);
  const blinkRef = useRef(new BlinkTracker());
  const padRef = useRef(new PlanarPad());
  const lastMeshRef = useRef<FaceMesh | null>(null);
  const offFrontRef = useRef(0);
  const seenBlinkRef = useRef(false);
  const mouthRef = useRef(new SpanTracker());
  const voiceRef = useRef(false);
  const voiceProofRef = useRef<VoiceProof | undefined>(undefined);
  const finishingVoiceRef = useRef(false);
  const capturesRef = useRef<Capture[]>([]);
  const holdRef = useRef(0);
  const pendingBlinkRef = useRef(false);
  const completeRef = useRef(onComplete);
  const errorRef = useRef(onError);
  completeRef.current = onComplete;
  errorRef.current = onError;

  /**
   * La ventana de latencias vive en un ref, no en el efecto: el efecto del bucle
   * se vuelve a montar en cada gesto capturado (cambia `step`), y con la ventana
   * dentro se perdería la medición justo cuando ya empezaba a ser fiable.
   */
  const latencyRef = useRef(new LatencyWindow());
  const framesRef = useRef(0);
  const fpsRef = useRef({ since: 0, count: 0 });
  const statsRef = useRef<CaptureStats>(EMPTY_STATS);

  /** Última fotometría medida. En un ref: el diagnóstico la lee sin repintar. */
  const photoRef = useRef<Photometry | null>(null);
  /** Estabilizador del diagnóstico, para que el texto no parpadee cada 70 ms. */
  const diagRef = useRef(new StableDiagnosis());
  /** Última causa mostrada. La usa el consejo tras un login fallido. */
  const issueRef = useRef<QualityIssue>("ninguno");

  const [step, setStep] = useState(0);
  /**
   * Rondas pendientes, por índice de condición.
   *
   * No es un contador que sube: es una **cola**. Con un contador no se podía
   * repetir solo la ronda que el servidor rechazó — al terminarla, la lógica de
   * "¿queda otra?" volvía a pedir la que ya estaba bien.
   */
  const [queue, setQueue] = useState<number[]>(() => conditions.map((_, index) => index));
  const [captured, setCaptured] = useState(0);
  const [instruction, setInstruction] = useState("Preparando la cámara…");
  const [verdict, setVerdict] = useState<QualityVerdict>(OK);
  /**
   * ¿Le quita ya el consejo el titular al gesto?
   *
   * Es un booleano y no un cálculo del render porque depende del **tiempo**: el
   * bloqueo tiene que haber aguantado `COACH_DELAY_MS`, y ese reloj solo lo
   * puede leer el bucle, que es quien tiene el `now` de cada vuelta. Ver
   * `coachReady` en `quality.ts`.
   */
  const [speaking, setSpeaking] = useState(false);
  const [meters, setMeters] = useState<Meters>(EMPTY_METERS);
  const [hold, setHold] = useState(0);
  const [lock, setLock] = useState<Lock>("none");
  const [pulse, setPulse] = useState(0);
  const [shotNotice, setShotNotice] = useState(0);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [models, setModels] = useState<ModelState>("idle");
  /** Qué falló: cambia el titular, porque "no pudimos usar la cámara" sería mentira
      si lo que no bajó fueron los modelos del CDN. */
  const [failure, setFailure] = useState<"camera" | "models">("camera");
  /** Condición pendiente de confirmar: el usuario tiene que quitarse los lentes. */
  const [handoff, setHandoff] = useState<EnrollCondition | null>(null);
  /** Fallo del servidor con su plan de recuperación. Congela el bucle mientras está. */
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  /**
   * iOS y Android bloquean `video.play()` si se llama fuera del gesto del
   * usuario, y `await openCamera()` rompe la cadena del gesto original. Cuando
   * pasa, en vez de dejar un rectángulo negro eterno se pide el toque explícito.
   */
  const [needsTap, setNeedsTap] = useState(false);
  const [voiceGate, setVoiceGate] = useState<VoiceGate | null>(null);
  const [stats, setStats] = useState<CaptureStats>(EMPTY_STATS);
  /** Espejo de `insets` para el bucle: leerlo del estado remontaría el efecto en
      cada cambio de texto, y el efecto arranca un `tick` nuevo cada vez. */
  const insetsRef = useRef<Insets>({ top: 0, bottom: 0 });
  const [notice, setNotice] = useState<Degradation>({ level: "ninguna", message: "" });

  const insets: Insets = { top: headSize.height + 12, bottom: footSize.height + 12 };
  insetsRef.current = insets;
  const current = challenges[step];
  const phase = queue[0] ?? conditions.length - 1;
  const condition = conditions[Math.min(phase, conditions.length - 1)];
  const perRound = challenges.length;
  const total = perRound * conditions.length;
  const fatal = Boolean(error) && !live;
  const multi = conditions.length > 1;

  /* `doneFor` contaba las capturas de una condición para pintar sus puntos de
     progreso. Sin puntos no hace falta: el anillo cuenta gestos de la sesión
     entera, no de una ronda, y `captured` ya es ese número. */

  /** Cuántas capturas sobreviven a repetir la ronda `index`. Es el argumento de venta. */
  const kept = (index: number) => {
    const id = conditions[index]?.id;
    return capturesRef.current.filter((capture) => capture.condition !== id).length;
  };

  useEffect(() => {
    if (shotNotice === 0) return;
    const timer = window.setTimeout(() => setShotNotice(0), SHOT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [shotNotice]);

  /**
   * Publica las métricas a la UI **como mucho una vez por segundo**.
   *
   * Escribirlas en el estado de React en cada frame provocaría un re-render por
   * frame: el propio medidor se convertiría en la carga que mide. Los valores
   * en vivo viven en `statsRef` (lectura barata, sin render) y solo el resumen
   * cruza a `setStats`.
   */
  function publishStats(trackMs: number) {
    const now = performance.now();
    const meter = fpsRef.current;
    meter.count += 1;
    if (meter.since === 0) meter.since = now;
    const elapsed = now - meter.since;
    if (elapsed < 1000) return;

    const fps = (meter.count * 1000) / elapsed;
    meter.since = now;
    meter.count = 0;

    const profile = deviceProfile();
    const next: CaptureStats = {
      ...statsRef.current,
      profile: profile.name,
      backend: computeBackend(),
      augment: getAugmentationLevel(),
      fps,
      frameMs: latencyRef.current.median(),
      trackMs,
      variantMs: variantCostMs(),
      photoMs: photometryCostMs(),
      frames: framesRef.current,
      resolution: streamResolution(streamRef.current),
      modelMs: Math.round(modelLoadStats().ms),
      modelFromCache: modelLoadStats().fromCache,
      zoom: viewRef.current.scale,
    };
    statsRef.current = next;
    // Espejo para el banco de medición (`scripts/perf/`). Es solo lectura y son
    // los mismos números que la UI enseña en "Detalles técnicos": no expone nada
    // que el usuario no pueda ver desplegando ese bloque.
    (window as Window & { __faceloginStats?: CaptureStats }).__faceloginStats = next;
    setStats(next);
    setNotice((previous) => {
      const fresh = degradation({
        profile: profile.name,
        backend: computeBackend(),
        fps,
        enrollEstimateMs: enrollEstimateMs(
          getAugmentationLevel(),
          variantCostMs(),
          challenges.length,
          conditions.length,
        ),
      });
      return fresh.level === previous.level && fresh.message === previous.message
        ? previous
        : fresh;
    });
  }

  /**
   * Luz y nitidez, publicadas **solo cuando cambian de palabra**.
   *
   * Antes cruzaba también el relleno de las barritas, cuantizado al 5 % para no
   * repintar en balde; ahora no hay barritas y solo cruzan dos palabras, que en
   * una sesión entera cambian un puñado de veces. El re-render por muestreo de
   * fotometría desapareció del todo.
   */
  function publishMeters() {
    const photo = photoRef.current;
    const next: Meters = { light: lightLevel(photo), sharp: sharpnessLevel(photo) };
    setMeters((previous) =>
      previous.light === next.light && previous.sharp === next.sharp ? previous : next,
    );
  }

  /** Desglose por etapa de la última extracción. Es el número caro del enrollo. */
  function recordExtraction(shot: {
    detectMs: number;
    alignMs: number;
    describeMs: number;
  }) {
    statsRef.current = {
      ...statsRef.current,
      detectMs: shot.detectMs,
      alignMs: shot.alignMs,
      describeMs: shot.describeMs,
    };
  }

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        errorRef.current("");
        setModels("loading");

        /**
         * Cámara y modelos **en paralelo**, no en serie.
         *
         * Los pesos ya se están precargando desde que se montó la app, así que
         * lo normal es que `loadModels()` resuelva enseguida; pero encadenarlo
         * detrás de `getUserMedia` sumaría los dos tiempos en el caso frío. En
         * paralelo, el tiempo hasta el primer frame es el máximo de los dos, no
         * la suma. El perfil se lee después de que los modelos resuelvan, que es
         * cuando ya está calibrado por el backend elegido.
         */
        const modelsPromise = loadModels().catch(() => {
          throw new ModelError(
            "No se pudieron cargar los modelos faciales. Revisa tu conexión y reintenta.",
          );
        });
        const stream = await openCamera(deviceProfile());
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        viewRef.current.reset();
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        if (video.readyState < 2) {
          await new Promise<void>((resolve) => {
            video.onloadedmetadata = () => resolve();
          });
        }
        if (cancelled) return;
        try {
          await video.play();
          unlockCue();
          setNeedsTap(false);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Autoplay bloqueado: no es un fallo de cámara, es una política del
          // navegador que se resuelve con un toque.
          if (error instanceof DOMException && error.name === "NotAllowedError") {
            setNeedsTap(true);
          } else {
            throw error;
          }
        }
        setLive(true);
        setInstruction("Un momento…");
        await modelsPromise;
        if (cancelled) return;
        setModels("ready");
        setInstruction(INSTRUCTIONS[challenges[0]]);
      } catch (error) {
        if (cancelled) return;
        setModels("error");
        setLive(false);
        setFailure(error instanceof ModelError ? "models" : "camera");
        // Los textos de error de cámara viven en `camera.ts`; aquí solo se muestran.
        errorRef.current(cameraErrorMessage(error));
      }
    }

    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [challenges, attempt]);

  useEffect(() => {
    if (!live || models !== "ready" || busy || handoff || needsTap || recovery) return;
    let cancelled = false;
    let timer = 0;
    let raf = 0;

    // Solo se re-renderiza cuando el texto o el estado cambian de verdad: el
    // bucle corre decenas de veces por segundo y escribir el mismo valor en cada
    // vuelta repintaba la pantalla entera sin motivo.
    const say = (message: string) =>
      setInstruction((previous) => (previous === message ? previous : message));
    const setLockState = (next: Lock) => setLock((previous) => (previous === next ? previous : next));
    const setHoldState = (next: number) => setHold((previous) => (previous === next ? previous : next));

    /**
     * El veredicto de calidad cruza a React **solo cuando cambia de causa**. La
     * severidad se refresca cada vuelta dentro del estabilizador, pero repintar
     * por un decimal sería exactamente el re-render por frame que el resto del
     * bucle evita con cuidado.
     *
     * Y con él cruza `speaking`, que es lo mismo pero con reloj: cuánto lleva ese
     * veredicto puesto. También booleano, también publicado solo al cambiar.
     */
    const publishVerdict = (next: QualityVerdict, now: number) => {
      issueRef.current = next.issue;
      setVerdict((previous) => (previous.issue === next.issue ? previous : next));
      const ready = coachReady(next, diagRef.current.heldMs(now));
      setSpeaking((previous) => (previous === ready ? previous : ready));
    };

    /**
     * El bucle **no se programa con `setInterval` ni con un `setTimeout` fijo**.
     *
     * Ese era el fallo de fondo del diseño anterior: un intervalo constante que
     * en un Android de gama baja es más corto que la propia detección. Cada
     * vuelta encolaba trabajo sobre una cola que ya no se vaciaba, y el equipo
     * lento no se ralentizaba — se moría, con la pantalla congelada y el anillo
     * parado. Aquí `schedule()` **solo se llama al final de `tick`**, cuando la
     * promesa del frame anterior ya resolvió: es estructuralmente imposible
     * tener dos detecciones en vuelo.
     *
     * El último salto es un `requestAnimationFrame`, no un `setTimeout`: alinea
     * el trabajo con el compositor y, sobre todo, lo **para en seco** cuando la
     * pestaña pasa a segundo plano. En un móvil eso es la diferencia entre
     * bloquear la cámara con el teléfono en el bolsillo y no hacerlo.
     */
    const schedule = (delay: number) => {
      if (cancelled) return;
      const run = () => {
        raf = requestAnimationFrame(() => void tick());
      };
      if (delay <= 0) run();
      else timer = window.setTimeout(run, delay);
    };

    /**
     * Reajuste del perfil en caliente. La primera medición se hace con la
     * latencia real de la detección de seguimiento —no con un `hardwareConcurrency`
     * ni con el user agent— y a partir de ahí el perfil puede bajar (o subir, con
     * histéresis) mientras la sesión corre: un móvil que se calienta y entra en
     * throttling térmico a los treinta segundos es el caso normal, no el raro.
     */
    const reviewProfile = () => {
      const window_ = latencyRef.current;
      if (window_.count < PROFILE_REVIEW_FRAMES) return;
      const current = deviceProfile();
      const next = adjustProfile(current.name, window_.median(), computeBackend());
      if (next !== current.name) {
        setDeviceProfile(profileByName(next));
        window_.clear();
      }
    };

    /**
     * Fallos seguidos del bucle. Una detección puede reventar por cosas que no
     * son culpa nuestra —el contexto WebGL se pierde al rotar el móvil, la
     * memoria de la GPU se agota— y antes eso mataba el bucle en silencio: la
     * promesa de `tick` se rechazaba, nadie la programaba de nuevo y la pantalla
     * se quedaba congelada con la última instrucción puesta, fingiendo que
     * seguía funcionando. Ahora se reintenta, y si no hay manera se dice.
     */
    let seguidos = 0;
    const MAX_SEGUIDOS = 5;

    const tick = async () => {
      try {
        await runFrame();
        seguidos = 0;
      } catch (error) {
        seguidos += 1;
        if (seguidos >= MAX_SEGUIDOS) {
          setModels("error");
          setLive(false);
          setFailure("models");
          errorRef.current(
            error instanceof Error
              ? `El reconocimiento falló repetidamente en este dispositivo (${error.message}).`
              : "El reconocimiento falló repetidamente en este dispositivo.",
          );
          return;
        }
        schedule(deviceProfile().frameBudgetMs);
      }
    };

    const runFrame = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (cancelled || !video || !canvas) return;
      const profile = deviceProfile();
      const frameStart = performance.now();

      // Se congela el frame ANTES de analizarlo. El liveness, el gate de calidad
      // y el descriptor tienen que hablar del mismo píxel: antes el descriptor
      // salía de una segunda detección sobre un frame posterior.
      const full = grabFrame(video, frameRef.current);
      if (!full) {
        schedule(profile.frameBudgetMs);
        return;
      }

      const view = viewRef.current;
      const mode = viewModeFor(current);
      const trackStart = performance.now();
      // MediaPipe (478 + blendshapes) es síncrono y ve el cierre de ojos.
      // face-api queda como reserva si la malla no cargó.
      const mesh = trackMesh(full, frameStart);
      lastMeshRef.current = mesh;
      const tracked = mesh
        ? {
            box: mesh.box,
            score: mesh.score,
            landmarks: null,
            framed: sampleGate(mesh.box, mesh.score, { width: full.width, height: full.height }, false),
            quality: 1,
          }
        : await trackLandmarks(full);
      const face = tracked;
      const stage = { w: canvas.clientWidth, h: canvas.clientHeight };
      view.follow(face?.box ?? null, full.width, full.height, mode, {
        stageW: stage.w,
        stageH: stage.h,
        oval: ovalGeometry(stage.w, stage.h, insetsRef.current),
      });
      const viewed = applyView(full, viewFrameRef.current, view);
      const zoomed = view.scale > 1.04;
      const frame = zoomed ? viewed : full;
      if (video.style.opacity !== (zoomed ? "0" : "1")) {
        video.style.opacity = zoomed ? "0" : "1";
      }
      const trackMs = performance.now() - trackStart;
      if (framesRef.current === 0) {
        // Tiempo hasta el PRIMER frame analizado, contado desde que se cargó el
        // documento: incluye el bundle, los pesos y la apertura de la cámara.
        // Es la cifra que el usuario percibe como "cuánto tarda en arrancar".
        (window as Window & { __faceloginFirstFrameMs?: number }).__faceloginFirstFrameMs =
          performance.now();
      }
      framesRef.current += 1;
      if (framesRef.current % PROFILE_REVIEW_FRAMES === 0) reviewProfile();

      if (!face) {
        holdRef.current = 0;
        setHoldState(0);
        photoRef.current = null;
        publishMeters();
        publishVerdict(
          diagRef.current.update(resolveBlocking(diagnose(NO_FACE), false), frameStart),
          frameStart,
        );
        say(INSTRUCTIONS[current]);
        setLockState("none");
        drawCapture(canvas, zoomed ? viewed : video, null, "none", profile.maxDpr, insetsRef.current, zoomed);
      } else {
        /*
         * Diagnóstico de calidad, la parte que antes no existía.
         *
         * Con el umbral del motor en 0.93 una toma mediocre ya no pasa, así que
         * la interfaz tiene que conseguir buenas capturas y no solo informar de
         * que algo va mal. Aquí se mide qué falla —distancia, encuadre, pose,
         * luz, nitidez— y se elige **una sola causa**, la que más pesa.
         *
         * Durante los gestos de perfil el yaw alto es justo lo que se pide, así
         * que se le dice al diagnóstico que no lo trate como defecto: si no, la
         * pantalla diría "gira la cabeza" arriba y "mira de frente" debajo.
         */
        if (framesRef.current % photoEvery(profile) === 0) {
          photoRef.current = samplePhotometry(full, face.box);
          publishMeters();
        }
        const meshFace = mesh;
        const angles = meshFace
          ? { yaw: Math.abs(meshFace.yaw), roll: Math.abs(meshFace.roll) }
          : face.landmarks
            ? poseAngles(face.landmarks)
            : { yaw: 0, roll: 0 };
        const signal = meshFace
          ? opennessFromBlink(meshFace.blinkLeft, meshFace.blinkRight)
          : face.landmarks
            ? eyeSignal(face.landmarks)
            : { raw: 1, left: 1, right: 1 };
        const screenYawValue = meshFace
          ? meshFace.yaw
          : face.landmarks
            ? screenYaw(face.landmarks)
            : 0;
        const blinkLevel = meshFace ? (meshFace.blinkLeft + meshFace.blinkRight) / 2 : 1 - signal.raw;
        padRef.current.feed(
          meshFace?.pixels ?? face.landmarks?.positions ?? [],
          screenYawValue,
          signal.raw,
          blinkLevel,
          meshFace?.depthRelief ?? 1,
        );
        if (meshFace) mouthRef.current.feed(meshFace.mouth);
        if (voiceRef.current) {
          drawCapture(
            canvas,
            zoomed ? viewed : video,
            face.landmarks,
            "framed",
            profile.maxDpr,
            insetsRef.current,
            zoomed,
          );
          setLockState("framed");
          say("Di estas tres palabras");
          const frameMs = performance.now() - frameStart;
          latencyRef.current.push(frameMs);
          publishStats(trackMs);
          if (!cancelled && !busy) schedule(nextFrameDelay(frameMs, profile.frameBudgetMs));
          return;
        }
        const photoAttack = flow === "login" && padRef.current.photoLikely();
        const signals = buildSignals({
          score: face.score,
          boxWidth: face.box.width,
          centerX: face.box.x + face.box.width / 2,
          centerY: face.box.y + face.box.height / 2,
          frameWidth: full.width,
          frameHeight: full.height,
          yaw: angles.yaw,
          roll: angles.roll,
          photo: photoRef.current,
          photoLikely: photoAttack,
        });
        const raw = diagnose(signals, current === "center" || current === "blink" ? "frontal" : "perfil");
        publishVerdict(
          diagRef.current.update(resolveBlocking(raw, face.framed), frameStart),
          frameStart,
        );

        const yaw = Math.abs(screenYawValue);
        const frontal = yaw < 0.22;
        const looking = meshFace ? lookingAtCamera(meshFace) : frontal;
        if ((current === "center" || current !== "blink") && looking) {
          blinkRef.current.noteOpen(signal.raw, signal.left, signal.right);
        }
        if (current !== "blink" && frontal) {
          const natural = blinkRef.current.feed(signal.raw, signal.left, signal.right, {
            glasses: condition.id === "con-lentes",
          });
          if (natural === "blink" || natural === "closed") seenBlinkRef.current = true;
        }
        if (current === "blink" && frontal && looking && signal.raw >= 0.72) {
          blinkRef.current.noteOpen(signal.raw, signal.left, signal.right);
        }
        const blink =
          current === "blink" && frontal
            ? blinkRef.current.feed(signal.raw, signal.left, signal.right, {
                glasses: condition.id === "con-lentes" || Boolean(meshFace && signal.raw < 0.82),
              })
            : "open";
        const framed = face.framed;
        const nextLock: Lock =
          photoAttack ? "none" : blink === "closed" || blink === "blink" ? "blink" : framed ? "framed" : "track";
        drawCapture(
          canvas,
          zoomed ? viewed : video,
          face.landmarks,
          nextLock,
          profile.maxDpr,
          insetsRef.current,
          zoomed,
        );
        setLockState(nextLock);

        if (photoAttack) {
          holdRef.current = 0;
          setHoldState(0);
          pendingBlinkRef.current = false;
          say("Usa tu cara, no una foto");
        } else if (current === "blink") {
          setHoldState(0);
          if (!frontal) {
            offFrontRef.current += 1;
            if (offFrontRef.current >= 4) {
              blinkRef.current.clearCycle();
              pendingBlinkRef.current = false;
            }
            say("Mira de frente y luego cierra los ojos");
          } else if (meshFace && !looking && blink !== "closed" && !pendingBlinkRef.current) {
            offFrontRef.current = 0;
            say("Mira a la cámara y cierra los ojos");
          } else if (blink === "closed") {
            offFrontRef.current = 0;
            pendingBlinkRef.current = true;
            say("Bien. Ahora ábrelos");
          } else if (blink === "blink") {
            offFrontRef.current = 0;
            pendingBlinkRef.current = true;
          } else {
            offFrontRef.current = 0;
          }
          if (
            frontal &&
            (blinkRef.current.won || pendingBlinkRef.current) &&
            eyesOpenForSample(blinkRef.current)
          ) {
            const shot = await extractDescriptors(frame, { relaxCenter: true });
            if (shot) {
              pendingBlinkRef.current = false;
              blinkRef.current.won = false;
              recordExtraction(shot);
              await takeSample(shot.descriptors, shot.quality);
              return;
            }
            say("Ábrelos y quédate en el óvalo");
          } else if (pendingBlinkRef.current) {
            say(blinkRef.current.compressed ? "Mira de frente con los ojos abiertos" : "Ábrelos del todo");
          } else if (frontal && looking) {
            say(
              blinkRef.current.compressed
                ? "Cierra los dos ojos un segundo, aunque lleves lentes"
                : INSTRUCTIONS.blink,
            );
          }
        } else if (meshFace ? poseMetYaw(current, meshFace.yaw) : face.landmarks && poseMet(current, face.landmarks)) {
          const holdNeeded = flow === "login" ? LOGIN_HOLD_FRAMES : ENROLL_HOLD_FRAMES;
          if (framed) {
            holdRef.current += 1;
            say(INSTRUCTIONS[current]);
            setHoldState(Math.min(1, holdRef.current / holdNeeded));
            if (holdRef.current >= holdNeeded) {
              if (flow === "login" && !seenBlinkRef.current && padRef.current.meanResidual < 0.35) {
                say("Mueve un poco la cabeza");
                holdRef.current = Math.max(0, holdNeeded - 2);
                setHoldState(holdRef.current / holdNeeded);
              } else {
                const shot = await extractDescriptors(frame);
                if (shot) {
                  recordExtraction(shot);
                  await takeSample(shot.descriptors, shot.quality);
                  return;
                }
              }
            }
          } else {
            holdRef.current = 0;
            setHoldState(0);
            say(INSTRUCTIONS[current]);
          }
        } else {
          holdRef.current = 0;
          setHoldState(0);
          say(INSTRUCTIONS[current]);
        }
      }

      /*
       * El presupuesto se cobra sobre el frame COMPLETO —copia del vídeo,
       * detección, landmarks y dibujo del overlay—, no solo sobre la detección.
       *
       * Y es también lo que se mete en la ventana de latencias, porque los
       * umbrales de `perf.ts` SON los presupuestos de frame: comparar contra
       * ellos el coste de una sola etapa mediría una cosa y decidiría sobre otra.
       * En un móvil con DPR 3 el `drawImage` del overlay llega a costar tanto
       * como la red, y un perfil que lo ignorara volvería a prometer unos fps
       * que la pantalla no da.
       */
      const frameMs = performance.now() - frameStart;
      latencyRef.current.push(frameMs);
      publishStats(trackMs);
      if (!cancelled && !busy) {
        schedule(nextFrameDelay(frameMs, profile.frameBudgetMs));
      }
    };

    async function takeSample(descriptors: number[][], quality: number) {
      const mesh = lastMeshRef.current;
      const shape = mesh ? shapeSignature(mesh.points, mesh.matrix) : undefined;
      capturesRef.current = [
        ...capturesRef.current,
        { condition: condition.id, descriptors, quality, shape: shape?.length === 64 ? shape : undefined },
      ];
      setCaptured(capturesRef.current.length);
      setPulse((value) => value + 1);
      setShotNotice(capturesRef.current.length);
      setHold(0);
      holdRef.current = 0;
      pendingBlinkRef.current = false;
      blinkRef.current.clearCycle();
      diagRef.current.reset();
      setSpeaking(false);

      if (step + 1 < challenges.length) {
        playCue("step");
        setStep((value) => value + 1);
        setInstruction(INSTRUCTIONS[challenges[step + 1]]);
        // No se reprograma el bucle aquí: cambiar `step` remonta este efecto, y
        // el efecto nuevo arranca su propio `tick`. Programar además uno desde
        // el closure viejo era la única vía por la que podían quedar dos bucles
        // vivos a la vez.
        return;
      }

      // Terminó la secuencia de gestos de ESTA ronda. Si la cola tiene más
      // (típicamente: ya capturamos con lentes, faltan las de sin lentes),
      // se para y se le pide al usuario que confirme el cambio.
      const rest = queue.slice(1);
      if (rest.length > 0) {
        playCue("round");
        setQueue(rest);
        setStep(0);
        blinkRef.current = new BlinkTracker();
        padRef.current = new PlanarPad();
        setHandoff(conditions[rest[0]]);
        return;
      }

      const glanced = challenges.some((id) => id === "left" || id === "right");
      const report = humanConfidence({
        yawSpan: padRef.current.yawSpan,
        blinkSpan: padRef.current.blinkSpan,
        residual: padRef.current.meanResidual,
        depthRelief: lastMeshRef.current?.depthRelief ?? 0,
        seenBlink: seenBlinkRef.current,
        mouthSpan: mouthRef.current.span,
        frames: framesRef.current,
        glanced,
      });
      const needVoice =
        (flow === "login" && (forceVoice || report.captcha)) ||
        (flow === "enroll" && report.score < ENROLL_CAPTCHA_SCORE);
      if (needVoice && !voiceProofRef.current) {
        playCue("step");
        voiceRef.current = true;
        finishingVoiceRef.current = false;
        setVoiceGate({ phase: "load" });
        setInstruction("Di estas tres palabras");
        return;
      }

      playCue("done");
      setBusy(true);
      try {
        await completeRef.current(capturesRef.current, voiceProofRef.current);
      } catch (error) {
        /*
         * **Las capturas NO se tiran.**
         *
         * Antes, cualquier rechazo del servidor vaciaba `capturesRef` y devolvía
         * al usuario al gesto uno. Con dos rondas de cinco gestos hechas eso es
         * media sesión perdida por una tanda mala. Ahora se traduce el motivo a
         * algo accionable y se ofrece repetir **solo** la ronda que falló; el
         * resto de capturas siguen en el ref.
         */
        setBusy(false);
        setRecovery(planRecovery(error));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [
    busy,
    current,
    live,
    models,
    needsTap,
    onError,
    step,
    challenges,
    condition,
    conditions,
    queue,
    handoff,
    recovery,
    flow,
    forceVoice,
  ]);

  useEffect(() => {
    if (voiceGate?.phase !== "load") return;
    let cancelled = false;
    void voiceChallenge()
      .then((challenge) => {
        if (cancelled) return;
        if (!speechSupported()) {
          setVoiceGate({
            phase: "error",
            message: "Este navegador no puede oírte. Prueba en Chrome o Safari.",
          });
          return;
        }
        setVoiceGate({
          phase: "speak",
          id: challenge.id,
          words: challenge.words,
          spoken: challenge.words.map(() => false),
          heard: challenge.words.map(() => false),
          mouths: challenge.words.map(() => 0),
          mouthNow: 0,
          transcript: "",
        });
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceGate({
            phase: "error",
            message: "No se pudo pedir el desafío de voz. Reintenta.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [voiceGate?.phase === "load"]);

  useEffect(() => {
    if (voiceGate?.phase !== "speak") return;
    const { id, words } = voiceGate;
    let stopListen = () => {};
    let meterStop: (() => void) | undefined;
    let cancelled = false;
    void openMicMeter().then(
      (meter) => {
        if (cancelled) {
          meter.stop();
          return;
        }
        meterStop = meter.stop;
      },
      () => undefined,
    ).then(() => {
      if (cancelled) return;
      stopListen = listenSpeech(
        (text) => {
          setVoiceGate((previous) => {
            if (!previous || previous.phase !== "speak" || previous.id !== id) return previous;
            const current = previous.heard.findIndex((ok) => !ok);
            if (current < 0) return { ...previous, transcript: text };
            const said = wordHeard(text, words[current]);
            const spoken = previous.spoken.map((ok, index) => ok || (index === current && said));
            const heard = previous.heard.map((ok, index) => ok || (index === current && said));
            if (said && !previous.heard[current]) playCue("step");
            return {
              ...previous,
              spoken,
              heard,
              transcript: said ? "" : text,
            };
          });
        },
        (message) => setVoiceGate({ phase: "error", message }),
      );
    });
    return () => {
      cancelled = true;
      stopListen();
      meterStop?.();
    };
  }, [voiceGate?.phase === "speak" ? voiceGate.id : ""]);

  useEffect(() => {
    if (voiceGate?.phase !== "speak") return;
    if (!voiceGate.heard.every(Boolean) || finishingVoiceRef.current) return;
    finishingVoiceRef.current = true;
    const proof: VoiceProof = { id: voiceGate.id, transcript: voiceGate.transcript };
    voiceProofRef.current = proof;
    voiceRef.current = false;
    playCue("done");
    setBusy(true);
    setVoiceGate(null);
    void completeRef.current(capturesRef.current, proof).catch((error: unknown) => {
      setBusy(false);
      setRecovery(planRecovery(error));
    });
  }, [voiceGate]);

  /**
   * Traduce el fallo del servidor a algo que se pueda hacer.
   *
   * `matcher.ts` genera tres motivos distintos por condición —pocas capturas,
   * coherencia insuficiente, demasiada variación— y uno entre condiciones. Todos
   * llegan como una cadena; los de condición vienen prefijados con `[etiqueta]`,
   * que es justo lo que hace falta para saber **qué ronda** repetir.
   *
   * En el login no hay rondas y el 401 es opaco a propósito, así que ahí el
   * consejo sale de la calidad medida en el cliente. Ver `adviceAfterFailure`.
   */
  function planRecovery(error: unknown): Recovery {
    const raw = error instanceof Error ? error.message : "No se pudo completar.";
    const status = (error as { status?: number } | null)?.status ?? 0;

    if (flow === "login") {
      if (status === 403) {
        return {
          title: "Falta una passkey",
          detail: raw,
          raw,
          retryPhase: null,
          retryLabel: "Reintentar",
        };
      }
      if (status !== 401) {
        return {
          title: "No pudimos comprobarlo",
          detail: raw,
          raw,
          retryPhase: null,
          retryLabel: "Reintentar",
        };
      }
      const best = capturesRef.current.reduce((max, c) => Math.max(max, c.quality), 0);
      const advice = adviceAfterFailure(best, issueRef.current);
      return {
        title: advice.weak ? "La toma no salió bien" : "No te reconocimos",
        detail: advice.message,
        raw,
        retryPhase: 0,
        retryLabel: "Intentar otra vez",
      };
    }

    if (status === 409) {
      return {
        title: "Esta cara ya está registrada",
        detail: "Ya hay una cuenta con este rostro. Entra con tu cara en vez de crear otra.",
        raw,
        retryPhase: null,
        retryLabel: "Ir a entrar",
        leave: true,
      };
    }

    const tagged = /^\[([^\]]+)\]\s*(.*)$/s.exec(raw);
    const label = tagged?.[1] ?? "";
    const index = conditions.findIndex((c) => c.id === label);
    const round = index >= 0 ? conditions[index].title.toLowerCase() : "";
    const body = tagged?.[2] ?? raw;

    if (index >= 0) {
      let detail: string;
      if (/al menos 4 capturas/i.test(body)) {
        detail = multi
          ? `Se quedaron pocas capturas buenas en la ronda «${round}». Hay que repetir esa ronda; la otra se conserva.`
          : "Se quedaron pocas capturas buenas. Hay que repetir los gestos.";
      } else if (/misma persona/i.test(body)) {
        detail = multi
          ? `Las tomas de la ronda «${round}» salieron demasiado distintas entre sí. Suele pasar cuando cambia mucho la luz a mitad, o cuando alguien más entra en el encuadre.`
          : "Las tomas salieron demasiado distintas entre sí. Suele pasar cuando cambia mucho la luz a mitad, o cuando alguien más entra en el encuadre.";
      } else if (/variación/i.test(body)) {
        detail = multi
          ? `En la ronda «${round}» cambiaste de distancia entre un gesto y otro. Mantente a la misma separación de la cámara.`
          : "Cambiaste de distancia entre un gesto y otro. Mantente a la misma separación de la cámara.";
      } else {
        detail = body;
      }
      return {
        title: multi ? `Hay que repetir la ronda «${conditions[index].title}»` : "Hay que repetir la captura",
        detail,
        raw,
        retryPhase: index,
        retryLabel: multi ? `Repetir solo «${conditions[index].title}»` : "Repetir los gestos",
      };
    }

    if (/no parecen de la misma persona/i.test(raw) && multi) {
      const last = conditions.length - 1;
      return {
        title: "Las dos rondas no cuadran",
        detail:
          `Lo capturado con lentes y sin ellos no parece la misma cara. Casi siempre es la segunda ronda: ` +
          `luz muy distinta, o alguien más delante de la cámara. Prueba a repetir solo «${conditions[last].title}».`,
        raw,
        retryPhase: last,
        retryLabel: `Repetir «${conditions[last].title}»`,
      };
    }

    return {
      title: "No pudimos guardar tu rostro",
      detail: raw,
      raw,
      retryPhase: null,
      retryLabel: "Reintentar",
    };
  }

  /** Vuelve a pedir **una** ronda, conservando las capturas de las demás. */
  function retryPhase(index: number) {
    const id = conditions[index]?.id;
    capturesRef.current = capturesRef.current.filter((capture) => capture.condition !== id);
    setCaptured(capturesRef.current.length);
    setQueue([index]);
    setStep(0);
    setHold(0);
    holdRef.current = 0;
    pendingBlinkRef.current = false;
    blinkRef.current = new BlinkTracker();
    padRef.current = new PlanarPad();
    diagRef.current.reset();
    setVerdict(OK);
    setSpeaking(false);
    setRecovery(null);
    onError("");
    if (multi) setHandoff(conditions[index]);
    else setInstruction(INSTRUCTIONS[challenges[0]]);
  }

  /** Empezar de cero. Es la salida, no la puerta principal. */
  function retryAll() {
    capturesRef.current = [];
    setCaptured(0);
    setQueue(conditions.map((_, index) => index));
    setStep(0);
    setHold(0);
    holdRef.current = 0;
    pendingBlinkRef.current = false;
    blinkRef.current = new BlinkTracker();
    padRef.current = new PlanarPad();
    viewRef.current.reset();
    diagRef.current.reset();
    setVerdict(OK);
    setSpeaking(false);
    setRecovery(null);
    onError("");
    setInstruction(INSTRUCTIONS[challenges[0]]);
  }

  if (fatal) {
    return (
      <section className="screen screen--center" aria-labelledby="camera-error-title">
        <div className="screen__inner">
          <span className="glyph glyph--warn" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d={
                  failure === "models"
                    ? "M12 3.5v9m0 3.6v.4M12 3.5 2.6 19.5h18.8z"
                    : "M3.5 5.5 20.5 18.5M6 7.5H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h11M21 8.5l-4 3.2v.6l4 3.2z"
                }
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 className="display" id="camera-error-title">
            {failure === "models" ? "No pudimos preparar el reconocimiento" : "No pudimos usar la cámara"}
          </h1>
          <p className="body" role="alert">
            {error}
          </p>
          <div className="stack">
            <button
              className="btn btn--primary"
              onClick={() => {
                onError("");
                setModels("idle");
                setAttempt((value) => value + 1);
              }}
            >
              Reintentar
            </button>
            <button className="btn btn--quiet" onClick={onCancel}>
              Volver al inicio
            </button>
          </div>
        </div>
      </section>
    );
  }

  /*
   * **Una línea de texto, y solo una.**
   *
   * La versión anterior ponía la instrucción en grande y colgaba debajo un
   * recuadro con la causa, y debajo "Luego: girar la cabeza…", y debajo dos
   * medidores. Ninguna de esas piezas estaba mal por sí sola; el fallo era
   * tenerlas todas puestas a la vez mientras alguien intenta girar la cabeza.
   *
   * Ahora la línea es una sola y se turna:
   *
   * - Normalmente dice el **gesto**. Es lo único que hay que hacer.
   * - Cuando el encuadre bloquea de verdad —el gate está rechazando frames— y
   *   además el bloqueo ha **aguantado** `COACH_DELAY_MS`, el consejo **ocupa el
   *   lugar** de la instrucción. No se añade debajo: pedirle a alguien que gire
   *   la cabeza mientras no se le ve es ruido, y decirle las dos cosas a la vez
   *   es peor que decirle solo la correcta.
   *
   * El `hint` de la causa ("Mueve la cabeza —o el teléfono— hasta que quede en
   * medio") ya no se pinta: `message` es imperativo y se basta solo. El `hint`
   * sigue existiendo, íntegro, en la región `aria-live`, que es donde hace falta
   * ser más explícito porque no hay óvalo que mirar.
   */
  const blocking = speaking && verdict.blocking && verdict.issue !== "ninguno" && !voiceGate;
  const voiceSpeak = voiceGate?.phase === "speak" ? voiceGate : null;
  const voiceIndex = voiceSpeak ? voiceSpeak.heard.findIndex((ok) => !ok) : -1;
  const voiceCurrent = voiceSpeak
    ? voiceIndex < 0
      ? voiceSpeak.words.length - 1
      : voiceIndex
    : 0;
  const voiceWord = voiceSpeak?.words[voiceCurrent] ?? "";
  const voiceHeard = voiceSpeak?.transcript ? lastHeard(voiceSpeak.transcript) : "";
  const headline = voiceGate
    ? voiceGate.phase === "error"
      ? voiceGate.message
      : voiceGate.phase === "load"
        ? "Un momento…"
        : voiceHeard
          ? `${voiceCurrent + 1} de ${voiceSpeak?.words.length ?? 3} · Te oigo: ${voiceHeard}`
          : `${voiceCurrent + 1} de ${voiceSpeak?.words.length ?? 3} · Di «${voiceWord}»`
    : blocking
      ? verdict.message
      : instruction;

  /*
   * Lo que se DICE es más que lo que se pinta, a propósito.
   *
   * Sacar los medidores y el recuadro de la vista no puede significar vaciarlos
   * del árbol de accesibilidad: si el feedback pasa a ser el color del anillo,
   * quien no ve la pantalla se queda sin nada. Así que esta cadena lleva el
   * paso, la ronda, el gesto **y** la causa con su `hint`, bloquee o no. Es
   * decir: dice siempre más de lo que se pinta, nunca menos.
   *
   * La paridad importa en las dos direcciones. Cuando el anillo se pone ámbar,
   * quien lo ve sabe que algo de la imagen falla pero no qué; aquí se dice con
   * palabras, y es la misma causa —`diagnose` elige una sola— así que lo hablado
   * y lo pintado no pueden contradecirse. Los niveles de luz y nitidez sin más
   * no entran: si la causa dominante es otra, meterlos sería anunciar un
   * problema que la pantalla no está señalando. Para auditarlos está
   * «Detalles técnicos».
   *
   * No se dispara más de una vez cada 600 ms porque el estabilizador no deja
   * cambiar el veredicto antes, y `notice` cambia como mucho una vez por
   * segundo. Un lector de pantalla no se convierte en una ametralladora.
   */
  const stepNumber = Math.min(captured + 1, total);
  const cause = verdict.issue === "ninguno" ? "" : ` ${verdict.message}. ${verdict.hint}`;
  const spoken =
    `Paso ${stepNumber} de ${total}` +
    (multi ? `, ronda ${phase + 1} de ${conditions.length}: ${condition.title.toLowerCase()}` : "") +
    `. ${instruction}.${cause}` +
    (notice.level === "ninguna" ? "" : ` ${notice.message}`);

  /*
   * El estado del anillo, que es ahora la única señal continua.
   *
   * El parpadeo manda —es un disparo inminente— y por debajo el ámbar gana al
   * azul: si la imagen sale movida o hay contraluz, saber que "estás encuadrado"
   * no sirve de nada. Esto es lo que sustituye a los dos medidores.
   */
  const ringState: Lock =
    lock === "blink" || lock === "shot" ? lock : imageWarning(verdict) ? "warn" : lock;

  return (
    <section className="capture" aria-label={title}>
      <div className="capture__stage" ref={stageRef}>
        <div className="capture__mirror">
          <video ref={videoRef} playsInline muted />
          <canvas ref={canvasRef} />
        </div>
        <ProgressRing
          width={stageSize.width}
          height={stageSize.height}
          insets={insets}
          total={total}
          done={captured}
          hold={hold}
          state={ringState}
          pulse={pulse}
          glance={current}
          glanceStep={step}
        />
        <div className="capture__scrim" aria-hidden="true" />
        {voiceGate && voiceGate.phase !== "speak" && (
          <div className="voice" role="status" aria-live="polite">
            {voiceGate.phase === "load" && <p className="voice__hint">Preparando el reto…</p>}
            {voiceGate.phase === "error" && (
              <button
                className="btn btn--primary"
                onClick={() => {
                  finishingVoiceRef.current = false;
                  setVoiceGate({ phase: "load" });
                }}
              >
                Reintentar
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        La cabecera se quedó en lo que de verdad no cabe en el anillo: la salida
        y qué pantalla es esta.

        Aquí vivían el contador «2/5» y la fila de puntos de progreso. Los dos
        respondían a "¿cuánto falta?", que es justo lo que ahora responden los
        tramos del anillo, en el centro de la pantalla y sin apartar la vista de
        la propia cara. La etiqueta de ronda se queda **solo** cuando hay dos
        —«con lentes» / «sin lentes»—: ahí sí hay algo que el anillo no puede
        decir, porque es una instrucción sobre el mundo físico, no sobre el
        progreso.
      */}
      <header className="capture__top" ref={headRef}>
        <div className="capture__bar">
          <button className="btn btn--chip" onClick={onCancel}>
            Cancelar
          </button>
          <p className="capture__title">{title}</p>
        </div>
        {multi && (
          <p className="capture__tag">
            Ronda {phase + 1} de {conditions.length} · {condition.title}
          </p>
        )}
        <Degraded notice={notice} />
      </header>

      {/*
        El acuse de captura ya no se pinta.

        Era una píldora verde arriba del todo que se quedaba segundo y medio
        diciendo "Captura 3 de 5 guardada" — es decir, un segundo bloque de texto
        en pantalla, encima justo cuando acababa de pasar algo. Ese acuse lo da
        ahora el anillo, que enciende un tramo y da el pulso; lo que sí se
        conserva íntegro es el `role="status"`, que es lo único que tenía quien
        no ve la pantalla.
      */}
      {shotNotice > 0 && !recovery && !handoff && !busy && !needsTap && (
        <p className="sr-only" role="status">
          Captura {shotNotice} de {total} guardada
        </p>
      )}

      <div className="capture__foot" ref={footRef} data-voice={voiceSpeak ? true : undefined}>
        {voiceSpeak && (
          <div className="voice voice--foot" role="status" aria-live="polite">
            <ol className="voice__steps" aria-label="Progreso de palabras">
              {voiceSpeak.words.map((item, step) => (
                <li
                  key={item}
                  data-ok={voiceSpeak.heard[step] || undefined}
                  data-on={step === voiceCurrent && !voiceSpeak.heard[step] ? true : undefined}
                >
                  {step + 1}
                </li>
              ))}
            </ol>
            <p className="voice__word" data-ok={voiceSpeak.heard[voiceCurrent] || undefined}>
              {voiceWord}
            </p>
          </div>
        )}
        <p className="capture__instruction" data-blocking={blocking || undefined}>
          <span key={voiceSpeak ? `${voiceSpeak.id}-${voiceCurrent}` : headline} className="capture__line">
            {headline}
          </span>
        </p>

        {/* Región viva única, y ahora también el sitio donde vive todo lo que se
            quitó de la vista: la causa con su explicación, el nivel de luz y de
            nitidez, y el aviso de equipo lento. Simplificar la pantalla no puede
            significar vaciar el árbol de accesibilidad. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {spoken}
        </p>

        {error && live && !recovery && (
          <p className="capture__alert" role="alert">
            {error}
          </p>
        )}
        {/*
          Un solo pliegue para todo lo que dejó de estar en primer plano: los
          medidores de luz y nitidez y los números del motor. Antes eran dos
          cosas —dos píldoras siempre puestas y un enlace "Rendimiento"—; ahora
          es un único «Detalles técnicos», y el resumen va tan callado como se
          puede sin dejar de ser un control enfocable.
        */}
        {stats.frames > 0 && (
          <details className="capture__diag">
            <summary>Detalles técnicos</summary>
            <p>
              luz {meters.light} · nitidez {meters.sharp}
              {notice.level === "aviso" ? ` · ${notice.message}` : ""}
            </p>
            <p>
              perfil {stats.profile} · {stats.backend} · {stats.fps.toFixed(1)} fps ·{" "}
              {stats.resolution} · zoom {stats.zoom.toFixed(1)}×
            </p>
            <p>
              frame {stats.frameMs.toFixed(0)} ms (seguimiento {stats.trackMs.toFixed(0)} ms) ·
              extracción{" "}
              {stats.detectMs > 0
                ? `${stats.detectMs.toFixed(0)}+${stats.alignMs.toFixed(0)}+${stats.describeMs.toFixed(0)} ms`
                : "—"}{" "}
              · augmentación {stats.augment} ({stats.variantMs.toFixed(0)} ms/variante)
            </p>
            <p>
              modelos {stats.modelMs} ms{stats.modelFromCache > 0 ? " (de caché)" : " (de red)"} ·
              fotometría {stats.photoMs.toFixed(1)} ms
            </p>
          </details>
        )}
      </div>

      {needsTap && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="tap-title">
          <div className="overlay__card">
            <h2 className="title" id="tap-title">
              Toca para empezar
            </h2>
            {/* iOS y Android no dejan arrancar un vídeo fuera del gesto del
                usuario, y `await getUserMedia()` rompe la cadena del gesto que
                trajo al usuario hasta aquí. Un botón lo resuelve; un rectángulo
                negro sin explicación, no. */}
            <p className="body">Tu navegador necesita un toque para encender la cámara.</p>
            <button
              className="btn btn--primary"
              autoFocus
              onClick={() => {
                unlockCue();
                void videoRef.current?.play().then(
                  () => setNeedsTap(false),
                  () => errorRef.current("No se pudo iniciar el vídeo de la cámara."),
                );
              }}
            >
              Encender la cámara
            </button>
          </div>
        </div>
      )}

      {handoff && !recovery && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
          <div className="overlay__card">
            <span className="glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M2.5 11h19M9.5 11a3 3 0 1 1-6 0M20.5 11a3 3 0 1 1-6 0M10 11.6c.6-.5 1.2-.7 2-.7s1.4.2 2 .7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <h2 className="title" id="handoff-title">
              {handoff.title}
            </h2>
            <p className="body">{handoff.hint}</p>
            <p className="overlay__meta">
              Quedan {challenges.length} gestos. Lo ya capturado se conserva.
            </p>
            <button
              className="btn btn--primary"
              autoFocus
              onClick={() => {
                setInstruction(INSTRUCTIONS[challenges[0]]);
                setHandoff(null);
              }}
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {recovery && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
          <div className="overlay__card">
            <span className="glyph glyph--warn" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 8v5m0 3.2v.3M12 3.6 2.8 19.6h18.4z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h2 className="title" id="recovery-title">
              {recovery.title}
            </h2>
            <p className="body">{recovery.detail}</p>
            {recovery.retryPhase !== null && multi && (
              <p className="overlay__meta">
                Se conservan {kept(recovery.retryPhase)} capturas de la otra ronda: no hay que
                repetirlas.
              </p>
            )}
            <button
              className="btn btn--primary"
              autoFocus
              onClick={() => {
                if (recovery.leave) (onLogin ?? onCancel)();
                else if (recovery.retryPhase === null) retryAll();
                else retryPhase(recovery.retryPhase);
              }}
            >
              {recovery.retryLabel}
            </button>
            {recovery.retryPhase !== null && multi && (
              <button className="btn" onClick={retryAll}>
                Empezar de cero
              </button>
            )}
            <button className="btn btn--quiet" onClick={onCancel}>
              Salir
            </button>
            <details className="diag diag--tight">
              <summary>Detalles técnicos</summary>
              <p className="diag__raw">{recovery.raw}</p>
            </details>
          </div>
        </div>
      )}

      {busy && (
        <div className="overlay" aria-live="polite">
          <div className="overlay__card">
            <span className="spinner" aria-hidden="true" />
            <p className="body">
              {flow === "enroll" ? "Guardando tu rostro…" : "Comprobando quién eres…"}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
