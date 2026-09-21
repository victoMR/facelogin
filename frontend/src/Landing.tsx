/**
 * Landing Page — Marketing y producto
 * 
 * Ruta: /
 * 
 * Aquí llegan los visitantes nuevos. Explica qué es facelogin, cómo integrarlo,
 * y los envía a /app para enrolar/entrar.
 */

type LandingProps = {
  onEnter: () => void;
};

export function Landing({ onEnter }: LandingProps) {
  return (
    <main className="landing">
      {/* Hero */}
      <section className="landing__hero" id="hero">
        <div className="landing__container">
          <p className="landing__eyebrow">facelogin — La foto no viaja</p>
          <h1 className="landing__title">
            Autenticación facial
            <br />
            sin contraseña.
          </h1>
          <p className="landing__lead">
            Tu rostro se cifra en el servidor. El descriptor se calcula en el navegador.
            <br />
            La foto no sale de tu dispositivo.
          </p>
          <div className="landing__actions">
            <button className="btn btn--primary btn--large" onClick={onEnter}>
              Entrar con tu cara
            </button>
            <a href="#integrar" className="btn btn--quiet btn--large">
              Ver docs de integración
            </a>
          </div>
        </div>
      </section>

      {/* Historia del producto */}
      <section className="landing__section" id="historia">
        <div className="landing__container">
          <h2 className="landing__section-title">¿Qué es facelogin?</h2>
          <div className="landing__grid">
            <div className="landing__feature">
              <div className="landing__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="32" height="32">
                  <path
                    d="M12 2.8 4.5 6v6c0 4.2 3 7.7 7.5 9.2 4.5-1.5 7.5-5 7.5-9.2V6L12 2.8Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h3 className="landing__feature-title">La foto no viaja</h3>
              <p className="landing__feature-desc">
                El descriptor facial se calcula en tu navegador. El servidor solo guarda
                plantillas cifradas con AES-256-GCM. Un vault filtrado no entrega fotos ni
                vectores en claro.
              </p>
            </div>

            <div className="landing__feature">
              <div className="landing__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="32" height="32">
                  <path
                    d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h3 className="landing__feature-title">Liveness activo</h3>
              <p className="landing__feature-desc">
                Prueba de vida con gestos (frente, parpadeo, giro) antes de enrolar o entrar.
                Corre en el cliente; el factor vinculante es la firma del dispositivo o una passkey.
              </p>
            </div>

            <div className="landing__feature">
              <div className="landing__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="32" height="32">
                  <rect
                    x="3"
                    y="3"
                    width="18"
                    height="18"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="landing__feature-title">Listo como IdP OIDC</h3>
              <p className="landing__feature-desc">
                Authorization code + PKCE (S256), firma RS256, sub pairwise por cliente.
                Integra tu app en minutos. El servicio cliente recibe un id_token firmado,
                nunca la plantilla facial.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Beneficios */}
      <section className="landing__section landing__section--alt" id="beneficios">
        <div className="landing__container">
          <h2 className="landing__section-title">Sin password, sin phishing</h2>
          <ul className="landing__list">
            <li>
              <strong>Sin contraseña.</strong> No hay nada que olvidar, rotar o filtrar.
            </li>
            <li>
              <strong>Multi-condición.</strong> Enrola con lentes y sin ellos; entra te los pongas o no.
            </li>
            <li>
              <strong>Umbral adaptativo.</strong> Se calcula por persona y por tamaño de galería,
              no es un número mágico único.
            </li>
            <li>
              <strong>Plantillas cifradas.</strong> AES-256-GCM. El vault en reposo no entrega
              caras ni vectores.
            </li>
            <li>
              <strong>Índice LSH con HMAC.</strong> Las cubetas se firman; no se puede reconstruir
              el embedding desde la clave de cubeta.
            </li>
          </ul>
        </div>
      </section>

      {/* Cómo integrar */}
      <section className="landing__section" id="integrar">
        <div className="landing__container">
          <h2 className="landing__section-title">Cómo integrar facelogin con tu app</h2>
          <div className="landing__steps">
            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">
                1
              </div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Registra tu cliente OIDC</h3>
                <p className="landing__step-desc">
                  Añade tu app en <code>FACELOGIN_OIDC_CLIENTS</code> con client_id, redirect_uri
                  y scopes. Ver <code>backend/config/clients.example.json</code>.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">
                2
              </div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Descubre el emisor</h3>
                <p className="landing__step-desc">
                  Lee <code>GET /.well-known/openid-configuration</code> y{" "}
                  <code>/.well-known/jwks.json</code> para obtener endpoints y claves públicas.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">
                3
              </div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Inicia el flujo</h3>
                <p className="landing__step-desc">
                  Envía al usuario a <code>GET /authorize</code> con code_challenge (PKCE S256).
                  Volverá con un código de un solo uso.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">
                4
              </div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Canjea el código</h3>
                <p className="landing__step-desc">
                  Envía el código y el code_verifier a <code>POST /token</code>. Recibes id_token
                  (JWT RS256) y access_token. Verifica el id_token con la clave pública del JWKS.
                </p>
              </div>
            </div>
          </div>

          <div className="landing__docs-link">
            <p>
              <strong>Documentación completa:</strong>{" "}
              <a
                href="https://github.com/victoMR/facelogin/blob/main/docs/integracion-oidc.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                docs/integracion-oidc.md
              </a>
            </p>
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="landing__section landing__section--cta">
        <div className="landing__container">
          <h2 className="landing__section-title">Pruébalo ahora</h2>
          <p className="landing__lead">
            Sin registro previo. Enrola tu rostro y entra en segundos.
          </p>
          <div className="landing__actions">
            <button className="btn btn--primary btn--large" onClick={onEnter}>
              Entrar con tu cara
            </button>
            <a
              href="https://github.com/victoMR/facelogin"
              className="btn btn--quiet btn--large"
              target="_blank"
              rel="noopener noreferrer"
            >
              Ver código en GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing__footer">
        <div className="landing__container">
          <p className="landing__footer-text">
            facelogin — Open Source (MIT) · Demo / IdP interno ·{" "}
            <a
              href="https://github.com/victoMR/facelogin"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </p>
          <p className="landing__footer-disclaimer">
            El liveness corre en el cliente. El factor vinculante es la firma del dispositivo o una
            passkey. No es Face ID bancario.
          </p>
        </div>
      </footer>
    </main>
  );
}
