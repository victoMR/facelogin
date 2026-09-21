import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { issueChallenge, validateChallengeResponse } from "./challenge.js";
import {
  consumeDeviceNonce,
  deviceKnown,
  issueDeviceNonce,
  verifyDeviceSignature,
} from "./devices.js";
import type { FaceEngine } from "./engine.js";
import {
  handleCanaryAccess,
  handleHoneypotTrigger,
  isCanaryToken,
  isHoneypot,
} from "./honeypot.js";
import {
  redactEnrollResponse,
  redactFailedIdentifyResponse,
  redactMatchDecisionForLog,
  sanitizeErrorMessage,
} from "./redact.js";
import { readSession, sessionIsFresh, signSession, type SessionAmr } from "./session.js";
import { issueVoiceChallenge } from "./words.js";
import type { ActivityLog } from "./activity.js";
import type { AdminOperatorsStore } from "./admin-operators.js";
import type { ManagedClientRegistry } from "./oidc/managed-clients.js";
import type { OidcProvider } from "./oidc/provider.js";
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  webAuthnFromOrigin,
  type WebAuthnConfig,
} from "./passkeys.js";

export type RouterOptions = {
  engine: FaceEngine;
  sessionSecret: string;
  webauthn?: WebAuthnConfig;
  clients?: ManagedClientRegistry | null;
  activity?: ActivityLog | null;
  operators?: AdminOperatorsStore | null;
  issuer?: string;
  /** Si hay IdP, un `oidcRequestId` vivo autoriza el enrollo sin invite (alta vía app). */
  provider?: OidcProvider | null;
};

const vectorSchema = z.array(z.number().finite()).length(128);
const shapeSchema = z.array(z.number().finite()).length(64).optional();
const deviceKeySchema = z.object({
  id: z.string().trim().min(8).max(128),
  publicKey: z.string().trim().min(80).max(400),
  label: z.string().trim().min(1).max(64).optional(),
});
const deviceProofSchema = deviceKeySchema.extend({
  signature: z.string().trim().min(16).max(400),
  nonce: z.string().trim().min(8).max(128),
});

/**
 * El tope por condición sube de 10 a 40: con augmentación sobre el frame, cada
 * gesto produce varias variantes (espejo, brillo, micro-rotación, crop).
 */
const conditionSchema = z.object({
  label: z.string().trim().min(1).max(32),
  samples: z.array(vectorSchema).min(4).max(40),
});

/**
 * Dos formas admitidas: `samples` (una sola condición, contrato anterior) o
 * `conditions` (multi-condición: con lentes / sin lentes). Exactamente una.
 */
const enrollSchema = z
  .object({
    displayName: z.string().trim().min(2).max(64),
    samples: z.array(vectorSchema).min(4).max(40).optional(),
    conditions: z.array(conditionSchema).min(1).max(4).optional(),
    shape: z.array(z.number().finite()).length(64),
    device: deviceKeySchema.optional(),
    /** Alta desde el consentimiento OIDC de una app ya registrada. */
    oidcRequestId: z.string().trim().min(16).max(128).optional(),
  })
  .refine((body) => Boolean(body.samples) !== Boolean(body.conditions), {
    message: "Manda `samples` o `conditions`, no ambos.",
  });

/**
 * `descriptor` (uno, contrato anterior) o `descriptors` (varios del mismo
 * intento). El servidor se queda con el mejor y aplica la penalización
 * multi-probe; ver `multiProbePenalty`.
 */
const passkeyAssertionSchema = z.object({
  ticket: z.string().trim().min(8).max(128),
  assertion: z
    .object({
      id: z.string().min(8),
      rawId: z.string().min(8),
      type: z.literal("public-key"),
      response: z.object({
        clientDataJSON: z.string().min(8),
        authenticatorData: z.string().min(8),
        signature: z.string().min(8),
        userHandle: z.string().optional(),
      }),
    })
    .passthrough(),
});

