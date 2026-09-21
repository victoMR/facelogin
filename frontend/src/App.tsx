import { useEffect } from "react";
import { useRouter } from "./router";
import { Landing } from "./Landing";
import { FaceApp } from "./FaceApp";
import { Admin } from "./Admin";

/**
 * App principal con routing básico
 *
 * Rutas:
 * - / : Landing page (marketing + docs integración)
 * - /app : Face enrollment/login (actual UX)
 * - /admin : Admin login
 * - /admin/dashboard : Admin metrics
 * - /?oidc=… o /app?oidc=… : consentimiento OIDC → cara → callback de la app
 */

export function App() {
  const { route, navigate } = useRouter();
  const oidcRequestId = new URLSearchParams(window.location.search).get("oidc");

  // Normaliza URLs antiguas `/?oidc=` a `/app?oidc=` sin perder el id.
  useEffect(() => {
    if (!oidcRequestId || window.location.pathname !== "/") return;
    window.history.replaceState(
      null,
      "",
      `/app?oidc=${encodeURIComponent(oidcRequestId)}`,
    );
    navigate("/app", true);
  }, [oidcRequestId, navigate]);

  // Petición OIDC: siempre FaceApp (consent → cara → callback), nunca el landing.
  if (oidcRequestId && (route === "/" || route === "/app")) {
    return <FaceApp onExit={() => navigate("/")} />;
  }

  if (route === "/") {
    return <Landing onEnter={() => navigate("/app")} onAdmin={() => navigate("/admin")} />;
  }

  if (route === "/app") {
    return <FaceApp onExit={() => navigate("/")} />;
  }

  if (route === "/admin" || route === "/admin/dashboard") {
    return <Admin onExit={() => navigate("/")} />;
  }

  return <Landing onEnter={() => navigate("/app")} onAdmin={() => navigate("/admin")} />;
}
