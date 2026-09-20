/**
 * Cableado HTTP del proveedor OIDC.
 *
 * Dos routers con públicos distintos:
 *
 * - `createOidcRouter` — endpoints del estándar, montados en la raíz del emisor
 *   (`/authorize`, `/token`, `/userinfo`, `/.well-known/*`). Los consumen los
 *   servicios cliente y sus navegadores.
 * - `createOidcAppRouter` — endpoints internos (`/api/oidc/*`) que usa la propia
 *   interfaz de facelogin para enseñar quién pide el login y para canjear la
 *   sesión facial por un código. No forman parte del contrato OIDC.
 */
import { Router, type Request } from "express";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { readSession } from "../session.js";
import { rateLimit } from "../routes.js";
import type { OidcProvider } from "./provider.js";

const TOKEN_LIMIT = { max: 30, windowMs: 60_000 };
const AUTHORIZE_LIMIT = { max: 30, windowMs: 60_000 };
const APPROVE_LIMIT = { max: 15, windowMs: 60_000 };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

function errorPage(error: string, description: string): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>facelogin · error de autorización</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f4f4f5;
       font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:34rem;padding:2rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  code{background:#1c1c1f;padding:.15rem .4rem;border-radius:.3rem}
  p{color:#a1a1aa}
</style>
<main><h1>No se puede continuar</h1>
<p>${escapeHtml(description)}</p>
<p><code>${escapeHtml(error)}</code></p>
<p>La petición no se reenvía a ninguna dirección porque el cliente o su
<code>redirect_uri</code> no se pudieron verificar.</p></main>`;
}

/** Autenticación `client_secret_basic` (RFC 6749 §2.3.1). */
function basicAuth(req: Request): { clientId: string; clientSecret: string } | null {
  const header = req.header("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  // El estándar manda form-urlencode del id y del secreto antes de codificar.
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " ")),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " ")),
  };
}

function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function createOidcRouter(provider: OidcProvider): Router {
  const router = Router();

  // Los endpoints públicos del estándar tienen que ser accesibles desde el
  // navegador de cualquier cliente público (SPA con PKCE). No llevan cookies ni
  // credenciales de origen: la autorización viaja siempre en el bearer o en el
  // propio código + verifier.
  const openCors = cors({ origin: "*", credentials: false, methods: ["GET", "POST", "OPTIONS"] });

  // El preflight tiene que contestarlo el CORS abierto, no el restringido a la
  // interfaz propia: sin esto una SPA de otro origen no puede llamar a /token.
  for (const path of ["/token", "/userinfo", "/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
    router.options(path, openCors);
  }

  router.get("/.well-known/openid-configuration", openCors, (_req, res) => {
    res.json(provider.discovery());
  });

  router.get("/.well-known/jwks.json", openCors, (_req, res) => {
    res.type("application/jwk-set+json").json(provider.jwks());
  });

  router.get("/authorize", (req, res) => {
    if (!rateLimit("authorize", req.ip ?? "local", AUTHORIZE_LIMIT.max, AUTHORIZE_LIMIT.windowMs)) {
      res.status(429).type("html").send(errorPage("temporarily_unavailable", "Demasiadas peticiones de autorización. Espera un momento."));
      return;
    }
    const outcome = provider.authorize(req.query as Record<string, unknown>);
    if (outcome.kind === "fatal") {
      if (req.accepts(["html", "json"]) === "html") {
        res.status(outcome.status).type("html").send(errorPage(outcome.body.error, outcome.body.error_description));
        return;
      }
      res.status(outcome.status).json(outcome.body);
      return;
    }
    res.redirect(302, outcome.location);
  });

  router.post(
    "/token",
    openCors,
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      // Un código robado solo sirve una vez y dura 60 s; el rate limit acota
      // además el intento de adivinar `code_verifier` a fuerza bruta.
      if (!rateLimit("token", req.ip ?? "local", TOKEN_LIMIT.max, TOKEN_LIMIT.windowMs)) {
        res.status(429).json({ error: "slow_down", error_description: "Demasiadas peticiones a /token." });
        return;
      }
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      const result = await provider.token((req.body ?? {}) as Record<string, unknown>, basicAuth(req));
      if (!result.ok) {
        if (result.status === 401) res.set("WWW-Authenticate", 'Basic realm="facelogin"');
        res.status(result.status).json(result.body);
        return;
      }
      res.json(result.response);
    },
  );

  const userinfo: express.RequestHandler = async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = bearer(req);
    if (!token) {
      res.set("WWW-Authenticate", 'Bearer realm="facelogin"');
      res.status(401).json({ error: "invalid_token", error_description: "Falta el access token." });
      return;
    }
    const result = await provider.userinfo(token);
    if (!result.ok) {
      res.set("WWW-Authenticate", `Bearer error="${result.body.error}"`);
      res.status(result.status).json(result.body);
      return;
    }
    res.json(result.claims);
  };

  router.get("/userinfo", openCors, userinfo);
  router.post("/userinfo", openCors, userinfo);

  return router;
}

const approveSchema = z.object({ requestId: z.string().min(1).max(256) });

export function createOidcAppRouter(provider: OidcProvider, sessionSecret: string): Router {
  const router = Router();

  /** Qué servicio está pidiendo el login, para enseñarlo antes de encender la cámara. */
  router.get("/request/:id", (req, res) => {
    const described = provider.describeRequest(req.params.id);
    if (!described) {
      res.status(404).json({ error: "La petición de autorización expiró o no existe." });
      return;
    }
    res.json(described);
  });

  /**
   * Canjea una sesión facial recién abierta por un código de autorización.
   * El descriptor no aparece por aquí: llegó a `/api/identify`, se quedó ahí, y
   * lo único que cruza es el JWT de sesión que ese endpoint emitió.
   */
  router.post("/approve", async (req, res) => {
    if (!rateLimit("oidc-approve", req.ip ?? "local", APPROVE_LIMIT.max, APPROVE_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados intentos. Espera un momento." });
      return;
    }
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Petición inválida." });
      return;
    }
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    let session: { sub: string; name: string; authTime: number; amr?: string[] };
    try {
      session = await readSession(sessionSecret, token);
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
      return;
    }

    const result = provider.approve(parsed.data.requestId, {
      identityId: session.sub,
      displayName: session.name,
      authTime: session.authTime,
      amr: session.amr,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ redirect: result.location });
  });

  /**
   * Cancelación. No exige sesión: conocer el identificador de la petición ya es
   * la prueba de que se está cancelando la propia, y lo único que se consigue es
   * devolver `access_denied` al cliente.
   */
  router.post("/deny", (req, res) => {
    if (!rateLimit("oidc-approve", req.ip ?? "local", APPROVE_LIMIT.max, APPROVE_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados intentos. Espera un momento." });
      return;
    }
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Petición inválida." });
      return;
    }
    const result = provider.deny(parsed.data.requestId);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ redirect: result.location });
  });

  return router;
}
