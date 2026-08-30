import { Router } from "express";
import { z } from "zod";
import type { FaceEngine } from "./engine.js";
import { readSession, signSession } from "./session.js";

const vectorSchema = z.array(z.number().finite()).length(128);
const enrollSchema = z.object({
  displayName: z.string().trim().min(2).max(64),
  samples: z.array(vectorSchema).min(4).max(10),
});
const identifySchema = z.object({
  descriptor: vectorSchema,
});

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string, max = 8, windowMs = 60_000): boolean {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

export function createRouter(engine: FaceEngine, sessionSecret: string): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "face-only" });
  });

  router.post("/enroll", (req, res) => {
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Capturas inválidas. Necesitamos un nombre y 4–10 descriptores." });
      return;
    }
    try {
      const template = engine.enroll(parsed.data.displayName, parsed.data.samples);
      res.json({
        id: template.id,
        displayName: template.displayName,
        samples: template.encryptedSamples.length,
        threshold: Number(template.threshold.toFixed(4)),
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
    if (!rateLimit(ip)) {
      res.status(429).json({ error: "Demasiados intentos. Espera un momento." });
      return;
    }
    const parsed = identifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Descriptor facial inválido." });
      return;
    }
    try {
      const decision = engine.identify(parsed.data.descriptor);
      if (!decision.matched || !decision.identityId || !decision.displayName) {
        res.status(401).json({
          error: "No hay coincidencia facial suficiente.",
          score: Number(decision.score.toFixed(4)),
          threshold: Number(decision.threshold.toFixed(4)),
          candidates: decision.candidates,
          latencyMs: decision.latencyMs,
        });
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
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      const message = error instanceof Error ? error.message : "No se pudo identificar.";
      res.status(status).json({ error: message });
    }
  });

  router.get("/me", async (req, res) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
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
