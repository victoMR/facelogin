/**
 * Redacción de datos sensibles en respuestas API y logs.
 *
 * Nunca debe exponerse:
 * - Fotos/frames (ya garantizado por diseño: no se suben)
 * - Descriptores faciales en plaintext
 * - Plantillas cifradas completas
 * - IVs, tags, data de EncryptedBlob
 * - Scores/thresholds en respuestas de fallo (oráculo)
 * - Master keys, secrets
 */

import type { MatchDecision } from "./types.js";

/**
 * Redacta una respuesta de identify fallido para que no revele información
 * que pueda usarse como oráculo.
 *
 * En éxito: el cliente necesita score/threshold para debugging.
 * En fallo: NO revelar estos valores - el atacante puede ajustar descriptores.
 */
export function redactFailedIdentifyResponse(): {
  error: string;
} {
  return {
    error: "No hay coincidencia facial suficiente.",
  };
}

/**
 * Redacta MatchDecision para logs del servidor.
 * Mantiene métricas pero nunca incluye vectores/descriptores.
 */
export function redactMatchDecisionForLog(
  decision: MatchDecision,
  ip: string,
): {
  timestamp: string;
  ip: string;
  matched: boolean;
  identityId: string | null;
  score: number;
  threshold: number;
  candidates: number;
  latencyMs: number;
  reason: string;
  condition: string | null;
} {
  return {
    timestamp: new Date().toISOString(),
    ip,
    matched: decision.matched,
    identityId: decision.identityId,
    score: decision.score,
    threshold: decision.threshold,
    candidates: decision.candidates,
    latencyMs: decision.latencyMs,
    reason: decision.reason,
    condition: decision.condition,
  };
}

/**
 * Valida que un error message no contenga datos sensibles.
 * Si detecta patrones sospechosos, los reemplaza.
 */
export function sanitizeErrorMessage(message: string): string {
  // Evitar que descriptores (arrays de números) se filtren en errores
  if (/\[[\d\s,.-]+\]/.test(message)) {
    return "Error de procesamiento interno.";
  }

  // Evitar que keys/secrets/tokens largos (credenciales reales) se filtren
  // Solo redacta si hay una cadena larga (>= 20 chars) que parece credencial
  const hasLongCredential = /([a-zA-Z0-9+/=_-]{20,})/.test(message);
  if (hasLongCredential && /(key|secret|token|password|credential)/i.test(message)) {
    return message.replace(
      /([a-zA-Z0-9+/=_-]{20,})/g,
      "[REDACTED]",
    );
  }

  return message;
}

/**
 * Redacta respuesta de enroll para que no exponga plantillas completas.
 * Solo devuelve metadatos seguros.
 */
export function redactEnrollResponse(template: {
  id: string;
  displayName: string;
  conditions: Array<{
    label: string;
    encryptedSamples: unknown[];
    intraMean: number;
    intraStd: number;
  }>;
  interConditionCosine: number | null;
  thresholdAtEnroll: number;
  intraMean: number;
  intraStd: number;
}): {
  id: string;
  displayName: string;
  samples: number;
  conditions: Array<{
    label: string;
    samples: number;
    intraMean: number;
    intraStd: number;
  }>;
  interConditionCosine: number | null;
  thresholdAtEnroll: number;
  intraMean: number;
  intraStd: number;
} {
  return {
    id: template.id,
    displayName: template.displayName,
    samples: template.conditions.reduce(
      (sum, c) => sum + c.encryptedSamples.length,
      0,
    ),
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
    thresholdAtEnroll: Number(template.thresholdAtEnroll.toFixed(4)),
    intraMean: Number(template.intraMean.toFixed(4)),
    intraStd: Number(template.intraStd.toFixed(4)),
  };
}

/**
 * Verifica que un objeto no contenga claves sensibles antes de serializarlo.
 */
export function hasSensitiveKeys(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;

  const sensitiveKeys = [
    "encryptedCentroid",
    "encryptedSamples",
    "encryptedShape",
    "masterKey",
    "secret",
    "password",
    "token",
    "iv",
    "data",
    "tag",
    "descriptor",
    "descriptors",
    "vector",
    "publicKey",
  ];

  const keys = Object.keys(obj);
  return keys.some((key) => sensitiveKeys.includes(key));
}
