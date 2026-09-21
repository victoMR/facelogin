/**
 * Admin Dashboard — Métricas y gestión básica
 * 
 * Rutas:
 * - /admin: login con admin token
 * - /admin/dashboard: métricas del sistema
 * 
 * Protegido con FACELOGIN_ADMIN_TOKEN (no frontend bundle).
 * Session storage para el token de admin tras validación.
 */

import { useState, useEffect } from "react";

type AdminMetrics = {
  enrolledIdentities: number;
  recentActivity?: {
    identify: number;
    enroll: number;
  };
  oidcClients?: number;
};

type AdminProps = {
  onExit: () => void;
};

function Screen({ id, children, onBack }: { id: string; children: React.ReactNode; onBack?: () => void }) {
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
        throw new Error(body.error || "No autorizado.");
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
          <p className="eyebrow">Administración</p>
          <h1 className="display">Panel de control</h1>
          <p className="body">
            Pega tu token de administrador para ver métricas del sistema.
            El token se guarda solo en sessionStorage, no en el bundle.
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
    <main className="app">
      <Screen id="admin-dashboard" onBack={onExit}>
        <span className="glyph glyph--ok" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path d="M3 9h18M9 3v18" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
        <p className="eyebrow">Administración</p>
        <h1 className="display">Panel de control</h1>
        
        {loading && <p className="body">Cargando métricas...</p>}
        
        {metrics && !loading && (
          <div className="admin-metrics">
            <div className="metric-card">
              <div className="metric-card__label">Identidades enroladas</div>
              <div className="metric-card__value">{metrics.enrolledIdentities}</div>
            </div>

            {metrics.recentActivity && (
              <>
                <div className="metric-card">
                  <div className="metric-card__label">Identificaciones recientes</div>
                  <div className="metric-card__value">{metrics.recentActivity.identify}</div>
                  <div className="metric-card__hint">Últimos 60 segundos</div>
                </div>

                <div className="metric-card">
                  <div className="metric-card__label">Enrolamientos recientes</div>
                  <div className="metric-card__value">{metrics.recentActivity.enroll}</div>
                  <div className="metric-card__hint">Últimos 60 segundos</div>
                </div>
              </>
            )}

            {metrics.oidcClients !== undefined && (
              <div className="metric-card">
                <div className="metric-card__label">Clientes OIDC configurados</div>
                <div className="metric-card__value">{metrics.oidcClients}</div>
              </div>
            )}
          </div>
        )}

        <div className="stack">
          <button
            className="btn"
            onClick={() => {
              if (token) void loadMetrics(token);
            }}
            disabled={loading}
          >
            Actualizar métricas
          </button>
          <button className="btn btn--quiet" onClick={handleLogout}>
            Cerrar sesión de admin
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
