import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  enroll,
  identify,
  me,
  oidcApprove,
  oidcDeny,
  oidcRequest,
  trustDevice,
  MAX_LOGIN_DESCRIPTORS,
  type ConditionSamples,
  type EnrollResult,
  type IdentifyResult,
  type OidcRequestInfo,
  type VoiceProof,
} from "./api";
import type { Capture } from "./FaceCapture";
import { deviceProof, ensureDevice, isDeviceTrustedLocally, markDeviceTrustedLocally } from "./device";
import { meanShape, SHAPE_DIM } from "./mesh";
import {
  enrollChallenges,
  GLASSES_CONDITIONS,
  loginChallenges,
  SINGLE_CONDITION,
  trustedChallenges,
  type EnrollCondition,
} from "./liveness";

/**
 * La pila de captura **no entra en el chunk de arranque**.
 *
 * `FaceCapture` arrastra consigo `face.ts`, `camera.ts`, `overlay.ts`,
 * `perf.ts`, `models.ts`, `tfbackend.ts` y el diagnóstico de calidad: 38 kB que
 * quien abre la portada y lee "Entra con tu cara" no necesita para decidir si
 * pulsa el botón. Sacándolos, el chunk inicial baja de 230 kB a 207 (74 → 65 kB
 * gzip) **por debajo de donde estaba antes de este trabajo**, aunque el total
 * de código haya crecido.
 *
 * Y no cuesta latencia en la captura porque se **precarga al montar la app**
 * (ver el efecto de abajo), en paralelo con los pesos de los modelos, que ya se
 * pedían así. Cuando el usuario pulsa el botón, el chunk lleva segundos en la
 * caché del navegador; el `Suspense` de más abajo solo existe para el caso raro
 * de un clic inmediato sobre una conexión mala.
 */
const FaceCapture = lazy(() =>
  import("./FaceCapture").then((module) => ({ default: module.FaceCapture })),
);

/** Pantalla de espera del `Suspense`. Es negra como la captura, no blanca: si
    llega a verse, tiene que parecer el principio de la cámara y no un salto. */
function Warming() {
  return (
    <section className="capture capture--warming" aria-label="Preparando la cámara">
      <div className="capture__foot">
        <span className="spinner spinner--light" aria-hidden="true" />
        <p className="capture__instruction">Preparando la cámara…</p>
      </div>
    </section>
  );
}

type Mode = "home" | "setup" | "enroll" | "login" | "done" | "session" | "trust" | "oidc" | "oidc-login";

/**
 * `/authorize` del backend deja al usuario aquí con un identificador opaco. Se
 * lee una sola vez, al cargar el módulo: cualquier `replaceState` posterior
 * (limpiar la barra de direcciones al cancelar) no debe borrarlo del estado.
 */
const OIDC_REQUEST_ID = new URLSearchParams(window.location.search).get("oidc");

/** Lo que el servicio cliente va a recibir, en castellano y sin jerga. */
const SCOPE_LABELS: Record<string, string> = {
  openid: "un identificador tuyo (distinto en cada servicio)",
  profile: "tu nombre visible",
};

type SessionStats = Omit<IdentifyResult, "token" | "identity">;
type PendingTrust = { token: string; identity: IdentifyResult["identity"]; stats: SessionStats };
type SessionState = {
  token: string;
  identity: { id: string; displayName: string };
  /** Solo existe si la sesión se abrió en esta pestaña; al restaurarla no hay números. */
  stats: SessionStats | null;
};

/** Agrupa las capturas por condición para mandarlas como sub-clusters. */
function groupByCondition(captures: Capture[]): ConditionSamples[] {
  const groups = new Map<string, number[][]>();
  for (const capture of captures) {
    const bucket = groups.get(capture.condition) ?? [];
    bucket.push(...capture.descriptors);
    groups.set(capture.condition, bucket);
  }
  return [...groups].map(([label, samples]) => ({ label, samples }));
}

/**
 * Descriptores para el login, mejores primero. Antes se mandaba `samples.at(-1)`
 * —el frame del parpadeo, el de peor calidad de la sesión— y era el único
 * intento que tenía el servidor.
 */
function captureShape(captures: Capture[]): number[] | undefined {
  const shape = meanShape(captures.map((capture) => capture.shape ?? []).filter((item) => item.length === SHAPE_DIM));
  return shape.length === SHAPE_DIM ? shape : undefined;
}