const identifySchema = z
  .object({
    descriptor: vectorSchema.optional(),
    descriptors: z.array(vectorSchema).min(1).max(8).optional(),
    shape: shapeSchema,
    device: deviceProofSchema.optional(),
    challenge: z.string().optional(),
    challengeHmac: z.string().optional(),
    passkey: passkeyAssertionSchema.optional(),
  })
  .refine((body) => Boolean(body.descriptor) !== Boolean(body.descriptors), {
    message: "Manda `descriptor` o `descriptors`, no ambos.",
  })
  .refine(
    (body) => Boolean(body.challenge) === Boolean(body.challengeHmac),
    {
      message: "Challenge y challengeHmac deben venir juntos.",
    },
  );

const IDENTIFY_LIMIT = { max: 8, windowMs: 60_000 };
const ENROLL_LIMIT = { max: 3, windowMs: 60_000 };
const SWEEP_INTERVAL_MS = 60_000;

/** Cubetas separadas por ruta: `scope:ip`. Se purgan las entradas vencidas. */
const attempts = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(key);
  }
}

export function rateLimit(scope: string, ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const key = `${scope}:${ip}`;
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

export function resetRateLimits(): void {
  attempts.clear();
  lastSweep = 0;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** Si FACELOGIN_ENROLL_TOKEN existe, el enrollo exige ese bearer; si no, modo demo abierto.
 *  El FACELOGIN_ADMIN_TOKEN también vale: el panel /admin registra operadores con él.
 *  Una petición OIDC pendiente (app registrada) autoriza el alta sin invite.
 */
function enrollAuthorized(
  req: Request,
  options: {
    oidcRequestId?: string;
    describeOidc?: (id: string) => { clientName: string } | null;
  } = {},
): { authorized: boolean; isCanary: boolean } {
  const enrollExpected = process.env.FACELOGIN_ENROLL_TOKEN;
  const adminExpected = process.env.FACELOGIN_ADMIN_TOKEN;
  const token = bearerToken(req);

  if (token && isCanaryToken(token)) {
    return { authorized: false, isCanary: true };
  }

  // Sin token de enrollo: abierto (demo), salvo canary.
  if (!enrollExpected) return { authorized: true, isCanary: false };

  if (token && constantTimeEquals(token, enrollExpected)) {
    return { authorized: true, isCanary: false };
  }
  if (token && adminExpected && constantTimeEquals(token, adminExpected)) {
    return { authorized: true, isCanary: false };
  }

  const oidcId = options.oidcRequestId?.trim();
  if (oidcId && options.describeOidc?.(oidcId)) {
    return { authorized: true, isCanary: false };
  }

  return { authorized: false, isCanary: false };
}

/** El borrado / panel: token de entorno O sesión facial de un operador. */
async function resolveAdminAuth(
  req: Request,
  sessionSecret: string,
  operators: AdminOperatorsStore | null,
): Promise<{ authorized: boolean; isCanary: boolean; via: "token" | "face" | null }> {
  const token = bearerToken(req);
  if (!token) return { authorized: false, isCanary: false, via: null };

  if (isCanaryToken(token)) {
    return { authorized: false, isCanary: true, via: null };
  }

  const expected = process.env.FACELOGIN_ADMIN_TOKEN;
  if (expected && constantTimeEquals(token, expected)) {
    return { authorized: true, isCanary: false, via: "token" };
  }

  if (operators) {
    try {
      const session = await readSession(sessionSecret, token);
      if (operators.isOperator(session.sub)) {
        return { authorized: true, isCanary: false, via: "face" };
      }
    } catch {
      /* no es sesión facial */
    }
  }

  return { authorized: false, isCanary: false, via: null };
}

export function createRouter(
  engineOrOptions: FaceEngine | RouterOptions,
  sessionSecretArg?: string,
  webauthnArg: WebAuthnConfig = webAuthnFromOrigin("http://localhost:5173"),
): Router {
  const options: RouterOptions =
    typeof engineOrOptions === "object" && engineOrOptions !== null && "engine" in engineOrOptions
      ? (engineOrOptions as RouterOptions)
      : {
          engine: engineOrOptions as FaceEngine,
          sessionSecret: sessionSecretArg as string,
          webauthn: webauthnArg,
        };
  const engine = options.engine;
  const sessionSecret = options.sessionSecret;
  const webauthn = options.webauthn ?? webAuthnFromOrigin("http://localhost:5173");
  const clients = options.clients ?? null;
  const activity = options.activity ?? null;
  const operators = options.operators ?? null;
  const issuer = options.issuer ?? null;
  const provider = options.provider ?? null;
  const describeOidc = (id: string) => provider?.describeRequest(id) ?? null;

  const router = Router();

  async function requireAdmin(req: Request, res: import("express").Response): Promise<boolean> {
    const auth = await resolveAdminAuth(req, sessionSecret, operators);
    if (auth.isCanary) {
      handleCanaryAccess(bearerToken(req), req.ip ?? "local");
      res.status(401).json({ error: "No autorizado." });
      return false;
    }
    if (!auth.authorized) {
      res.status(401).json({ error: "No autorizado." });
      return false;
    }
    return true;
  }

  router.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "face-only" });
  });

  router.get("/identities", (req, res) => {
    if (!rateLimit("identities", req.ip ?? "local", 30, 60_000)) {
      res.status(429).json({ error: "Demasiadas consultas. Espera un momento." });
      return;
    }
    res.json({ count: engine.countIdentities() });
  });

  router.delete("/identities", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (!rateLimit("identities-clear", req.ip ?? "local", 6, 60_000)) {
      res.status(429).json({ error: "Demasiados borrados. Espera un momento." });
      return;
    }
    const removed = engine.clearGallery();
    activity?.record({
      kind: "gallery_cleared",
      detail: `Galería vaciada (${removed} identidades)`,
    });
    res.json({ ok: true, removed });
  });

  router.get("/voice/challenge", (req, res) => {
    if (!rateLimit("voice", req.ip ?? "local", 12, 60_000)) {
      res.status(429).json({ error: "Demasiados desafíos de voz. Espera un momento." });
      return;
    }
    res.json(issueVoiceChallenge());
  });

  router.get("/webauthn/register/options", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      if (!sessionIsFresh(session)) {
        res.status(403).json({
          error: "Vuelve a identificarte para añadir una passkey.",
          code: "STEP_UP_REQUIRED",
        });
        return;
      }
      const options = await registrationOptions(
        webauthn,
        { id: session.sub, name: session.name || session.sub },
        engine.listPasskeys(session.sub),
      );
      res.json(options);
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
    }
  });

  router.post("/webauthn/register", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    const parsed = z
      .object({
        ticket: z.string().trim().min(8).max(128),
        credential: z.object({ id: z.string().min(8) }).passthrough(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Respuesta de passkey inválida." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      if (!sessionIsFresh(session)) {
        res.status(403).json({
          error: "Vuelve a identificarte para añadir una passkey.",
          code: "STEP_UP_REQUIRED",
        });
        return;
      }
      const passkey = await verifyRegistration(
        webauthn,
        parsed.data.ticket,
        session.sub,
        parsed.data.credential as never,
      );
      if (!passkey) {
        res.status(401).json({ error: "No se pudo verificar la passkey." });
        return;
      }
      engine.addPasskey(session.sub, passkey);
      res.json({ ok: true, id: passkey.id });
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
    }
  });

  router.get("/webauthn/authenticate/options", async (req, res) => {
    if (!rateLimit("webauthn", req.ip ?? "local", 20, 60_000)) {
      res.status(429).json({ error: "Demasiados desafíos. Espera un momento." });
      return;
    }
    res.json(await authenticationOptions(webauthn));
  });

  router.get("/challenge", (req, res) => {
    const ip = req.ip ?? "local";
    const result = issueChallenge(ip);

    if ("error" in result) {
      res.status(429).json({ error: result.error });
      return;
    }

    res.json({ challenge: result.nonce });
  });

  router.post("/enroll/validate", (req, res) => {
    const ip = req.ip ?? "local";
    if (!rateLimit("enroll-validate", ip, 10, 60_000)) {
      res.status(429).json({ error: "Demasiadas validaciones. Espera un momento." });
      return;
    }

    const oidcRequestId =
      typeof req.body?.oidcRequestId === "string" ? req.body.oidcRequestId : undefined;
    const auth = enrollAuthorized(req, { oidcRequestId, describeOidc });
    if (auth.isCanary) {
      handleCanaryAccess(bearerToken(req), ip);
      res.status(401).json({ error: "Ese código no es válido o ya venció." });
      return;
    }
    if (!auth.authorized) {
      res.status(401).json({ error: "Ese código no es válido o ya venció." });
      return;
    }

    res.status(204).send();
  });

  router.post("/enroll", (req, res) => {
    const ip = req.ip ?? "local";
    if (!rateLimit("enroll", ip, ENROLL_LIMIT.max, ENROLL_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados enrollos. Espera un momento." });
      return;
    }

    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Capturas inválidas. Necesitamos un nombre y 4–40 descriptores por condición.",
      });
      return;
    }

    const auth = enrollAuthorized(req, {
      oidcRequestId: parsed.data.oidcRequestId,
      describeOidc,
    });
    if (auth.isCanary) {
      handleCanaryAccess(bearerToken(req), ip);
      res.status(401).json({ error: "Enrolamiento no autorizado." });
      return;
    }
    if (!auth.authorized) {
      res.status(401).json({ error: "Enrolamiento no autorizado." });
      return;
    }
    try {
      const input = parsed.data.conditions ?? (parsed.data.samples as number[][]);
      const template = engine.enroll(
        parsed.data.displayName,
        input,
        parsed.data.shape,
        parsed.data.device,
      );
      activity?.record({
        kind: "enroll",
        detail: `Persona registrada`,
        identity: template.displayName,
      });
      const safeResponse = redactEnrollResponse(template);
      res.json(safeResponse);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const rawMessage = error instanceof Error ? error.message : "No se pudo enrolar.";
      const message = sanitizeErrorMessage(rawMessage);
      res.status(status).json({ error: message });
    }
  });

  router.post("/identify", async (req, res) => {
    const ip = req.ip ?? "local";
    if (!rateLimit("identify", ip, IDENTIFY_LIMIT.max, IDENTIFY_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados intentos. Espera un momento." });
      return;
    }

    const parsed = identifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Descriptor facial inválido." });
      return;
    }

    const requireChallenge = process.env.FACELOGIN_REQUIRE_CHALLENGE === "true";
    if (requireChallenge && !parsed.data.challenge) {
      res.status(400).json({
        error: "Se requiere challenge. Solicita uno en GET /api/challenge.",
      });
      return;
    }

    if (parsed.data.challenge && parsed.data.challengeHmac) {
      const descriptorPayload = JSON.stringify(
        parsed.data.descriptors ?? [parsed.data.descriptor],
      );
      const valid = validateChallengeResponse(
        parsed.data.challenge,
        parsed.data.challengeHmac,
        descriptorPayload,
        sessionSecret,
        ip,
      );

      if (!valid) {
        res.status(401).json({ error: "Challenge inválido o expirado." });
        return;
      }
    }

    try {
      const probes = parsed.data.descriptors ?? [parsed.data.descriptor as number[]];
      const decision = engine.identify(probes, parsed.data.shape);

      if (decision.identityId && isHoneypot(decision.identityId)) {
        handleHoneypotTrigger(decision.identityId, ip);
        const failResponse = redactFailedIdentifyResponse();
        res.status(401).json(failResponse);
        return;
      }

      if (!decision.matched || !decision.identityId || !decision.displayName) {
        const logEntry = redactMatchDecisionForLog(decision, ip);
        console.log("[identify] rechazado", JSON.stringify(logEntry));
        activity?.record({
          kind: "login_fail",
          detail: "No hubo coincidencia",
        });

        const failResponse = redactFailedIdentifyResponse();
        res.status(401).json(failResponse);
        return;
      }

      const proof = parsed.data.device;
      const known = deviceKnown(engine.listDevices(decision.identityId), proof?.id ?? "");
      const signed =
        Boolean(
          proof &&
            consumeDeviceNonce(proof.nonce) &&
            verifyDeviceSignature(known?.publicKey ?? proof.publicKey, proof.nonce, proof.signature),
        );
      const trustedDevice = Boolean(known && signed);
      let passkeyOk = false;
      const submitted = parsed.data.passkey;
      if (submitted) {
        const found = engine.findPasskey(submitted.assertion.id);
        if (found && found.identityId === decision.identityId) {
          const checked = await verifyAuthentication(
            webauthn,
            submitted.ticket,
            submitted.assertion as never,
            found.passkey,
          );
          if (checked.ok) {
            passkeyOk = true;
            engine.updatePasskeyCounter(found.identityId, found.passkey.id, checked.counter);
          }
        }
      }
      if (!trustedDevice && !passkeyOk) {
        res.status(403).json({
          error: "Confirma con la llave de este aparato o una passkey. El texto de las palabras no basta.",
          code: "PASSKEY_REQUIRED",
        });
        return;
      }
      if (trustedDevice && proof) engine.touchDevice(decision.identityId, proof.id);

      const amr: SessionAmr[] = trustedDevice ? ["face", "hwk"] : ["face", "passkey"];
      const token = await signSession(sessionSecret, {
        sub: decision.identityId,
        name: decision.displayName,
        amr,
      });

      activity?.record({
        kind: "login_ok",
        detail: trustedDevice ? "Entrada con aparato de confianza" : "Entrada con passkey",
        identity: decision.displayName,
      });

      res.json({
        token,
        identity: {
          id: decision.identityId,
          displayName: decision.displayName,
        },
        score: Number(decision.score.toFixed(4)),
        threshold: Number(decision.threshold.toFixed(4)),
        candidates: decision.candidates,
        latencyMs: decision.latencyMs,
        reason: decision.reason,
        condition: decision.condition,
        trustedDevice,
        newDevice: !trustedDevice,
        deviceLabel: known?.label ?? proof?.label ?? null,
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const rawMessage = error instanceof Error ? error.message : "No se pudo identificar.";
      const message = sanitizeErrorMessage(rawMessage);
      res.status(status).json({ error: message });
    }
  });

  router.get("/device/challenge", (req, res) => {
    if (!rateLimit("device-nonce", req.ip ?? "local", 20, 60_000)) {
      res.status(429).json({ error: "Demasiados desafíos. Espera un momento." });
      return;
    }
    res.json({ nonce: issueDeviceNonce() });
  });

  router.post("/device/trust", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    const parsed = z
      .object({
        device: deviceProofSchema,
        existing: deviceProofSchema.optional(),
        passkey: passkeyAssertionSchema.optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Clave del aparato inválida." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      const incoming = parsed.data.device;
      const owned =
        consumeDeviceNonce(incoming.nonce) &&
        verifyDeviceSignature(incoming.publicKey, incoming.nonce, incoming.signature);
      if (!owned) {
        res.status(401).json({ error: "El aparato no firmó el desafío." });
        return;
      }

      const knownDevices = engine.listDevices(session.sub);
      const knownPasskeys = engine.listPasskeys(session.sub);
      let stepped = false;
      const prior = parsed.data.existing;
      if (prior) {
        const known = deviceKnown(knownDevices, prior.id);
        stepped = Boolean(
          known &&
            consumeDeviceNonce(prior.nonce) &&
            verifyDeviceSignature(known.publicKey, prior.nonce, prior.signature),
        );
      }
      const submitted = parsed.data.passkey;
      if (!stepped && submitted) {
        const found = engine.findPasskey(submitted.assertion.id);
        if (found && found.identityId === session.sub) {
          const checked = await verifyAuthentication(
            webauthn,
            submitted.ticket,
            submitted.assertion as never,
            found.passkey,
          );
          if (checked.ok) {
            stepped = true;
            engine.updatePasskeyCounter(found.identityId, found.passkey.id, checked.counter);
          }
        }
      }
      if (!stepped) {
        res.status(403).json({
          error: "Confirma con un aparato de confianza o una passkey antes de guardar este.",
          code: "STEP_UP_REQUIRED",
        });
        return;
      }

      const device = engine.trustDevice(session.sub, incoming);
      res.json({ id: device.id, label: device.label, trusted: true });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 401;
      res.status(status).json({
        error: error instanceof Error ? sanitizeErrorMessage(error.message) : "No se pudo confiar.",
      });
    }
  });

  router.get("/devices", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      res.json({
        devices: engine.listDevices(session.sub).map((device) => ({
          id: device.id,
          label: device.label,
          trustedAt: device.trustedAt,
          lastSeenAt: device.lastSeenAt,
        })),
      });
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
    }
  });

  router.delete("/devices/:id", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      engine.revokeDevice(session.sub, String(req.params.id));
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
    }
  });

  router.get("/me", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sesión ausente." });
      return;
    }
    try {
      const session = await readSession(sessionSecret, token);
      res.json({ id: session.sub, displayName: session.name });
    } catch {
      res.status(401).json({ error: "Sesión inválida o caducada." });
    }
  });

  router.get("/admin/bootstrap", (req, res) => {
    if (!rateLimit("admin-bootstrap", req.ip ?? "local", 60, 60_000)) {
      res.status(429).json({ error: "Demasiadas consultas. Espera un momento." });
      return;
    }
    const count = operators?.count() ?? 0;
    res.json({
      bootstrapped: count > 0,
      operators: count,
      adminTokenConfigured: Boolean(process.env.FACELOGIN_ADMIN_TOKEN),
    });
  });

  router.post("/admin/operators", async (req, res) => {
    if (!operators) {
      res.status(503).json({ error: "Operadores no disponibles." });
      return;
    }
    if (!rateLimit("admin-operators", req.ip ?? "local", 20, 60_000)) {
      res.status(429).json({ error: "Demasiadas altas. Espera un momento." });
      return;
    }

    const auth = await resolveAdminAuth(req, sessionSecret, operators);
    if (auth.isCanary) {
      handleCanaryAccess(bearerToken(req), req.ip ?? "local");
      res.status(401).json({ error: "No autorizado." });
      return;
    }

    // El primer operador solo se crea con el token de entorno (bootstrap).
    if (operators.count() === 0) {
      const expected = process.env.FACELOGIN_ADMIN_TOKEN;
      const token = bearerToken(req);
      if (!expected || !token || !constantTimeEquals(token, expected)) {
        res.status(401).json({
          error: "Para el primer administrador hace falta el FACELOGIN_ADMIN_TOKEN.",
        });
        return;
      }
    } else if (!auth.authorized) {
      res.status(401).json({ error: "No autorizado." });
      return;
    }

    const parsed = z
      .object({
        identityId: z.string().trim().min(8).max(128),
        displayName: z.string().trim().min(1).max(64).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Indica la identidad a promover." });
      return;
    }

    const summaries = engine.listIdentitySummaries();
    const person = summaries.find((item) => item.id === parsed.data.identityId);
    if (!person) {
      res.status(404).json({ error: "Esa identidad no existe en la galería." });
      return;
    }

    const operator = operators.promote(person.id, parsed.data.displayName ?? person.name);
    activity?.record({
      kind: "enroll",
      detail: "Operador de admin promovido",
      identity: operator.displayName,
    });
    res.status(201).json({ operator, bootstrapped: true });
  });

  router.get("/admin/metrics", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (!rateLimit("admin-metrics", req.ip ?? "local", 30, 60_000)) {
      res.status(429).json({ error: "Demasiadas consultas. Espera un momento." });
      return;
    }

    const summary = activity?.summary() ?? {
      todayLogins: 0,
      weekLogins: 0,
      todayFails: 0,
      lastAccess: null,
    };
    const lastSeen = activity?.lastSeenByIdentity() ?? new Map<string, string>();
    const apps = clients?.listPublic() ?? [];
    const tokenEvents = (activity?.recent(200) ?? []).filter((event) => event.kind === "oidc_token");
    const loginsByClient = new Map<string, { count: number; lastUsed: string | null }>();
    for (const event of tokenEvents) {
      if (!event.clientId) continue;
      const prev = loginsByClient.get(event.clientId) ?? { count: 0, lastUsed: null };
      prev.count += 1;
      if (!prev.lastUsed) prev.lastUsed = event.at;
      loginsByClient.set(event.clientId, prev);
    }
    const operatorIds = new Set((operators?.list() ?? []).map((item) => item.identityId));
    const identities = engine.listIdentitySummaries().map((person) => ({
      id: person.id,
      name: person.name,
      enrolledAt: person.enrolledAt,
      lastSeen: lastSeen.get(person.name) ?? null,
      devices: person.devices,
      passkeys: person.passkeys,
      conditions: person.conditions,
      status: lastSeen.has(person.name) ? "Activa" : "Registrada",
      isOperator: operatorIds.has(person.id),
    }));

    res.json({
      enrolledIdentities: engine.countIdentities(),
      todayLogins: summary.todayLogins,
      weekLogins: summary.weekLogins,
      todayFails: summary.todayFails,
      oidcClients: apps.length,
      lastAccess: summary.lastAccess,
      issuer,
      identities,
      operators: operators?.list() ?? [],
      apps: apps.map((app) => {
        const stats = loginsByClient.get(app.client_id);
        return {
          client_id: app.client_id,
          name: app.name,
          redirect_uris: app.redirect_uris,
          confidential: app.confidential,
          source: app.source,
          createdAt: app.createdAt,
          lastUsed: stats?.lastUsed ?? null,
          logins: stats?.count ?? 0,
        };
      }),
      activity: activity?.recent(50) ?? [],
      adminConfigured: Boolean(process.env.FACELOGIN_ADMIN_TOKEN),
      bootstrapped: (operators?.count() ?? 0) > 0,
    });
  });

  const createClientSchema = z.object({
    name: z.string().trim().min(2).max(128),
    redirect_uris: z.array(z.string().trim().min(1)).min(1).max(8),
    confidential: z.boolean().optional(),
  });

  router.post("/admin/clients", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (!clients) {
      res.status(503).json({ error: "El registro de clientes no está disponible." });
      return;
    }
    if (!rateLimit("admin-clients-create", req.ip ?? "local", 20, 60_000)) {
      res.status(429).json({ error: "Demasiadas altas. Espera un momento." });
      return;
    }

    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Datos inválidos. Indica nombre y al menos una redirect URI https.",
      });
      return;
    }

    try {
      const created = clients.create(parsed.data);
      activity?.record({
        kind: "client_created",
        detail: `App registrada: ${created.client.name}`,
        clientId: created.client.client_id,
      });
      res.status(201).json(created);
    } catch (error) {
      const status =
        typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
      const message = error instanceof Error ? error.message : "No se pudo registrar la app.";
      res.status(status).json({ error: message });
    }
  });

  router.delete("/admin/clients/:clientId", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (!clients) {
      res.status(503).json({ error: "El registro de clientes no está disponible." });
      return;
    }
    if (!rateLimit("admin-clients-delete", req.ip ?? "local", 20, 60_000)) {
      res.status(429).json({ error: "Demasiados borrados. Espera un momento." });
      return;
    }

    const clientId = String(req.params.clientId ?? "");
    try {
      const removed = clients.revoke(clientId);
      if (!removed) {
        res.status(404).json({ error: "Cliente no encontrado." });
        return;
      }
      activity?.record({
        kind: "client_revoked",
        detail: `App revocada`,
        clientId,
      });
      res.json({ ok: true, client_id: clientId });
    } catch (error) {
      const status =
        typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
      const message = error instanceof Error ? error.message : "No se pudo revocar.";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
