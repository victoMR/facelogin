import { useState, useEffect, type ReactNode } from "react";

export type Route = "/" | "/app" | "/admin" | "/admin/dashboard";

const ROUTE_KEY = "facelogin.route";

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
    if (replace) {
      window.history.replaceState(null, "", to);
    } else {
      window.history.pushState(null, "", to);
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
