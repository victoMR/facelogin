/**
 * Admin: bootstrap con token → registrar cara de operador → entrar con la cara.
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  enroll,
  identify,
  MAX_LOGIN_DESCRIPTORS,
  trustDevice,
  type ConditionSamples,
  type IdentifyResult,
} from "./api";
import type { Capture } from "./FaceCapture";
import { deviceProof, ensureDevice, isDeviceTrustedLocally, markDeviceTrustedLocally } from "./device";
import { enrollChallenges, loginChallenges, GLASSES_CONDITIONS, SINGLE_CONDITION, trustedChallenges } from "./liveness";
import type { EnrollCondition } from "./liveness";
import { meanShape, SHAPE_DIM } from "./mesh";
import { authenticatePasskey, passkeySupported, registerPasskey } from "./passkey";

const FaceCapture = lazy(() =>
  import("./FaceCapture").then((module) => ({ default: module.FaceCapture })),
);

const SESSION_KEY = "facelogin.admin.session";
const BOOTSTRAP_KEY = "facelogin.admin.bootstrap";

type ActivityEvent = {
  at: string;
  kind: string;
  detail: string;
  identity?: string;
  clientId?: string;
};

type AdminMetrics = {
  enrolledIdentities: number;
  todayLogins: number;
  weekLogins: number;
  todayFails: number;
  oidcClients: number;
  lastAccess: string | null;
  issuer: string | null;
  identities: Array<{
    id: string;
    name: string;
    enrolledAt: string;
    lastSeen: string | null;
    devices: number;
    passkeys: number;
    conditions: string[];
    status: string;
    isOperator?: boolean;
  }>;
  operators?: Array<{ identityId: string; displayName: string; promotedAt: string }>;
  apps: Array<{
    client_id: string;
    name: string;
    redirect_uris: string[];
    confidential: boolean;
    source: "env" | "admin";
    createdAt: string | null;
    lastUsed: string | null;
    logins: number;
  }>;
  activity: ActivityEvent[];
  bootstrapped?: boolean;
};

type CreatedCredentials = {
  client_id: string;
  client_secret: string | null;
  name: string;
  redirect_uris: string[];
};

type Mode =
  | "loading"
  | "bootstrap-token"
  | "bootstrap-setup"
  | "bootstrap-enroll"
  | "face-login"
  | "trust"
  | "dashboard"
  | "emergency-token";

type AdminProps = { onExit: () => void };

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

function Screen({ id, children, onBack }: { id: string; children: ReactNode; onBack?: () => void }) {
  return (
    <section className="screen screen--center" key={id}>
      <div className="screen__inner">
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
        {children}
      </div>
    </section>
  );
}

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
  const shape = meanShape(
    captures.map((capture) => capture.shape ?? []).filter((item) => item.length === SHAPE_DIM),
  );
  return shape.length === SHAPE_DIM ? shape : undefined;
}

function bestLoginDescriptors(captures: Capture[]): number[][] {
  return [...captures]
    .sort((a, b) => b.quality - a.quality)
    .flatMap((capture) => capture.descriptors.slice(0, 1))
    .slice(0, MAX_LOGIN_DESCRIPTORS);
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "enroll":
      return "Registro";
    case "login_ok":
      return "Entrada";
    case "login_fail":
      return "Rechazo";
    case "oidc_token":
      return "OIDC";
    case "client_created":
      return "App nueva";
    case "client_revoked":
      return "App revocada";
    case "gallery_cleared":
      return "Galería";
    default:
      return kind;
  }
}

export function Admin({ onExit }: AdminProps) {
  const [mode, setMode] = useState<Mode>("loading");
  const [authToken, setAuthToken] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [name, setName] = useState("");
  const [glasses, setGlasses] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [appName, setAppName] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedCredentials | null>(null);
  const [clearing, setClearing] = useState(false);
  const [formError, setFormError] = useState("");
  const [pendingTrust, setPendingTrust] = useState<{
    token: string;
    identity: IdentifyResult["identity"];
  } | null>(null);
  const [operatorName, setOperatorName] = useState<string | null>(null);

  useEffect(() => {
    void import("./FaceCapture").catch(() => undefined);
    void import("./face")
      .then((module) => module.loadModels())
      .catch(() => undefined);
    void bootstrap();
  }, []);

  async function bootstrap() {
    setError("");
    try {
      const response = await fetch("/api/admin/bootstrap");
      const body = (await response.json().catch(() => ({}))) as {
        bootstrapped?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "No se pudo consultar el panel.");

      const storedSession = sessionStorage.getItem(SESSION_KEY);
      if (body.bootstrapped && storedSession) {
        setAuthToken(storedSession);
        const ok = await loadMetrics(storedSession);
        if (ok) return;
      }

      if (body.bootstrapped) {
        setMode("face-login");
        return;
      }

      const pending = sessionStorage.getItem(BOOTSTRAP_KEY);
      if (pending) {
        setBootstrapToken(pending);
        setMode("bootstrap-setup");
        return;
      }
      setMode("bootstrap-token");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red.");
      setMode("bootstrap-token");
    }
  }

  async function loadMetrics(token: string): Promise<boolean> {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/metrics", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "No tienes acceso de administrador.");
      }
      const data = (await response.json()) as AdminMetrics;
      setMetrics(data);
      setAuthToken(token);
      setMode("dashboard");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar métricas.");
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function handleBootstrapToken(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const value = bootstrapToken.trim();
    if (!value) {
      setError("Pega el FACELOGIN_ADMIN_TOKEN del servidor.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/admin/metrics", {
        headers: { Authorization: `Bearer ${value}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Token inválido.");
      }
      const data = (await response.json()) as AdminMetrics;
      if (mode === "emergency-token" || data.bootstrapped) {
        sessionStorage.removeItem(BOOTSTRAP_KEY);
        setAuthToken(value);
        setMetrics(data);
        setMode("dashboard");
        return;
      }
      sessionStorage.setItem(BOOTSTRAP_KEY, value);
      setBootstrapToken(value);
      setMode("bootstrap-setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token inválido.");
    } finally {
      setLoading(false);
    }
  }

  const enrollConditions: EnrollCondition[] = glasses ? GLASSES_CONDITIONS : SINGLE_CONDITION;

  async function identifyWithDevice(captures: Capture[]) {
    let proof;
    try {
      proof = await deviceProof();
    } catch {
      try {
        await ensureDevice();
        proof = await deviceProof();
      } catch {
        proof = undefined;
      }
    }
    const descriptors = bestLoginDescriptors(captures);
    const shape = captureShape(captures);
    try {
      const result = await identify(descriptors, shape, proof);
      if (result.trustedDevice || result.newDevice) markDeviceTrustedLocally();
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "PASSKEY_REQUIRED") throw error;
      // Sin passkey registrada (caso típico del primer operador) no hay que
      // colgarse en el diálogo WebAuthn: el aparato debió quedar de confianza
      // en el enrolamiento.
      if (!passkeySupported()) {
        throw new Error(
          "Este aparato no quedó de confianza. Vuelve a registrar tu cara o usa el token de emergencia.",
        );
      }
      try {
        const passkey = await Promise.race([
          authenticatePasskey(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Passkey cancelada o no disponible.")), 45_000),
          ),
        ]);
        return await identify(descriptors, shape, proof, passkey);
      } catch {
        throw new Error(
          "No pudimos confirmar el aparato. Reintenta: a veces hace falta permitir el micrófono/cámara y repetir el gesto.",
        );
      }
    }
  }

  async function enterWithFace(result: IdentifyResult) {
    if (result.trustedDevice) {
      markDeviceTrustedLocally();
      sessionStorage.setItem(SESSION_KEY, result.token);
      sessionStorage.removeItem(BOOTSTRAP_KEY);
      setOperatorName(result.identity.displayName);
      const ok = await loadMetrics(result.token);
      if (!ok) {
        setError("Tu cara entró, pero no eres operador del panel. Completa el registro inicial.");
        setMode("face-login");
      }
      return;
    }
    setPendingTrust({ token: result.token, identity: result.identity });
    setMode("trust");
  }

  async function confirmTrust() {
    if (!pendingTrust) return;
    try {
      const device = await deviceProof();
      await trustDevice(pendingTrust.token, device);
      markDeviceTrustedLocally();
      sessionStorage.setItem(SESSION_KEY, pendingTrust.token);
      sessionStorage.removeItem(BOOTSTRAP_KEY);
      setOperatorName(pendingTrust.identity.displayName);
      setPendingTrust(null);
      const ok = await loadMetrics(pendingTrust.token);
      if (!ok) {
        setError("Aparato confiable, pero no eres operador del panel.");
        setMode("face-login");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confiar en este aparato.");
    }
  }

  async function handleAddPasskey() {
    if (!authToken) return;
    setError("");
    try {
      await registerPasskey(authToken);
      setError("");
      await loadMetrics(authToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la passkey.");
    }
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(BOOTSTRAP_KEY);
    setAuthToken("");
    setMetrics(null);
    setCreated(null);
    setOperatorName(null);
    void bootstrap();
  }

  async function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setCreated(null);
    if (!authToken.trim()) return;
    setCreating(true);
    try {
      const response = await fetch("/api/admin/clients", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: appName.trim(),
          redirect_uris: [redirectUri.trim()],
          confidential: true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "No se pudo registrar la app.");
      setCreated({
        client_id: body.client.client_id,
        client_secret: body.client_secret,
        name: body.client.name,
        redirect_uris: body.client.redirect_uris,
      });
      setAppName("");
      setRedirectUri("");
      await loadMetrics(authToken.trim());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error al registrar.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(clientId: string, label: string) {
    if (!authToken.trim()) return;
    if (!window.confirm(`¿Revocar «${label}»?`)) return;
    try {
      const response = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken.trim()}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "No se pudo revocar.");
      await loadMetrics(authToken.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al revocar.");
    }
  }

  async function handleClearGallery() {
    if (!authToken.trim()) return;
    if (!window.confirm("Esto borra TODAS las caras registradas. ¿Seguro?")) return;
    setClearing(true);
    try {
      const response = await fetch("/api/identities", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken.trim()}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "No se pudo vaciar.");
      await loadMetrics(authToken.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al vaciar.");
    } finally {
      setClearing(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* ignore */
    }
  }

  if (mode === "loading") {
    return (
      <main className="app">
        <Screen id="admin-loading">
          <p className="body">Preparando el panel…</p>
        </Screen>
      </main>
    );
  }

  if (mode === "bootstrap-token" || mode === "emergency-token") {
    return (
      <main className="app">
        <Screen id="admin-token" onBack={onExit}>
          <p className="eyebrow">Panel facelogin</p>
          <h1 className="display">
            {mode === "emergency-token" ? "Token de emergencia" : "Primera vez"}
          </h1>
          <p className="body">
            {mode === "emergency-token"
              ? "Usa el FACELOGIN_ADMIN_TOKEN del servidor si no puedes entrar con la cara."
              : "Pega el FACELOGIN_ADMIN_TOKEN (está en el .env del servidor). Después registras tu cara y ya no lo necesitas."}
          </p>
          <form className="stack" onSubmit={handleBootstrapToken}>
            <label className="field">
              <span className="field__label">Token de administrador</span>
              <input
                className="input"
                type="password"
                value={bootstrapToken}
                autoFocus
                placeholder="FACELOGIN_ADMIN_TOKEN"
                onChange={(e) => setBootstrapToken(e.target.value)}
              />
            </label>
            <button className="btn btn--primary" type="submit" disabled={loading || !bootstrapToken.trim()}>
              {loading ? "Validando…" : "Continuar"}
            </button>
            {mode === "emergency-token" && (
              <button className="btn btn--quiet" type="button" onClick={() => setMode("face-login")}>
                Volver a entrar con la cara
              </button>
            )}
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

  if (mode === "bootstrap-setup") {
    return (
      <main className="app">
        <Screen id="admin-setup" onBack={() => setMode("bootstrap-token")}>
          <p className="eyebrow">Paso 2 · Tu cara</p>
          <h1 className="display">Registra al operador</h1>
          <p className="body">
            Esta cara será la llave del panel. Después entrarás con ella, sin pegar el token.
          </p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length < 2 || glasses === null) return;
              setError("");
              setMode("bootstrap-enroll");
            }}
          >
            <label className="field">
              <span className="field__label">Tu nombre</span>
              <input
                className="input"
                value={name}
                autoFocus
                placeholder="Cómo te reconocemos en el panel"
                onChange={(e) => setName(e.target.value)}
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
            </fieldset>

            <button
              className="btn btn--primary"
              type="submit"
              disabled={name.trim().length < 2 || glasses === null}
            >
              {glasses === null ? "Elige si usas lentes" : "Encender la cámara"}
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

  if (mode === "bootstrap-enroll") {
    return (
      <main className="app">
        <Suspense fallback={<Warming />}>
          <FaceCapture
            title="Registrar operador"
            flow="enroll"
            challenges={enrollChallenges}
            conditions={enrollConditions}
            error={error}
            onError={setError}
            onCancel={() => setMode("bootstrap-setup")}
            onComplete={async (captures) => {
              setError("");
              try {
                const device = await ensureDevice();
                const result = await enroll(
                  name.trim(),
                  groupByCondition(captures),
                  captureShape(captures),
                  device,
                  bootstrapToken.trim(),
                );
                const promote = await fetch("/api/admin/operators", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${bootstrapToken.trim()}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    identityId: result.id,
                    displayName: result.displayName,
                  }),
                });
                const body = await promote.json().catch(() => ({}));
                if (!promote.ok) {
                  throw new Error(body.error || "No se pudo promover al operador.");
                }
                markDeviceTrustedLocally();
                sessionStorage.removeItem(BOOTSTRAP_KEY);
                setOperatorName(result.displayName);

                // Misma captura → sesión de admin, sin segundo baile ni hang de passkey.
                try {
                  const session = await identifyWithDevice(captures);
                  await enterWithFace(session);
                } catch (loginError) {
                  setError(
                    loginError instanceof Error
                      ? loginError.message
                      : "Registrado. Ahora entra con tu cara.",
                  );
                  setMode("face-login");
                }
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "No se pudo registrar.");
                setMode("bootstrap-setup");
              }
            }}
          />
        </Suspense>
        {error && (
          <p className="toast" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }

  if (mode === "face-login") {
    return (
      <main className="app">
        <Suspense fallback={<Warming />}>
          <FaceCapture
            title="Entrar al panel"
            flow="login"
            challenges={isDeviceTrustedLocally() ? trustedChallenges : loginChallenges}
            conditions={SINGLE_CONDITION}
            error={error}
            forceVoice={!isDeviceTrustedLocally()}
            onError={setError}
            onCancel={onExit}
            onComplete={async (captures) => {
              setError("");
              try {
                const result = await identifyWithDevice(captures);
                await enterWithFace(result);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "No te reconocimos.");
              }
            }}
          />
        </Suspense>
        <div className="admin__face-footer">
          <button className="btn btn--quiet" type="button" onClick={() => setMode("emergency-token")}>
            Usar token de emergencia
          </button>
          {error && (
            <p className="toast" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  if (mode === "trust" && pendingTrust) {
    return (
      <main className="app">
        <Screen id="admin-trust">
          <p className="eyebrow">Aparato nuevo</p>
          <h1 className="display">Confía en este aparato</h1>
          <p className="body">
            Hola, {pendingTrust.identity.displayName}. Confirma para entrar al panel sin pedir
            passkey cada vez en este aparato.
          </p>
          <div className="stack">
            <button className="btn btn--primary" type="button" onClick={() => void confirmTrust()}>
              Confiar y entrar
            </button>
            <button className="btn btn--quiet" type="button" onClick={() => setMode("face-login")}>
              Cancelar
            </button>
          </div>
          {error && (
            <p className="toast" role="alert">
              {error}
            </p>
          )}
        </Screen>
      </main>
    );
  }

  return (
    <main className="app app--admin">
      <div className="admin">
        <header className="admin__header">
          <div className="admin__header-inner">
            <div>
              <p className="eyebrow">Panel facelogin</p>
              <h1 className="admin__title">Operación</h1>
              <p className="admin__subtitle">
                {operatorName ? `Sesión de ${operatorName}` : "Personas, apps y actividad"}
                {metrics?.issuer ? (
                  <>
                    {" "}
                    · <code className="admin__issuer">{metrics.issuer}</code>
                  </>
                ) : null}
              </p>
            </div>
            <div className="admin__header-actions">
              {passkeySupported() && authToken && (
                <button className="btn btn--quiet" type="button" onClick={() => void handleAddPasskey()}>
                  Añadir passkey
                </button>
              )}
              <button className="btn btn--quiet" type="button" onClick={() => void loadMetrics(authToken)}>
                Actualizar
              </button>
              <button className="btn btn--quiet" type="button" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </header>

        {loading && !metrics && <p className="body">Cargando…</p>}

        {metrics && (
          <div className="admin__content">
            <div className="admin-metrics">
              <div className="metric-card">
                <div className="metric-card__label">Personas</div>
                <div className="metric-card__value">{metrics.enrolledIdentities}</div>
              </div>
              <div className="metric-card">
                <div className="metric-card__label">Entradas hoy</div>
                <div className="metric-card__value">{metrics.todayLogins}</div>
              </div>
              <div className="metric-card">
                <div className="metric-card__label">Esta semana</div>
                <div className="metric-card__value">{metrics.weekLogins}</div>
              </div>
              <div className="metric-card">
                <div className="metric-card__label">Rechazos hoy</div>
                <div className="metric-card__value">{metrics.todayFails}</div>
              </div>
              <div className="metric-card">
                <div className="metric-card__label">Apps</div>
                <div className="metric-card__value">{metrics.oidcClients}</div>
              </div>
              <div className="metric-card">
                <div className="metric-card__label">Operadores</div>
                <div className="metric-card__value">{metrics.operators?.length ?? 0}</div>
              </div>
            </div>

            <section className="admin__panel" id="registrar-app">
              <h2 className="admin__table-title">Registrar app</h2>
              <p className="admin__hint">
                Genera <code>client_id</code> y <code>client_secret</code>. El secret solo se muestra
                una vez.
              </p>
              <form className="admin__form" onSubmit={handleCreateApp}>
                <label className="field">
                  <span className="field__label">Nombre</span>
                  <input
                    className="input"
                    value={appName}
                    placeholder="Tetris"
                    onChange={(e) => setAppName(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span className="field__label">Redirect URI</span>
                  <input
                    className="input"
                    value={redirectUri}
                    placeholder="https://tetris-ten-beta.vercel.app/auth/facelogin/callback"
                    onChange={(e) => setRedirectUri(e.target.value)}
                    required
                  />
                </label>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={creating || !appName.trim() || !redirectUri.trim()}
                >
                  {creating ? "Creando…" : "Crear credenciales"}
                </button>
              </form>
              {formError && (
                <p className="toast" role="alert">
                  {formError}
                </p>
              )}
              {created && (
                <div className="admin__secrets" role="status">
                  <p className="admin__secrets-title">
                    Credenciales de <strong>{created.name}</strong> — cópialas ya
                  </p>
                  <div className="admin__secret-row">
                    <span>FACELOGIN_CLIENT_ID</span>
                    <code>{created.client_id}</code>
                    <button type="button" className="btn btn--chip" onClick={() => void copyText(created.client_id)}>
                      Copiar
                    </button>
                  </div>
                  {created.client_secret && (
                    <div className="admin__secret-row">
                      <span>FACELOGIN_CLIENT_SECRET</span>
                      <code>{created.client_secret}</code>
                      <button
                        type="button"
                        className="btn btn--chip"
                        onClick={() => void copyText(created.client_secret as string)}
                      >
                        Copiar
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="admin__table-section">
              <h2 className="admin__table-title">Apps conectadas</h2>
              {metrics.apps.length === 0 ? (
                <p className="admin__empty">Ninguna app aún.</p>
              ) : (
                <div className="admin__table-wrap">
                  <table className="admin__table">
                    <thead>
                      <tr>
                        <th>App</th>
                        <th>client_id</th>
                        <th>Redirect</th>
                        <th>Entradas</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.apps.map((app) => (
                        <tr key={app.client_id}>
                          <td>{app.name}</td>
                          <td>
                            <code>{app.client_id}</code>
                          </td>
                          <td className="admin__uri">{app.redirect_uris.join(", ")}</td>
                          <td>{app.logins}</td>
                          <td>
                            {app.source === "admin" ? (
                              <button
                                type="button"
                                className="btn btn--chip"
                                onClick={() => void handleRevoke(app.client_id, app.name)}
                              >
                                Revocar
                              </button>
                            ) : (
                              <span className="admin__muted">Env</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="admin__table-section">
              <div className="admin__section-head">
                <h2 className="admin__table-title">Personas</h2>
                <button
                  type="button"
                  className="btn btn--chip"
                  disabled={clearing || metrics.enrolledIdentities === 0}
                  onClick={() => void handleClearGallery()}
                >
                  {clearing ? "Vaciando…" : "Vaciar galería"}
                </button>
              </div>
              {metrics.identities.length === 0 ? (
                <p className="admin__empty">Todavía no hay nadie registrado.</p>
              ) : (
                <div className="admin__table-wrap">
                  <table className="admin__table">
                    <thead>
                      <tr>
                        <th>Nombre</th>
                        <th>Registrado</th>
                        <th>Última entrada</th>
                        <th>Aparatos</th>
                        <th>Passkeys</th>
                        <th>Rol</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.identities.map((person) => (
                        <tr key={person.id}>
                          <td>{person.name}</td>
                          <td>{formatWhen(person.enrolledAt)}</td>
                          <td>{formatWhen(person.lastSeen)}</td>
                          <td>{person.devices}</td>
                          <td>{person.passkeys}</td>
                          <td>{person.isOperator ? "Operador" : person.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="admin__table-section">
              <h2 className="admin__table-title">Actividad reciente</h2>
              {metrics.activity.length === 0 ? (
                <p className="admin__empty">Aún no hay eventos.</p>
              ) : (
                <ul className="admin__activity">
                  {metrics.activity.map((event, index) => (
                    <li key={`${event.at}-${index}`} className="admin__activity-item">
                      <span className="admin__activity-kind">{kindLabel(event.kind)}</span>
                      <span className="admin__activity-detail">
                        {event.detail}
                        {event.identity ? ` · ${event.identity}` : ""}
                        {event.clientId ? ` · ${event.clientId}` : ""}
                      </span>
                      <time className="admin__activity-time" dateTime={event.at}>
                        {formatWhen(event.at)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {error && (
          <p className="toast" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
