import { createHmac, randomBytes } from "node:crypto";
import { logSecurityEvent } from "./honeypot.js";

/**
 * Challenge-response: primera defensa contra replay de descriptores desnudos.
 *
 * Flujo:
 * 1. Cliente solicita challenge vía GET /api/challenge
 * 2. Servidor emite nonce con timestamp
 * 3. Cliente incluye challenge + HMAC(challenge + descriptor) en POST /identify
 * 4. Servidor valida que:
 *    - Challenge existe y no expiró
 *    - HMAC es válido
 *    - Challenge no fue reusado (one-time use)
 *
 * IMPORTANTE: Esto NO es attestation completa. No verifica:
 * - Que el descriptor venga de hardware real
 * - Que el cliente sea legítimo
 * - Que haya liveness en el dispositivo
 *
 * Sí previene:
 * - Replay de descriptores capturados
 * - Ataques con curl/postman sin challenge previo
 * - Reutilización de payloads interceptados
 */

export type Challenge = {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
};

const CHALLENGE_TTL_MS = 60_000; // 1 minuto
const MAX_CHALLENGES_PER_IP = 10; // Por ventana de rate limit
const CHALLENGE_RATE_WINDOW_MS = 60_000;

/**
 * Store en memoria. En producción esto debería ser Redis con TTL automático.
 * Estructura: nonce -> Challenge
 */
const challenges = new Map<string, Challenge>();

/**
 * Rate limiting para emisión de challenges por IP.
 * Estructura: ip -> { count, resetAt }
 */
const challengeRateLimits = new Map<
  string,
  { count: number; resetAt: number }
>();

/**
 * Limpieza periódica de challenges expirados para evitar memory leak.
 */
function sweepExpiredChallenges(): void {
  const now = Date.now();
  for (const [nonce, challenge] of challenges.entries()) {
    if (challenge.expiresAt < now) {
      challenges.delete(nonce);
    }
  }
}

/**
 * Rate limit para emisión de challenges.
 */
function rateLimitChallengeIssuance(ip: string): boolean {
  const now = Date.now();
  const entry = challengeRateLimits.get(ip);

  if (!entry || entry.resetAt <= now) {
    challengeRateLimits.set(ip, {
      count: 1,
      resetAt: now + CHALLENGE_RATE_WINDOW_MS,
    });
    return true;
  }

  entry.count += 1;
  return entry.count <= MAX_CHALLENGES_PER_IP;
}

/**
 * Emite un nuevo challenge.
 */
export function issueChallenge(ip: string): { nonce: string } | { error: string } {
  sweepExpiredChallenges();

  if (!rateLimitChallengeIssuance(ip)) {
    return { error: "Demasiadas solicitudes de challenge" };
  }

  const nonce = randomBytes(32).toString("base64url");
  const now = Date.now();

  const challenge: Challenge = {
    nonce,
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    used: false,
  };

  challenges.set(nonce, challenge);
  return { nonce };
}

/**
 * Valida que el challenge response es correcto.
 *
 * @param nonce - Challenge nonce emitido previamente
 * @param hmacProvided - HMAC enviado por el cliente
 * @param payload - Payload a validar (descriptor serializado)
 * @param secret - Secret del servidor para validar HMAC
 * @param ip - IP del cliente (para logging)
 * @returns true si válido, false si no
 */
export function validateChallengeResponse(
  nonce: string,
  hmacProvided: string,
  payload: string,
  secret: string,
  ip: string,
): boolean {
  const challenge = challenges.get(nonce);

  // Challenge no existe
  if (!challenge) {
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      type: "challenge_violation",
      severity: "high",
      details: {
        ip,
        reason: "Challenge not found",
      },
    });
    return false;
  }

  // Challenge expirado
  const now = Date.now();
  if (challenge.expiresAt < now) {
    challenges.delete(nonce);
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      type: "challenge_violation",
      severity: "medium",
      details: {
        ip,
        reason: "Challenge expired",
      },
    });
    return false;
  }

  // Challenge ya usado (replay attack)
  if (challenge.used) {
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      type: "challenge_violation",
      severity: "high",
      details: {
        ip,
        reason: "Challenge reuse attempt",
      },
    });
    return false;
  }

  // Validar HMAC
  const expectedHmac = createHmac("sha256", secret)
    .update(`${nonce}:${payload}`)
    .digest("base64url");

  if (hmacProvided !== expectedHmac) {
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      type: "challenge_violation",
      severity: "high",
      details: {
        ip,
        reason: "Invalid HMAC signature",
      },
    });
    return false;
  }

  // Marcar como usado
  challenge.used = true;
  return true;
}

/**
 * Helpers para testing y limpieza.
 */
export function clearChallenges(): void {
  challenges.clear();
  challengeRateLimits.clear();
}

export function getChallengeCount(): number {
  return challenges.size;
}

/**
 * Calcula el HMAC esperado para un challenge + payload.
 * Útil para que el cliente implemente la firma correctamente.
 */
export function computeChallengeHmac(
  nonce: string,
  payload: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${nonce}:${payload}`)
    .digest("base64url");
}
