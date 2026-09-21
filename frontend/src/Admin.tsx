/**
 * Admin Dashboard — Copy final de Marketing
 * 
 * Rutas:
 * - /admin: login con admin token
 * - /admin/dashboard: métricas del sistema
 * 
 * Copy VERBATIM de Marketing. No FAR/FPIR/LSH en UI.
 */

import { useState, useEffect } from "react";

type AdminMetrics = {
  enrolledIdentities: number;
  todayLogins?: number;
  weekLogins?: number;
  oidcClients?: number;
  lastAccess?: string;
  identities?: Array<{
    name: string;
    enrolledAt: string;
    lastSeen: string;
    status: string;
  }>;
  apps?: Array<{
    name: string;
    lastUsed: string;
    logins: number;
  }>;
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

export function Admin({ onExit }: AdminProps) {
  const [mode, setMode] = useState<"login" | "dashboard">("login");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Restaurar token de sessionStorage
    const stored = sessionStorage.getItem("facelogin.admin.token");
    if (stored) {
      setToken(stored);
      void loadMetrics(stored);
      setMode("dashboard");
    }
  }, []);

  async function loadMetrics(adminToken: string) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/metrics", {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });
      
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "No tienes acceso de administrador.");
      }
      
      const data = await response.json();
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
    setMode("login");
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
            Pega tu token de administrador para ver el uso del sistema.
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
            <button
              className="btn btn--primary"
              type="submit"
              disabled={loading || !token.trim()}
            >
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
              <h1 className="admin__title">Uso de facelogin</h1>
              <p className="admin__subtitle">Quién entra y qué apps lo usan</p>
            </div>
            <div className="admin__header-actions">
              <button className="btn" disabled>Invitar</button>
              <button className="btn btn--quiet" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </header>

        {loading && <p className="body">Cargando métricas...</p>}
        
        {metrics && !loading && (
          <div className="admin__content">
            {/* Métricas cards */}
            <div className="admin-metrics">
              <div className="metric-card">
                <div className="metric-card__label">Personas registradas</div>
                <div className="metric-card__value">{metrics.enrolledIdentities}</div>
              </div>

              <div className="metric-card">
                <div className="metric-card__label">Entradas hoy</div>
                <div className="metric-card__value">{metrics.todayLogins ?? 0}</div>
              </div>

              <div className="metric-card">
                <div className="metric-card__label">Entradas esta semana</div>
                <div className="metric-card__value">{metrics.weekLogins ?? 0}</div>
              </div>

              <div className="metric-card">
                <div className="metric-card__label">Apps conectadas</div>
                <div className="metric-card__value">{metrics.oidcClients ?? 0}</div>
              </div>

              {metrics.lastAccess && (
                <div className="metric-card metric-card--wide">
                  <div className="metric-card__label">Último acceso</div>
                  <div className="metric-card__value metric-card__value--small">
                    {metrics.lastAccess}
                  </div>
                </div>
              )}
            </div>

            {/* Tabla Personas */}
            <div className="admin__table-section">
              <h2 className="admin__table-title">Personas</h2>
              {(!metrics.identities || metrics.identities.length === 0) ? (
                <p className="admin__empty">Todavía no hay nadie registrado.</p>
              ) : (
                <table className="admin__table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Registrado</th>
                      <th>Última entrada</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.identities.map((identity, i) => (
                      <tr key={i}>
                        <td>{identity.name}</td>
                        <td>{identity.enrolledAt}</td>
                        <td>{identity.lastSeen}</td>
                        <td>{identity.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Tabla Apps */}
            <div className="admin__table-section">
              <h2 className="admin__table-title">Apps</h2>
              {(!metrics.apps || metrics.apps.length === 0) ? (
                <p className="admin__empty">
                  Ninguna app conectada aún. Sigue{" "}
                  <a href="/#integrar">Cómo integrar</a>.
                </p>
              ) : (
                <table className="admin__table">
                  <thead>
                    <tr>
                      <th>App</th>
                      <th>Último uso</th>
                      <th>Entradas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.apps.map((app, i) => (
                      <tr key={i}>
                        <td>{app.name}</td>
                        <td>{app.lastUsed}</td>
                        <td>{app.logins}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
