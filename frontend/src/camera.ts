import type { DeviceProfile } from "./perf";

export function cameraSupported(): boolean {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

export function embeddedPreview(): boolean {
  return window.self !== window.top || /Cursor|Electron/i.test(navigator.userAgent);
}

/**
 * ¿Estamos en un móvil? Se usa **solo** para elegir textos de error y para no
 * pedir 1280×720 a una cámara frontal de teléfono antes de tener una medición.
 * El perfil de rendimiento no se decide aquí: se mide (ver `perf.ts`).
 */
export function isMobile(): boolean {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  );
}

/**
 * Resolución adaptativa.
 *
 * Antes se pedía `{ facingMode: "user" }` sin resolución: el navegador daba lo
 * que le parecía, que en un móvil suele ser 1280×720 o más. Cada frame de 720p
 * se copia a un canvas y se reescala al `inputSize` del detector **en cada
 * vuelta del bucle**; en gama baja ese `drawImage` y el `toPixels` de tfjs
 * cuestan tanto como la propia red.
 *
 * `ideal` y no `exact`: si la cámara no tiene ese modo, `exact` falla con
 * `OverconstrainedError` y nos quedamos sin cámara. Con `ideal` el navegador se
 * acerca a lo que puede.
 */
export function constraintsFor(profile: DeviceProfile): MediaStreamConstraints[] {
  const { width, height } = profile.capture;
  return [
    {
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30, max: 30 },
      },
    },
    { audio: false, video: { facingMode: "user" } },
    { audio: false, video: true },
  ];
}

/**
 * Stream sintético para el banco de medición.
 *
 * Sin cámara física no hay forma de medir el bucle de detección de punta a
 * punta, y medirlo es la mitad del encargo. Con `canvas.captureStream()` la
 * página se alimenta de un lienzo que dibuja una cara sintética, y el bucle
 * —detección, alineación, extracción, anillo— corre exactamente igual.
 *
 * **No existe en un build normal.** `import.meta.env.VITE_FACELOGIN_TEST_STREAM`
 * solo vale "1" en `npm run build:perf`, así que en producción el `if` entero
 * desaparece del bundle en el tree-shaking. Aun así conviene decir en voz alta
 * lo que el README ya dice en *Límites honestos*: el liveness es del cliente y
 * no es un control de seguridad, así que esto no abre ninguna puerta que un
 * `curl` contra `/api/identify` no tuviera abierta ya.
 */
function testStream(): MediaStream | null {
  if (import.meta.env.VITE_FACELOGIN_TEST_STREAM !== "1") return null;
  const provided = (window as { __faceloginTestStream?: unknown }).__faceloginTestStream;
  return provided instanceof MediaStream ? provided : null;
}

export async function openCamera(profile: DeviceProfile): Promise<MediaStream> {
  const synthetic = testStream();
  if (synthetic) return synthetic;

  if (!cameraSupported()) {
    throw new Error(insecureContextMessage());
  }

  let last: unknown;
  for (const constraints of constraintsFor(profile)) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      last = error;
      // `NotAllowedError` es un "no" del usuario, no una restricción imposible:
      // reintentar con constraints más flojas solo dispara otro diálogo.
      if (error instanceof DOMException && error.name === "NotAllowedError") throw error;
    }
  }
  throw last instanceof Error ? last : new Error("No se pudo abrir la cámara.");
}

/**
 * `getUserMedia` exige contexto seguro, y `http://` en una IP de la red local
 * **no lo es**: en un móvil de verdad el flujo HTTPS deja de ser opcional. Este
 * es el mensaje que lo dice, con la orden que hay que correr.
 */
function insecureContextMessage(): string {
  if (embeddedPreview()) {
    return "El preview embebido no puede usar la cámara. Ábrelo en Chrome: http://localhost:5173";
  }
  if (!window.isSecureContext) {
    return isMobile()
      ? `Un móvil solo da cámara por HTTPS. En el equipo que sirve la app corre "npm run dev:https" y entra por https://${location.hostname}:5173 aceptando el certificado.`
      : "Este navegador solo da cámara en contexto seguro. Usa http://localhost:5173 o corre 'npm run dev:https'.";
  }
  return "Este navegador no da acceso a la cámara.";
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return isMobile()
      ? "Bloqueaste la cámara para esta página. Toca el candado en la barra de direcciones y permítela."
      : "Chrome o macOS bloquearon la cámara. Permítela en la barra de direcciones y en Ajustes → Privacidad → Cámara.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No hay cámara disponible en este dispositivo, o está en uso por otra app.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "La cámara está ocupada. Cierra las otras apps que la estén usando y reintenta.";
  }
  if (name === "OverconstrainedError") {
    return "La cámara no admite la resolución pedida. Reintenta: bajaremos la calidad.";
  }
  return error instanceof Error ? error.message : "No se pudo abrir la cámara.";
}

/** Resolución que la cámara acabó dando. Va a los detalles técnicos, no a la UI principal. */
export function streamResolution(stream: MediaStream | null): string {
  const track = stream?.getVideoTracks()[0];
  if (!track) return "—";
  const { width, height, frameRate } = track.getSettings();
  if (!width || !height) return "—";
  return `${width}×${height}${frameRate ? ` @ ${Math.round(frameRate)} fps` : ""}`;
}
