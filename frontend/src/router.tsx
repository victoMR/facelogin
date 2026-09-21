import { useState, useEffect, type ReactNode } from "react";

export type Route = "/" | "/app" | "/admin" | "/admin/dashboard";


function getInitialRoute(): Route {
  const path = window.location.pathname as Route;
  if (path === "/" || path === "/app" || path === "/admin" || path === "/admin/dashboard") {
    return path;
  }
  return "/";
}

export function useRouter() {
  const [route, setRouteState] = useState<Route>(getInitialRoute());

  useEffect(() => {
    const handlePopState = () => {
      setRouteState(getInitialRoute());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (to: Route, replace = false) => {
    // Conserva ?oidc=… al cambiar de ruta (p. ej. / → /app en el flujo OIDC).
    const search = window.location.search;
    const keepOidc = search.includes("oidc=") && (to === "/" || to === "/app");
    const url = keepOidc && to === "/app" ? `${to}${search}` : to;
    if (replace) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
    setRouteState(to);
  };

  return { route, navigate };
}

export function Router({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Route({ path, children }: { path: Route; children: ReactNode }) {
  const { route } = useRouter();
  return route === path ? <>{children}</> : null;
}
