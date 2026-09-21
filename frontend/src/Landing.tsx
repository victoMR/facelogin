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
      <div className="landing__atmosphere" aria-hidden="true">
        <span className="landing__blob landing__blob--a" />
        <span className="landing__blob landing__blob--b" />
        <span className="landing__blob landing__blob--c" />
      </div>

      <nav className="landing__nav" aria-label="Principal">
        <div className="landing__nav-shell">
          <a href="#hero" className="landing__nav-brand">
            facelogin
          </a>
          <div className="landing__nav-links">
            <a href="#integrar">Cómo integrar</a>
            <a
              href="https://github.com/victoMR/facelogin/tree/main/docs"
              target="_blank"
              rel="noopener noreferrer"
            >
              Docs
            </a>
            <button type="button" className="landing__nav-cta" onClick={onEnter}>
              Entrar con tu cara
            </button>
            <button type="button" className="landing__nav-admin" onClick={onAdmin}>
              Admin
            </button>
          </div>
        </div>
      </nav>

      <section className="landing__hero" id="hero">
        <div className="landing__hero-copy">
          <p className="landing__brand">facelogin</p>
          <p className="landing__eyebrow">Auth open source sin password</p>
          <h1 className="landing__title">La foto no viaja.</h1>
          <p className="landing__lead">
            Agrega &quot;Entrar con tu cara&quot; a tu app. Sin contraseñas que olvidar. Sin mandar
            fotos a tu servidor.
          </p>
          <div className="landing__actions">
            <a href="#integrar" className="landing__btn landing__btn--primary">
              Cómo integrar
            </a>
            <button type="button" className="landing__btn landing__btn--glass" onClick={onEnter}>
              Probar la demo
            </button>
          </div>
        </div>

        <div className="landing__stage" aria-hidden="true">
          <div className="landing__lens">
            <div className="landing__oval">
              <span className="landing__oval-ring" />
              <span className="landing__oval-shine" />
              <span className="landing__oval-core" />
            </div>
          </div>
        </div>
      </section>

      <section className="landing__section landing__section--story" id="quienes-somos">
        <div className="landing__container landing__reveal">
          <h2 className="landing__section-title">Nacimos del cansancio de las trabas</h2>
          <p className="landing__body-large">
            Estamos hartos de elegir entre seguridad de verdad y un diseño que sí funciona. Los
            passwords se olvidan; los vaults ayudan, pero la vida sería más fácil si tu cara fuera
            la llave — con privacidad obsesiva y código que cualquiera puede auditar.
          </p>
        </div>
      </section>

      <section className="landing__section" id="beneficios">
        <div className="landing__container">
          <ul className="landing__benefits">
            <li className="landing__benefit landing__reveal">
              <span className="landing__benefit-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
                  <path
                    d="M12 2.8 4.5 6v6c0 4.2 3 7.7 7.5 9.2 4.5-1.5 7.5-5 7.5-9.2V6L12 2.8Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                  <path d="M9 10h6M9 14h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              <div>
                <h3 className="landing__benefit-title">Cero password</h3>
                <p className="landing__benefit-desc">Se acabó &quot;¿cuál era mi usuario?&quot;</p>
              </div>
            </li>
            <li className="landing__benefit landing__reveal">
              <span className="landing__benefit-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
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
              </span>
              <div>
                <h3 className="landing__benefit-title">La foto no viaja</h3>
                <p className="landing__benefit-desc">
                  El navegador saca un descriptor; tu app no recibe ni guarda caras.
                </p>
              </div>
            </li>
            <li className="landing__benefit landing__reveal">
              <span className="landing__benefit-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
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
              </span>
              <div>
                <h3 className="landing__benefit-title">Enchufable</h3>
                <p className="landing__benefit-desc">OIDC + PKCE. Un botón en tu login actual.</p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <section className="landing__section landing__section--integrate" id="integrar">
        <div className="landing__container">
          <h2 className="landing__section-title landing__reveal">Cómo integrar</h2>
          <ol className="landing__steps">
            <li className="landing__step landing__reveal">
              <span className="landing__step-number" aria-hidden="true">
                1
              </span>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Corre facelogin</h3>
                <p className="landing__step-desc">
                  <code>npm install && npm run dev</code> arranca el IdP en <code>localhost:8787</code>.
                  El frontend queda en <code>localhost:5173/app</code>.
                </p>
              </div>
            </li>
            <li className="landing__step landing__reveal">
              <span className="landing__step-number" aria-hidden="true">
                2
              </span>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Registra tu app</h3>
                <p className="landing__step-desc">
                  Añade tu cliente en <code>FACELOGIN_OIDC_CLIENTS</code> (variable de entorno JSON o
                  archivo <code>backend/config/clients.example.json</code>). Mínimo:{" "}
                  <code>client_id</code>, <code>name</code>, <code>redirect_uris</code>.
                </p>
              </div>
            </li>
            <li className="landing__step landing__reveal">
              <span className="landing__step-number" aria-hidden="true">
                3
              </span>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Descubre los endpoints</h3>
                <p className="landing__step-desc">
                  Lee <code>GET /.well-known/openid-configuration</code>. Devuelve{" "}
                  <code>authorization_endpoint</code>, <code>token_endpoint</code>,{" "}
                  <code>jwks_uri</code>.
                </p>
              </div>
            </li>
            <li className="landing__step landing__reveal">
              <span className="landing__step-number" aria-hidden="true">
                4
              </span>
              <div className="landing__step-content">
                <h3 className="landing__step-title">
                  Manda al usuario a <code>/authorize</code>
                </h3>
                <p className="landing__step-desc">
                  Con <code>response_type=code</code>, tu <code>client_id</code>,{" "}
                  <code>redirect_uri</code>, <code>state</code>, <code>code_challenge</code> (PKCE
                  S256 obligatorio). El usuario enrola/entra con su cara y vuelve a ti con{" "}
                  <code>?code=...&amp;state=...</code>
                </p>
              </div>
            </li>
            <li className="landing__step landing__reveal">
              <span className="landing__step-number" aria-hidden="true">
                5
              </span>
              <div className="landing__step-content">
                <h3 className="landing__step-title">Canjea el código</h3>
                <p className="landing__step-desc">
                  <code>POST /token</code> con el <code>code</code>, <code>code_verifier</code> y{" "}
                  <code>client_secret</code> (si es confidencial). Recibes <code>id_token</code> (JWT
                  RS256) + <code>access_token</code>. Verifica el <code>id_token</code> con la clave
                  pública del JWKS.
                </p>
              </div>
            </li>
          </ol>

          <p className="landing__docs-link landing__reveal">
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
      </section>

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
              className="landing__btn landing__btn--glass landing__btn--compact"
            >
              Ver guía completa
            </a>
            <button
              type="button"
              className="landing__btn landing__btn--primary landing__btn--compact"
              onClick={onEnter}
            >
              Probar demo
            </button>
            <a
              href="https://github.com/victoMR/facelogin"
              target="_blank"
              rel="noopener noreferrer"
              className="landing__btn landing__btn--glass landing__btn--compact"
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
