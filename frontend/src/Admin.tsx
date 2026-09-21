/**
 * Admin Dashboard — uso del sistema + registro de apps OIDC
 *
 * Copy de marketing: sin FAR/FPIR/LSH en UI.
 */

import { useEffect, useState } from "react";

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
  }>;
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
};

type CreatedCredentials = {
  client_id: string;
  client_secret: string | null;
  name: string;
  redirect_uris: string[];
};

type AdminProps = {
  onExit: () => void;
};

function Screen({ id, children, onBack }: { id: string; children: React.ReactNode; onBack?: () => void }) {
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

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("es", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
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
  const [mode, setMode] = useState<"login" | "dashboard">("login");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [appName, setAppName] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedCredentials | null>(null);
  const [clearing, setClearing] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const stored = sessionStorage.getItem("facelogin.admin.token");
    if (stored) {
      setToken(stored);
      void loadMetrics(stored);
    }
  }, []);

  async function loadMetrics(adminToken: string) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/metrics", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "No tienes acceso de administrador.");
      }
      const data = (await response.json()) as AdminMetrics;
      setMetrics(data);
      setMode("dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar métricas.");
      sessionStorage.removeItem("facelogin.admin.token");
      setToken("");
      setMode("login");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("Pega tu token de administrador.");
      return;
    }
    sessionStorage.setItem("facelogin.admin.token", token.trim());
    await loadMetrics(token.trim());
  }

  function handleLogout() {
    sessionStorage.removeItem("facelogin.admin.token");
    setToken("");
    setMetrics(null);
    setCreated(null);
    setMode("login");
  }

  async function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setCreated(null);
    if (!token.trim()) return;
    setCreating(true);
    try {
      const response = await fetch("/api/admin/clients", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: appName.trim(),
          redirect_uris: [redirectUri.trim()],
          confidential: true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "No se pudo registrar la app.");
      }
      setCreated({
        client_id: body.client.client_id,
        client_secret: body.client_secret,
        name: body.client.name,
        redirect_uris: body.client.redirect_uris,
      });
      setAppName("");
      setRedirectUri("");
      await loadMetrics(token.trim());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error al registrar.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(clientId: string, name: string) {
    if (!token.trim()) return;
    if (!window.confirm(`¿Revocar «${name}»? Dejará de poder iniciar sesión con facelogin.`)) return;
    try {
      const response = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "No se pudo revocar.");
      await loadMetrics(token.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al revocar.");
    }
  }

  async function handleClearGallery() {
    if (!token.trim()) return;
    if (
      !window.confirm(
        "Esto borra TODAS las caras registradas. No se puede deshacer. ¿Seguro?",
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const response = await fetch("/api/identities", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "No se pudo vaciar.");
      await loadMetrics(token.trim());
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

  if (mode === "login") {
    return (
      <main className="app">
        <Screen id="admin-login" onBack={onExit}>
          <span className="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2.8 4.5 6v6c0 4.2 3 7.7 7.5 9.2 4.5-1.5 7.5-5 7.5-9.2V6L12 2.8Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="11" r="1.5" fill="currentColor" />
            </svg>
          </span>
          <p className="eyebrow">Panel facelogin</p>
          <h1 className="display">Solo administradores</h1>
          <p className="body">
            Pega el <code>FACELOGIN_ADMIN_TOKEN</code> de tu servidor. Si acabas de arrancar
            facelogin por primera vez, ya se generó solo en el <code>.env</code>.
          </p>
          <form className="stack" onSubmit={handleLogin}>
            <label className="field">
              <span className="field__label">Token de administrador</span>
              <input
                className="input"
                type="password"
                value={token}
                autoFocus
                placeholder="FACELOGIN_ADMIN_TOKEN"
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <button className="btn btn--primary" type="submit" disabled={loading || !token.trim()}>
              {loading ? "Validando..." : "Entrar"}
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

  return (
    <main className="app app--admin">
      <div className="admin">
        <header className="admin__header">
          <div className="admin__header-inner">
            <div>
              <p className="eyebrow">Panel facelogin</p>
              <h1 className="admin__title">Operación</h1>
              <p className="admin__subtitle">
                Personas, apps conectadas y actividad en vivo
                {metrics?.issuer ? (
                  <>
                    {" "}
                    · <code className="admin__issuer">{metrics.issuer}</code>
                  </>
                ) : null}
              </p>
            </div>
            <div className="admin__header-actions">
              <button className="btn btn--quiet" type="button" onClick={() => void loadMetrics(token)}>
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
              <div className="metric-card metric-card--wide">
                <div className="metric-card__label">Último acceso</div>
                <div className="metric-card__value metric-card__value--small">
                  {formatWhen(metrics.lastAccess)}
                </div>
              </div>
            </div>

            <section className="admin__panel" id="registrar-app">
              <h2 className="admin__table-title">Registrar app</h2>
              <p className="admin__hint">
                Genera <code>client_id</code> y <code>client_secret</code> para tu producto (p. ej.
                Tetris). El secret solo se muestra una vez.
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
                  <p className="admin__hint">
                    En Vercel de tu app: pega esos dos valores. Redirect registrada:{" "}
                    <code>{created.redirect_uris[0]}</code>
                  </p>
                </div>
              )}
            </section>

            <section className="admin__table-section">
              <h2 className="admin__table-title">Apps conectadas</h2>
              {metrics.apps.length === 0 ? (
                <p className="admin__empty">Ninguna app aún. Registra la primera arriba.</p>
              ) : (
                <div className="admin__table-wrap">
                  <table className="admin__table">
                    <thead>
                      <tr>
                        <th>App</th>
                        <th>client_id</th>
                        <th>Redirect</th>
                        <th>Entradas</th>
                        <th>Origen</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.apps.map((app) => (
                        <tr key={app.client_id}>
                          <td>
                            {app.name}
                            {app.confidential ? "" : " · pública"}
                          </td>
                          <td>
                            <code>{app.client_id}</code>
                          </td>
                          <td className="admin__uri">{app.redirect_uris.join(", ")}</td>
                          <td>
                            {app.logins}
                            {app.lastUsed ? (
                              <span className="admin__muted"> · {formatWhen(app.lastUsed)}</span>
                            ) : null}
                          </td>
                          <td>{app.source === "env" ? "Env" : "Admin"}</td>
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
                              <span className="admin__muted">Fijo</span>
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
                        <th>Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.identities.map((person) => (
                        <tr key={person.id}>
                          <td>{person.name}</td>
                          <td>{formatWhen(person.enrolledAt)}</td>
                          <td>{formatWhen(person.lastSeen)}</td>
                          <td>
                            {person.devices} · {person.passkeys} passkeys
                          </td>
                          <td>{person.status}</td>
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
                <p className="admin__empty">Aún no hay eventos. Aparecerán al registrar o entrar.</p>
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
