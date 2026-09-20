import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { issueChallenge, validateChallengeResponse } from "./challenge.js";
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
import { readSession, signSession } from "./session.js";

const vectorSchema = z.array(z.number().finite()).length(128);

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
  })
  .refine((body) => Boolean(body.samples) !== Boolean(body.conditions), {
    message: "Manda `samples` o `conditions`, no ambos.",
  });

/**
 * `descriptor` (uno, contrato anterior) o `descriptors` (varios del mismo
 * intento). El servidor se queda con el mejor y aplica la penalización
 * multi-probe; ver `multiProbePenalty`.
 */
const identifySchema = z
  .object({
    descriptor: vectorSchema.optional(),
    descriptors: z.array(vectorSchema).min(1).max(8).optional(),
    challenge: z.string().optional(),
    challengeHmac: z.string().optional(),
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

/** Si FACELOGIN_ENROLL_TOKEN existe, el enrollo exige ese bearer; si no, modo demo abierto. */
function enrollAuthorized(req: Request): { authorized: boolean; isCanary: boolean } {
  const expected = process.env.FACELOGIN_ENROLL_TOKEN;
  if (!expected) return { authorized: true, isCanary: false };

  const token = bearerToken(req);

  if (isCanaryToken(token)) {
    return { authorized: false, isCanary: true };
  }

  return { authorized: constantTimeEquals(token, expected), isCanary: false };
}

export function createRouter(engine: FaceEngine, sessionSecret: string): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "face-only" });
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

  router.post("/enroll", (req, res) => {
    const ip = req.ip ?? "local";
    if (!rateLimit("enroll", ip, ENROLL_LIMIT.max, ENROLL_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados enrollos. Espera un momento." });
      return;
    }

    const auth = enrollAuthorized(req);
    if (auth.isCanary) {
      handleCanaryAccess(bearerToken(req), ip);
      res.status(401).json({ error: "Enrolamiento no autorizado." });
      return;
    }
    if (!auth.authorized) {
      res.status(401).json({ error: "Enrolamiento no autorizado." });
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
    try {
      const input = parsed.data.conditions ?? (parsed.data.samples as number[][]);
      const template = engine.enroll(parsed.data.displayName, input);
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
      const decision = engine.identify(probes);

      if (decision.identityId && isHoneypot(decision.identityId)) {
        handleHoneypotTrigger(decision.identityId, ip);
        const failResponse = redactFailedIdentifyResponse();
        res.status(401).json(failResponse);
        return;
      }

      if (!decision.matched || !decision.identityId || !decision.displayName) {
        const logEntry = redactMatchDecisionForLog(decision, ip);
        console.log("[identify] rechazado", JSON.stringify(logEntry));

        const failResponse = redactFailedIdentifyResponse();
        res.status(401).json(failResponse);
        return;
      }

      const token = await signSession(sessionSecret, {
        sub: decision.identityId,
        name: decision.displayName,
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
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const rawMessage = error instanceof Error ? error.message : "No se pudo identificar.";
      const message = sanitizeErrorMessage(rawMessage);
      res.status(status).json({ error: message });
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

  return router;
}
