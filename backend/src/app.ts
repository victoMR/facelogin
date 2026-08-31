/**
 * Construcción de la aplicación Express, separada del arranque.
 *
 * `index.ts` se queda con lo que solo tiene sentido en un proceso real (leer
 * `.env`, generar secretos, abrir el puerto). Aquí queda el montaje, que es lo
 * que los tests necesitan poder levantar contra un vault y unas claves de
 * usar y tirar.
 */
import cors from "cors";
import express from "express";
import type { FaceEngine } from "./engine.js";
import { createRouter } from "./routes.js";
import { createOidcAppRouter, createOidcRouter } from "./oidc/router.js";
import type { OidcProvider } from "./oidc/provider.js";

export type AppOptions = {
  engine: FaceEngine;
  sessionSecret: string;
  /** Orígenes admitidos para la interfaz propia. Los endpoints OIDC llevan su propio CORS. */
  allowedOrigins: string[];
  /** A dónde manda `GET /` a quien llega por error a la API. */
  appOrigin: string;
  /** `null` deja el IdP apagado: la app sigue funcionando igual que antes. */
  provider: OidcProvider | null;
  /**
   * Solo para despliegues que de verdad estén detrás de un proxy de confianza.
   * Por defecto NO se confía: con `trust proxy` activo y sin proxy delante,
   * cualquiera puede mandar `X-Forwarded-For` y saltarse el rate limit por IP.
   */
  trustProxy?: number | boolean;
};

export function createApp(options: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);

  if (options.provider) {
    // En la raíz, antes que nada: el emisor anunciado en el discovery es este
    // origen y los endpoints tienen que colgar exactamente de ahí.
    app.use(createOidcRouter(options.provider));
  }

  app.use(cors({ origin: options.allowedOrigins, credentials: false }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.redirect(302, options.appOrigin);
  });

  if (options.provider) {
    app.use("/api/oidc", createOidcAppRouter(options.provider, options.sessionSecret));
  }
  app.use("/api", createRouter(options.engine, options.sessionSecret));

  return app;
}
