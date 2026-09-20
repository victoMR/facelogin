import { randomUUID } from "node:crypto";
import { encryptVector } from "./crypto.js";
import type { FaceCondition, FaceTemplate } from "./types.js";

/**
 * Honeypot: identidad falsa en el vault que NO corresponde a ningún usuario real.
 * Cualquier acceso a ella indica ataque o compromiso.
 *
 * Diseño:
 * - Se generan plantillas faciales sintéticas con vectores aleatorios normalizados.
 * - Se marcan con prefijo especial en el ID para reconocimiento interno.
 * - NO se indexan en LSH para que solo aparezcan en full scan o acceso directo.
 * - Cualquier match contra honeypot = security event.
 */

export const HONEYPOT_ID_PREFIX = "honeypot_";
export const CANARY_TOKEN_PREFIX = "canary_";

/**
 * Genera un vector facial sintético normalizado L2 (128-d).
 * Estos vectores NO representan caras reales y sirven como señuelos.
 */
function generateSyntheticVector(): number[] {
  const vec = new Array(128);
  let sumSquared = 0;
  for (let i = 0; i < 128; i++) {
    const val = Math.random() * 2 - 1;
    vec[i] = val;
    sumSquared += val * val;
  }
  const norm = Math.sqrt(sumSquared);
  return vec.map((v) => v / norm);
}

/**
 * Crea una plantilla honeypot. Se cifra como cualquier plantilla real
 * para que no sea distinguible en el vault en reposo.
 */
export function createHoneypot(displayName: string, masterKey: Buffer): FaceTemplate {
  const samples = Array.from({ length: 8 }, () => generateSyntheticVector());
  const centroid = generateSyntheticVector();

  const condition: FaceCondition = {
    label: "default",
    encryptedCentroid: encryptVector(centroid, masterKey),
    encryptedSamples: samples.map((sample) => encryptVector(sample, masterKey)),
    intraMean: 0.85,
    intraStd: 0.05,
  };

  return {
    id: `${HONEYPOT_ID_PREFIX}${randomUUID()}`,
    displayName,
    createdAt: new Date().toISOString(),
    conditions: [condition],
    lshKeys: [],
    intraMean: 0.85,
    intraStd: 0.05,
    interConditionCosine: null,
    thresholdAtEnroll: 0.75,
  };
}

/**
 * Verifica si un ID es honeypot o canary token.
 */
export function isHoneypot(id: string): boolean {
  return id.startsWith(HONEYPOT_ID_PREFIX);
}

export function isCanaryToken(token: string): boolean {
  return token.startsWith(CANARY_TOKEN_PREFIX);
}

export type SecurityEvent = {
  timestamp: string;
  type: "honeypot_match" | "canary_access" | "challenge_violation";
  severity: "critical" | "high" | "medium";
  details: {
    ip?: string;
    honeypotId?: string;
    canaryToken?: string;
    reason?: string;
  };
};

/**
 * Registra evento de seguridad. En producción esto debería ir a un sistema
 * de alertas (SIEM, PagerDuty, etc.). Por ahora se loggea estructurado.
 *
 * IMPORTANTE: NO incluir datos sensibles (descriptores, plantillas, fotos).
 */
export function logSecurityEvent(event: SecurityEvent): void {
  console.error("[SECURITY_EVENT]", JSON.stringify(event));
}

/**
 * Handler cuando un atacante accede a honeypot:
 * - Log estructurado del evento
 * - NO revelar que es honeypot en la respuesta
 * - Retornar fallo genérico idéntico a un fallo de match legítimo
 * - Opcional: delay/poison para quemar tiempo del atacante
 */
export function handleHoneypotTrigger(
  honeypotId: string,
  ip: string,
): { shouldBlock: true; response: "generic_failure" } {
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    type: "honeypot_match",
    severity: "critical",
    details: {
      ip,
      honeypotId,
      reason: "Match attempt against honeypot identity",
    },
  });

  return { shouldBlock: true, response: "generic_failure" };
}

/**
 * Handler cuando detectamos acceso a canary token (ej: token de enroll fake).
 */
export function handleCanaryAccess(
  token: string,
  ip: string,
): { shouldBlock: true; response: "generic_failure" } {
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    type: "canary_access",
    severity: "critical",
    details: {
      ip,
      canaryToken: token,
      reason: "Access attempt with canary token",
    },
  });

  return { shouldBlock: true, response: "generic_failure" };
}

/**
 * Genera token canary que parece legítimo pero marca al atacante.
 */
export function generateCanaryToken(): string {
  return `${CANARY_TOKEN_PREFIX}${randomUUID()}`;
}
