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
 */

export function App() {
  const { route, navigate } = useRouter();

  // Rutas
  if (route === "/") {
    return <Landing onEnter={() => navigate("/app")} />;
  }

  if (route === "/app") {
    return <FaceApp onExit={() => navigate("/")} />;
  }

  if (route === "/admin" || route === "/admin/dashboard") {
    return <Admin onExit={() => navigate("/")} />;
  }

  // Fallback
  return <Landing onEnter={() => navigate("/app")} />;
}
