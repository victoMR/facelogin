import cors from "cors";
import express from "express";
import type { ActivityLog } from "./activity.js";
import type { AdminOperatorsStore } from "./admin-operators.js";
import type { FaceEngine } from "./engine.js";
import { webAuthnFromOrigin } from "./passkeys.js";
import { createRouter } from "./routes.js";
import type { ManagedClientRegistry } from "./oidc/managed-clients.js";
import { createOidcAppRouter, createOidcRouter } from "./oidc/router.js";
import type { OidcProvider } from "./oidc/provider.js";

export type AppOptions = {
  engine: FaceEngine;
  sessionSecret: string;
  allowedOrigins: string[];
  appOrigin: string;
  provider: OidcProvider | null;
  clients?: ManagedClientRegistry | null;
  activity?: ActivityLog | null;
  operators?: AdminOperatorsStore | null;
  issuer?: string;
  trustProxy?: number | boolean;
};

export function createApp(options: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);

  if (options.provider) {
    app.use(createOidcRouter(options.provider, options.activity ?? null));
  }

  app.use(cors({ origin: options.allowedOrigins, credentials: false }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.redirect(302, options.appOrigin);
  });

  if (options.provider) {
    app.use("/api/oidc", createOidcAppRouter(options.provider, options.sessionSecret));
  }
  app.use(
    "/api",
    createRouter({
      engine: options.engine,
      sessionSecret: options.sessionSecret,
      webauthn: webAuthnFromOrigin(options.appOrigin),
      clients: options.clients ?? null,
      activity: options.activity ?? null,
      operators: options.operators ?? null,
      issuer: options.issuer ?? options.provider?.issuer,
      provider: options.provider,
    }),
  );

  return app;
}
