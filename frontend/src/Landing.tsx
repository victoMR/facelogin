/**
 * Landing Page — Marketing copy final
 * 
 * Ruta: /
 * 
 * Copy de Marketing (VERBATIM). No cambiar sin aprobación.
 */

type LandingProps = {
  onEnter: () => void;
  onAdmin: () => void;
};

export function Landing({ onEnter, onAdmin }: LandingProps) {
  return (
    <main className="landing">
      {/* Nav */}
      <nav className="landing__nav">
        <div className="landing__container">
          <div className="landing__nav-inner">
            <a href="#hero" className="landing__nav-brand">facelogin</a>
            <div className="landing__nav-links">
              <a href="#integrar">Cómo integrar</a>
              <a href="https://github.com/victoMR/facelogin/tree/main/docs" target="_blank" rel="noopener noreferrer">Docs</a>
              <button className="btn btn--nav" onClick={onEnter}>Entrar con tu cara</button>
              <button className="btn btn--nav-quiet" onClick={onAdmin}>Admin</button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing__hero" id="hero">
        <div className="landing__container">
          <p className="landing__eyebrow">Auth open source sin password</p>
          <h1 className="landing__title">La foto no viaja.</h1>
          <p className="landing__lead">
            Agrega "Entrar con tu cara" a tu app. Sin contraseñas que olvidar. Sin mandar fotos a tu servidor.
          </p>
          <div className="landing__actions">
            <a href="#integrar" className="btn btn--primary btn--large">
              Cómo integrar
            </a>
            <button className="btn btn--quiet btn--large" onClick={onEnter}>
              Probar la demo
            </button>
          </div>
        </div>
      </section>

      {/* Quiénes somos */}
      <section className="landing__section" id="quienes-somos">
        <div className="landing__container">
          <h2 className="landing__section-title">Nacimos del cansancio de las trabas</h2>
          <p className="landing__body-large">
            Estamos hartos de elegir entre seguridad de verdad y un diseño que sí funciona. Los passwords
            se olvidan; los vaults ayudan, pero la vida sería más fácil si tu cara fuera la llave — con
            privacidad obsesiva y código que cualquiera puede auditar.
          </p>
        </div>
      </section>

      {/* Beneficios */}
      <section className="landing__section landing__section--alt" id="beneficios">
        <div className="landing__container">
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
                  <path d="M9 10h6M9 14h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="landing__feature-title">Cero password</h3>
              <p className="landing__feature-desc">
                Se acabó "¿cuál era mi usuario?"
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
              <h3 className="landing__feature-title">La foto no viaja</h3>
              <p className="landing__feature-desc">
                El navegador saca un descriptor; tu app no recibe ni guarda caras.
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
              <h3 className="landing__feature-title">Enchufable</h3>
              <p className="landing__feature-desc">
                OIDC + PKCE. Un botón en tu login actual.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Cómo integrar */}
      <section className="landing__section" id="integrar">
        <div className="landing__container">
          <h2 className="landing__section-title">Cómo integrar</h2>
          <div className="landing__steps">
            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">1</div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Corre facelogin</h3>
                <p className="landing__step-desc">
                  <code>npm install && npm run dev</code> arranca el IdP en <code>localhost:8787</code>.
                  El frontend queda en <code>localhost:5173/app</code>.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">2</div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Registra tu app</h3>
                <p className="landing__step-desc">
                  Añade tu cliente en <code>FACELOGIN_OIDC_CLIENTS</code> (variable de entorno JSON o
                  archivo <code>backend/config/clients.example.json</code>). Mínimo: <code>client_id</code>,{" "}
                  <code>name</code>, <code>redirect_uris</code>.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">3</div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Descubre los endpoints</h3>
                <p className="landing__step-desc">
                  Lee <code>GET /.well-known/openid-configuration</code>. Devuelve <code>authorization_endpoint</code>,{" "}
                  <code>token_endpoint</code>, <code>jwks_uri</code>.
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">4</div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Manda al usuario a <code>/authorize</code></h3>
                <p className="landing__step-desc">
                  Con <code>response_type=code</code>, tu <code>client_id</code>, <code>redirect_uri</code>,{" "}
                  <code>state</code>, <code>code_challenge</code> (PKCE S256 obligatorio). El usuario
                  enrola/entra con su cara y vuelve a ti con <code>?code=...&state=...</code>
                </p>
              </div>
            </div>

            <div className="landing__step">
              <div className="landing__step-number" aria-hidden="true">5</div>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Canjea el código</h3>
                <p className="landing__step-desc">
                  <code>POST /token</code> con el <code>code</code>, <code>code_verifier</code> y{" "}
                  <code>client_secret</code> (si es confidencial). Recibes <code>id_token</code> (JWT RS256)
                  + <code>access_token</code>. Verifica el <code>id_token</code> con la clave pública del JWKS.
                </p>
              </div>
            </div>
          </div>

          <div className="landing__docs-link">
            <p>
              <strong>Guía completa con código:</strong>{" "}
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

      {/* Footer */}
      <footer className="landing__footer">
        <div className="landing__container">
          <p className="landing__footer-disclaimer">
            Demo / IdP en evolución. No es Face ID bancario. Threat model y límites en Docs.
          </p>
          <div className="landing__footer-actions">
            <a
              href="https://github.com/victoMR/facelogin/blob/main/docs/integracion-oidc.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Ver guía completa
            </a>
            <button onClick={onEnter}>Probar demo</button>
            <a
              href="https://github.com/victoMR/facelogin"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
          <p className="landing__footer-text">
            facelogin — Open Source (MIT) ·{" "}
            <a
              href="https://github.com/victoMR/facelogin"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </main>
  );
}
