import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

/**
 * Aparatos de confianza, al estilo SSH: el dispositivo guarda la clave
 * privada; el servidor solo la pública. El user-agent es una etiqueta, no
 * la prueba. Un hash de Chrome se falsifica; una firma ECDSA no.
 */

export type TrustedDevice = {
  id: string;
  publicKey: string;
  label: string;
  trustedAt: string;
  lastSeenAt: string;
};

export type DeviceProof = {
  id: string;
  publicKey: string;
  signature: string;
  nonce: string;
  label?: string;
};

const NONCE_TTL_MS = 60_000;
const nonces = new Map<string, { expiresAt: number; used: boolean }>();

export function publicKeyId(spkiB64: string): string {
  return createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("base64url");
}

export function issueDeviceNonce(): string {
  sweep();
  const nonce = randomBytes(32).toString("base64url");
  nonces.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS, used: false });
  return nonce;
}

export function consumeDeviceNonce(nonce: string): boolean {
  sweep();
  const entry = nonces.get(nonce);
  if (!entry || entry.used || entry.expiresAt < Date.now()) return false;
  entry.used = true;
  return true;
}

export function verifyDeviceSignature(spkiB64: string, nonce: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiB64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(nonce, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function readDevice(input: {
  id: string;
  publicKey: string;
  label?: string;
}): TrustedDevice | null {
  if (!input.publicKey || publicKeyId(input.publicKey) !== input.id) return null;
  const now = new Date().toISOString();
  return {
    id: input.id,
    publicKey: input.publicKey,
    label: (input.label ?? "Este aparato").trim().slice(0, 64) || "Este aparato",
    trustedAt: now,
    lastSeenAt: now,
  };
}

export function deviceKnown(devices: TrustedDevice[] | undefined, id: string): TrustedDevice | undefined {
  return (devices ?? []).find((device) => device.id === id);
}

function sweep(): void {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (entry.expiresAt < now) nonces.delete(nonce);
  }
}

export function resetDeviceNonces(): void {
  nonces.clear();
}
