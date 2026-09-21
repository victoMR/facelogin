import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  enroll,
  identify,
  listIdentities,
  me,
  oidcApprove,
  oidcDeny,
  oidcRequest,
  trustDevice,
  ApiError,
  MAX_LOGIN_DESCRIPTORS,
  type ConditionSamples,
  type EnrollResult,
  type IdentifyResult,
  type OidcRequestInfo,
} from "./api";
import { authenticatePasskey, passkeySupported, registerPasskey } from "./passkey";
import type { Capture } from "./FaceCapture";
import {
  deviceProof,
  ensureDevice,
  isDeviceTrustedLocally,
  markDeviceTrustedLocally,
} from "./device";
import { meanShape, SHAPE_DIM } from "./mesh";
import {
  enrollChallenges,
  GLASSES_CONDITIONS,
  loginChallenges,
  SINGLE_CONDITION,
  trustedChallenges,
  type EnrollCondition,
} from "./liveness";

const FaceCapture = lazy(() =>
  import("./FaceCapture").then((module) => ({ default: module.FaceCapture })),
);

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

type Mode = "home" | "setup" | "enroll" | "login" | "done" | "session" | "trust" | "oidc" | "oidc-login" | "validate-invite";

const OIDC_REQUEST_ID = new URLSearchParams(window.location.search).get("oidc");

const SCOPE_LABELS: Record<string, string> = {
  openid: "un identificador tuyo (distinto en cada servicio)",
  profile: "tu nombre visible",
};

type SessionStats = Omit<IdentifyResult, "token" | "identity">;
type PendingTrust = { token: string; identity: IdentifyResult["identity"]; stats: SessionStats };
type SessionState = {
  token: string;
  identity: { id: string; displayName: string };
  stats: SessionStats | null;
};

function groupByCondition(captures: Capture[]): ConditionSamples[] {
  const groups = new Map<string, number[][]>();
  for (const capture of captures) {
    const bucket = groups.get(capture.condition) ?? [];
    bucket.push(...capture.descriptors);
    groups.set(capture.condition, bucket);
  }
  return [...groups].map(([label, samples]) => ({ label, samples }));
}

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

type FaceAppProps = {
  onExit?: () => void;
};

export function FaceApp({ onExit }: FaceAppProps) {
  const [mode, setMode] = useState<Mode>(OIDC_REQUEST_ID ? "oidc" : "home");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [glasses, setGlasses] = useState<boolean | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [enrolled, setEnrolled] = useState<EnrollResult | null>(null);
  const [oidc, setOidc] = useState<OidcRequestInfo | null>(null);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [gallery, setGallery] = useState<{ count: number }>({ count: 0 });

  const conditions: EnrollCondition[] = glasses ? GLASSES_CONDITIONS : SINGLE_CONDITION;

  useEffect(() => {
    void import("./FaceCapture").catch(() => undefined);
    void import("./face")
      .then((module) => module.loadModels())
      .catch(() => undefined);

    if (OIDC_REQUEST_ID) {
      oidcRequest(OIDC_REQUEST_ID)
        .then(setOidc)
        .catch((cause: Error) => {
          setError(cause.message);
          setMode("home");
        });
      return;
    }

    void listIdentities()
      .then(setGallery)
      .catch(() => setGallery({ count: 0 }));

    const token = localStorage.getItem("facelogin.token");
    if (!token) return;
    me(token)
      .then((identity) => {
        setSession({ token, identity, stats: null });
        setMode("session");
      })
      .catch(() => localStorage.removeItem("facelogin.token"));
  }, []);

  function refreshGallery() {
    void listIdentities()
      .then(setGallery)
      .catch(() => setGallery({ count: 0 }));
  }

  function goHome() {
    setError("");
    setPendingTrust(null);
    setMode("home");
    refreshGallery();
  }

  async function identifyWithDevice(captures: Capture[]) {
    let proof;
    try {
      proof = await deviceProof();
    } catch {
      proof = undefined;
    }
    const descriptors = bestLoginDescriptors(captures);
    const shape = captureShape(captures);
    try {
      return await identify(descriptors, shape, proof);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "PASSKEY_REQUIRED") throw error;
      const passkey = await authenticatePasskey();
      return identify(descriptors, shape, proof, passkey);
    }
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
      const device = await deviceProof();
      const passkey = passkeySupported() ? await authenticatePasskey() : undefined;
      await trustDevice(pendingTrust.token, device, passkey);
      markDeviceTrustedLocally();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confiar en este aparato.");
      return;
    }
    setSession({
      token: pendingTrust.token,
      identity: pendingTrust.identity,
      stats: pendingTrust.stats,
    });
    setPendingTrust(null);
    setMode("session");
  }

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

  // Validar código de invitación antes de abrir cámara
  async function validateInviteAndProceed() {
    setError("");
    try {
      // TODO: llamar al endpoint /api/enroll/validate
      const response = await fetch("/api/enroll/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${inviteCode.trim()}`,
        },
      });
      
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Ese código no es válido o ya venció.");
      }
      
      // Si es válido, proceder al setup normal
      setMode("setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo validar el código.");
    }
  }

  if (mode === "validate-invite") {
    return (
      <main className="app">
        <Screen id="validate-invite" onBack={goHome}>
          <p className="eyebrow">Antes de empezar</p>
          <h1 className="display">Código de invitación</h1>
          <p className="body">
            Para registrar tu rostro necesitas un código de invitación. Si no tienes uno,
            contacta al administrador.
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void validateInviteAndProceed();
            }}
          >
            <label className="field">
              <span className="field__label">Código de invitación</span>
              <input
                className="input"
                value={inviteCode}
                autoFocus
                placeholder="Pega tu código aquí"
                onChange={(event) => setInviteCode(event.target.value)}
              />
            </label>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={inviteCode.trim().length < 8}
            >
              Validar código
            </button>
          </form>
          {error && (
            <p className="toast" role="alert">
              {error}
            </p>
          )}
        </Screen>
      </main>
    );
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
            onLogin={() => {
              setError("");
              setMode("login");
            }}
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
            onComplete={async (captures) => {
              const { token } = await identifyWithDevice(captures);
              const { redirect } = await oidcApprove(OIDC_REQUEST_ID, token);
              window.location.replace(redirect);
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
            onComplete={async (captures) => {
              const result = await identifyWithDevice(captures);
              await openSession(result);
            }}
          />
        </Suspense>
      </main>
    );
  }

  return (
    <main className="app">
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
                // Si hay FACELOGIN_ENROLL_TOKEN, requerir validación primero
                const enrollToken = process.env.FACELOGIN_ENROLL_TOKEN;
                setMode(enrollToken ? "validate-invite" : "setup");
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
            {gallery.count > 0 && (
              <p className="home__vault">
                Hay {gallery.count === 1 ? "1 rostro guardado" : `${gallery.count} rostros guardados`}.
              </p>
            )}
            {onExit && (
              <button className="btn btn--quiet" onClick={onExit}>
                Volver al inicio
              </button>
            )}
          </div>
        </Screen>
      )}

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
              : "Entraste con tu rostro. Añade una passkey si vas a usar otro aparato."}
          </p>
          <div className="stack">
            {passkeySupported() && (
              <button
                className="btn"
                onClick={() => {
                  void registerPasskey(session.token).catch((cause: Error) => {
                    setError(cause.message || "No se pudo guardar la passkey.");
                  });
                }}
              >
                Añadir passkey (otros aparatos)
              </button>
            )}
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

      {error && (
        <p className="toast" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