function bestLoginDescriptors(captures: Capture[]): number[][] {
  return [...captures]
    .sort((a, b) => b.quality - a.quality)
    .flatMap((capture) => capture.descriptors.slice(0, 1))
    .slice(0, MAX_LOGIN_DESCRIPTORS);
}

/**
 * El servidor devuelve la condición por su identificador (`con-lentes`), que es
 * lo que se le mandó. En la pantalla de "listo" eso se lee como una etiqueta de
 * base de datos, así que se traduce al mismo título que usó la captura. El
 * identificador crudo sigue estando en "Detalles técnicos", que es su sitio.
 */
function conditionTitle(label: string): string {
  return (
    [...GLASSES_CONDITIONS, ...SINGLE_CONDITION].find((condition) => condition.id === label)
      ?.title ?? label
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function Screen({
  id,
  onBack,
  children,
}: {
  id: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="screen screen--center" key={id}>
      {onBack && (
        <button className="btn btn--chip screen__back" onClick={onBack} aria-label="Atrás">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="18" height="18">
            <path
              d="M15 5 8 12l7 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Atrás</span>
        </button>
      )}
      <div className="screen__inner">{children}</div>
    </section>
  );
}

/** Los números del motor, fuera de la vista de quien solo quiere entrar. */
function Diagnostics({ children }: { children: ReactNode }) {
  return (
    <details className="diag">
      <summary>Detalles técnicos</summary>
      <dl className="diag__list">{children}</dl>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="diag__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Vista previa de lo que viene.
 *
 * "El registro es largo o confuso" era medio problema de longitud y medio de
 * expectativa: nadie había dicho cuántos gestos son ni cuántas rondas. Decirlo
 * antes de encender la cámara no acorta el trámite, pero cambia por completo la
 * sensación de estar perdido dentro de él.
 */
function Plan({ glasses }: { glasses: boolean }) {
  const rondas = glasses ? 2 : 1;
  return (
    <ul className="plan">
      <li>
        <strong>Sigue el punto</strong> alrededor del óvalo, como Face ID
        {glasses ? " — con lentes y sin ellos" : ""}
      </li>
      <li>
        <strong>{rondas === 1 ? "Una pasada" : "Dos pasadas"}</strong>, unos {rondas * 12} segundos.
        El parpadeo se mira solo, en el mismo vídeo.
      </li>
      <li>Este aparato guarda una clave, como SSH. La cara no viaja con la privada.</li>
    </ul>
  );
}

export function App() {
  const [mode, setMode] = useState<Mode>(OIDC_REQUEST_ID ? "oidc" : "home");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  /** `null` = todavía no ha elegido. No hay valor por defecto: ver la pantalla. */
  const [glasses, setGlasses] = useState<boolean | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [enrolled, setEnrolled] = useState<EnrollResult | null>(null);
  const [oidc, setOidc] = useState<OidcRequestInfo | null>(null);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);

  // Condiciones del enrollo en curso: una sola, o con lentes + sin lentes.
  const conditions: EnrollCondition[] = glasses ? GLASSES_CONDITIONS : SINGLE_CONDITION;

  useEffect(() => {
    // Los pesos tardan unos segundos en bajar. Se piden al abrir la app para que
    // la cámara no se quede esperándolos al arrancar la captura — y con ellos se
    // precarga el chunk de la captura, que es lo que le quita el coste al
    // `lazy()` de arriba: para cuando alguien pulsa un botón, ya está en caché.
    void import("./FaceCapture").catch(() => undefined);
    void import("./face")
      .then((module) => module.loadModels())
      .catch(() => undefined);

    if (OIDC_REQUEST_ID) {
      // Llegando desde un servicio externo NO se restaura la sesión guardada:
      // ese servicio pide una verificación facial, no un token viejo del
      // localStorage. El backend además exige que la autenticación sea reciente.
      oidcRequest(OIDC_REQUEST_ID)
        .then(setOidc)
        .catch((cause: Error) => {
          setError(cause.message);
          setMode("home");
        });
      return;
    }

    const token = localStorage.getItem("facelogin.token");
    if (!token) return;
    me(token)
      .then((identity) => {
        setSession({ token, identity, stats: null });
        setMode("session");
      })
      .catch(() => localStorage.removeItem("facelogin.token"));
  }, []);

  function goHome() {
    setError("");
    setPendingTrust(null);
    setMode("home");
  }

  async function identifyWithDevice(captures: Capture[], voice?: VoiceProof) {
    let proof;
    try {
      proof = await deviceProof();
    } catch {
      proof = undefined;
    }
    return identify(bestLoginDescriptors(captures), captureShape(captures), proof, voice);
  }

  async function openSession(result: IdentifyResult) {
    const { token, identity, ...stats } = result;
    localStorage.setItem("facelogin.token", token);
    if (result.trustedDevice) {
      markDeviceTrustedLocally();
      setSession({ token, identity, stats });
      setMode("session");
      return;
    }
    setPendingTrust({ token, identity, stats });
    setMode("trust");
  }

  async function confirmTrust() {
    if (!pendingTrust) return;
    try {
      const device = await ensureDevice();
      await trustDevice(pendingTrust.token, device);
      markDeviceTrustedLocally();
    } catch {
      /* entra igual; solo no queda recordado */
    }
    setSession({
      token: pendingTrust.token,
      identity: pendingTrust.identity,
      stats: pendingTrust.stats,
    });
    setPendingTrust(null);
    setMode("session");
  }

  /** Cancelar devuelve `access_denied` al cliente en vez de dejarlo esperando. */
  async function cancelOidc() {
    if (!OIDC_REQUEST_ID) return goHome();
    try {
      const { redirect } = await oidcDeny(OIDC_REQUEST_ID);
      window.location.replace(redirect);
    } catch {
      window.history.replaceState(null, "", window.location.pathname);
      goHome();
    }
  }

  if (mode === "enroll") {
    return (
      <main className="app">
        <Suspense fallback={<Warming />}>
          <FaceCapture
            title="Configurar tu rostro"
            flow="enroll"
            challenges={enrollChallenges}
            conditions={conditions}
            error={error}
            onError={setError}
            onCancel={goHome}
            onComplete={async (captures) => {
              let device;
              try {
                device = await ensureDevice();
              } catch {
                device = undefined;
              }
              const result = await enroll(name, groupByCondition(captures), captureShape(captures), device);
              if (device) markDeviceTrustedLocally();
              setEnrolled(result);
              setMode("done");
            }}
          />
        </Suspense>
      </main>
    );
  }

  if (mode === "oidc-login" && OIDC_REQUEST_ID) {
    return (
      <main className="app">
        <Suspense fallback={<Warming />}>
          <FaceCapture
            title={oidc ? `Entrar en ${oidc.clientName}` : "Verificar tu identidad"}
            flow="login"
            challenges={isDeviceTrustedLocally() ? trustedChallenges : loginChallenges}
            conditions={SINGLE_CONDITION}
            error={error}
            forceVoice={!isDeviceTrustedLocally()}
            onError={setError}
            onCancel={() => void cancelOidc()}
            onComplete={async (captures, voice) => {
              // El descriptor va a /api/identify y se queda ahí. Lo que vuelve al
              // servicio cliente es un código, y luego un id_token firmado.
              const { token } = await identifyWithDevice(captures, voice);
              const { redirect } = await oidcApprove(OIDC_REQUEST_ID, token);
              window.location.replace(redirect);
              // La navegación tarda un instante; sin esto la pantalla parpadea al
              // volver a "listo para capturar".
              await new Promise(() => undefined);
            }}
          />
        </Suspense>
      </main>
    );
  }

  if (mode === "login") {
    return (
      <main className="app">
        <Suspense fallback={<Warming />}>
          <FaceCapture
            title="Entrar"
            flow="login"
            challenges={isDeviceTrustedLocally() ? trustedChallenges : loginChallenges}
            conditions={SINGLE_CONDITION}
            error={error}
            forceVoice={!isDeviceTrustedLocally()}
            onError={setError}
            onCancel={goHome}
            onComplete={async (captures, voice) => {
              const result = await identifyWithDevice(captures, voice);
              await openSession(result);
            }}
          />
        </Suspense>
      </main>
    );
  }

  return (
    <main className="app">
      {/*
        Entrada del flujo OIDC. Es una pantalla nueva, no un rediseño: se apoya
        en los mismos bloques (Screen, glyph, display, body, stack, btn) que el
        resto de la app.
      */}
      {mode === "oidc" && (
        <Screen id="oidc">
          <span className="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2.8 4.5 6v6c0 4.2 3 7.7 7.5 9.2 4.5-1.5 7.5-5 7.5-9.2V6L12 2.8Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M9.4 10.6v.9m5.2-.9v.9M9.6 14.4c.7.7 1.5 1 2.4 1s1.7-.3 2.4-1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <p className="eyebrow">Verificación de identidad</p>
          <h1 className="display">{oidc ? oidc.clientName : "Un servicio"} quiere saber quién eres</h1>
          <p className="body">
            Vamos a comprobar tu rostro aquí y a devolverte a{" "}
            {oidc ? oidc.clientName : "el servicio que te trajo"}. Ese servicio recibe{" "}
            {(oidc?.scopes ?? ["openid"])
              .map((scope) => SCOPE_LABELS[scope] ?? scope)
              .join(" y ")}
            . No recibe tu foto, ni tu plantilla facial, ni ninguna clave para descifrarla: eso no
            sale de este servidor.
          </p>
          <div className="stack">
            <button
              className="btn btn--primary"
              onClick={() => {
                setError("");
                setMode("oidc-login");
              }}
            >
              Verificar mi rostro
            </button>
            <button className="btn btn--quiet" onClick={() => void cancelOidc()}>
              Cancelar
            </button>
          </div>
        </Screen>
      )}

      {mode === "home" && (
        <Screen id="home">
          <p className="eyebrow">facelogin</p>
          <h1 className="display">
            Entra con
            <br />
            tu cara.
          </h1>
          <p className="body">
            Sin contraseña. Tu rostro se cifra aquí; la foto no sale del navegador.
          </p>
          <div className="stack">
            <button
              className="btn btn--primary"
              onClick={() => {
                setError("");
                setMode("setup");
              }}
            >
              Configurar mi rostro
            </button>
            <button
              className="btn btn--quiet"
              onClick={() => {
                setError("");
                setMode("login");
              }}
            >
              Ya me registré, entrar
            </button>
          </div>
        </Screen>
      )}

      {/*
        Nombre y lentes en UNA pantalla.

        Eran dos, y ninguna de las dos llenaba la suya: un campo de texto y una
        pregunta de sí/no. Juntarlas quita un paso entero del registro —de tres
        pantallas antes de la cámara a dos— sin quitar ninguna información.

        Y la pregunta de los lentes deja de ser un extra opcional. Se midió que
        los lentes mueven el descriptor menos de lo que se creía y se decidió NO
        ensanchar la tolerancia del motor por ello; la consecuencia es que quien
        use lentes tiene que enrolar las dos condiciones o no entrará sin ellos.
        Por eso no hay valor por defecto —elegir mal en silencio se paga días
        después, en un login que no funciona— y por eso la consecuencia está
        escrita en la propia pantalla.

        Se PREGUNTA en vez de detectar: un detector de lentes en 2D falla con
        reflejos y monturas finas; el usuario lo sabe seguro.
      */}
      {mode === "setup" && (
        <Screen id="setup" onBack={goHome}>
          <p className="eyebrow">Paso 1 de 2</p>
          <h1 className="display">Antes de encender la cámara</h1>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length < 2 || glasses === null) return;
              setError("");
              setMode("enroll");
            }}
          >
            <label className="field">
              <span className="field__label">Tu nombre</span>
              <input
                className="input"
                value={name}
                autoComplete="name"
                autoFocus
                placeholder="Como quieres que te salude"
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <fieldset className="field field--group">
              <legend className="field__label">¿Usas lentes?</legend>
              <div className="choice">
                <button
                  type="button"
                  className="choice__option"
                  aria-pressed={glasses === true}
                  onClick={() => setGlasses(true)}
                >
                  <span className="choice__title">Sí, los uso</span>
                  <span className="choice__hint">Capturamos con ellos y sin ellos</span>
                </button>
                <button
                  type="button"
                  className="choice__option"
                  aria-pressed={glasses === false}
                  onClick={() => setGlasses(false)}
                >
                  <span className="choice__title">No uso</span>
                  <span className="choice__hint">Una sola ronda de gestos</span>
                </button>
              </div>
              <p className="field__help">
                No lo detectamos solos: los reflejos y las monturas finas engañan al detector, y tú
                lo sabes seguro. Si los usas y dices que no, después no entrarás sin ellos.
              </p>
            </fieldset>

            {glasses !== null && <Plan glasses={glasses} />}

            <button
              className="btn btn--primary"
              type="submit"
              disabled={name.trim().length < 2 || glasses === null}
            >
              {glasses === null ? "Elige una opción" : "Empezar la captura"}
            </button>
          </form>
        </Screen>
      )}

      {mode === "done" && enrolled && (
        <Screen id="done">
          <span className="glyph glyph--ok" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="m5 12.5 4.5 4.5L19 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 className="display">Listo, {enrolled.displayName}</h1>
          <p className="body">
            {enrolled.conditions.length > 1
              ? "Guardamos tu cara con lentes y sin ellos. Entra te los pongas o no."
              : "Tu rostro quedó guardado. Ya puedes entrar sin escribir nada."}
          </p>
          <ul className="plan plan--ok">
            {enrolled.conditions.map((condition) => (
              <li key={condition.label}>
                <strong>{conditionTitle(condition.label)}</strong> · {condition.samples} muestras
                guardadas
              </li>
            ))}
          </ul>
          <div className="stack">
            <button
              className="btn btn--primary"
              onClick={() => {
                setError("");
                setMode("login");
              }}
            >
              Entrar ahora
            </button>
            <button className="btn btn--quiet" onClick={goHome}>
              Volver al inicio
            </button>
          </div>
          <Diagnostics>
            <Row label="Muestras guardadas" value={String(enrolled.samples)} />
            {enrolled.conditions.map((condition) => (
              <Row
                key={condition.label}
                label={`Condición ${condition.label}`}
                value={`${condition.samples} muestras · coherencia ${condition.intraMean.toFixed(3)}`}
              />
            ))}
            {enrolled.interConditionCosine !== null && (
              <Row
                label="Coseno entre condiciones"
                value={enrolled.interConditionCosine.toFixed(3)}
              />
            )}
            <Row label="Umbral al enrolar" value={enrolled.thresholdAtEnroll.toFixed(3)} />
          </Diagnostics>
        </Screen>
      )}

      {mode === "trust" && pendingTrust && (
        <Screen id="trust">
          <span className="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8Zm2-3h10l1 3H6l1-3Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <p className="eyebrow">Aparato nuevo</p>
          <h1 className="display">¿Confiar siempre en este dispositivo?</h1>
          <p className="body">
            Es la primera vez que {pendingTrust.identity.displayName} entra desde aquí
            {pendingTrust.stats.deviceLabel ? ` (${pendingTrust.stats.deviceLabel})` : ""}. Si
            confías, la próxima vez no pedimos tanta guía: solo mirar al óvalo, como Face ID.
            La clave se queda en este aparato; el servidor solo guarda la pública.
          </p>
          <div className="stack">
            <button className="btn btn--primary" onClick={() => void confirmTrust()}>
              Confiar siempre
            </button>
            <button
              className="btn btn--quiet"
              onClick={() => {
                setSession({
                  token: pendingTrust.token,
                  identity: pendingTrust.identity,
                  stats: pendingTrust.stats,
                });
                setPendingTrust(null);
                setMode("session");
              }}
            >
              Solo esta vez
            </button>
          </div>
        </Screen>
      )}

      {mode === "session" && session && (
        <Screen id="session">
          <span className="avatar" aria-hidden="true">
            {initials(session.identity.displayName)}
          </span>
          <p className="eyebrow">Sesión iniciada</p>
          <h1 className="display">{session.identity.displayName}</h1>
          <p className="body">
            {isDeviceTrustedLocally()
              ? "Este aparato es de confianza. La próxima vez basta con mirar."
              : "Entraste con tu rostro."}
          </p>
          <div className="stack">
            <button
              className="btn"
              onClick={() => {
                localStorage.removeItem("facelogin.token");
                setSession(null);
                goHome();
              }}
            >
              Cerrar sesión
            </button>
          </div>
          {session.stats && (
            <Diagnostics>
              <Row label="Similitud" value={session.stats.score.toFixed(3)} />
              <Row label="Umbral" value={session.stats.threshold.toFixed(3)} />
              <Row label="Candidatos" value={String(session.stats.candidates)} />
              <Row label="Tiempo de match" value={`${session.stats.latencyMs} ms`} />
              {session.stats.condition && (
                <Row label="Condición" value={session.stats.condition} />
              )}
            </Diagnostics>
          )}
        </Screen>
      )}

      {/* Los modos de captura ya salieron arriba con su propio return, así que
          este aviso solo puede pertenecer a una pantalla de contenido. */}
      {error && (
        <p className="toast" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
