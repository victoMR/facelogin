import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { FaceEngine } from "./engine.js";
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
  })
  .refine((body) => Boolean(body.descriptor) !== Boolean(body.descriptors), {
    message: "Manda `descriptor` o `descriptors`, no ambos.",
  });

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
function enrollAuthorized(req: Request): boolean {
  const expected = process.env.FACELOGIN_ENROLL_TOKEN;
  if (!expected) return true;
  return constantTimeEquals(bearerToken(req), expected);
}

export function createRouter(engine: FaceEngine, sessionSecret: string): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "face-only" });
  });

  router.post("/enroll", (req, res) => {
    const ip = req.ip ?? "local";
    if (!rateLimit("enroll", ip, ENROLL_LIMIT.max, ENROLL_LIMIT.windowMs)) {
      res.status(429).json({ error: "Demasiados enrollos. Espera un momento." });
      return;
    }
    if (!enrollAuthorized(req)) {
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
      res.json({
        id: template.id,
        displayName: template.displayName,
        samples: template.conditions.reduce((sum, c) => sum + c.encryptedSamples.length, 0),
        conditions: template.conditions.map((condition) => ({
          label: condition.label,
          samples: condition.encryptedSamples.length,
          intraMean: Number(condition.intraMean.toFixed(4)),
          intraStd: Number(condition.intraStd.toFixed(4)),
        })),
        interConditionCosine:
          template.interConditionCosine === null
            ? null
            : Number(template.interConditionCosine.toFixed(4)),
        // Informativo: el umbral real se recalcula en cada identify con la galería vigente.
        thresholdAtEnroll: Number(template.thresholdAtEnroll.toFixed(4)),
        intraMean: Number(template.intraMean.toFixed(4)),
        intraStd: Number(template.intraStd.toFixed(4)),
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const message = error instanceof Error ? error.message : "No se pudo enrolar.";
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
    try {
      const probes = parsed.data.descriptors ?? [parsed.data.descriptor as number[]];
      const decision = engine.identify(probes);
      if (!decision.matched || !decision.identityId || !decision.displayName) {
        // El body es opaco a propósito: devolver score/threshold convierte este
        // endpoint en un oráculo con el que se puede escalar hasta pasar el umbral.
        console.log(
          `[identify] rechazado ip=${ip} score=${decision.score.toFixed(4)} ` +
            `threshold=${decision.threshold.toFixed(4)} candidates=${decision.candidates} ` +
            `latencyMs=${decision.latencyMs} reason=${decision.reason}`,
        );
        res.status(401).json({ error: "No hay coincidencia facial suficiente." });
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
      const message = error instanceof Error ? error.message : "No se pudo identificar.";
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
