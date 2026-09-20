import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Passkeys (WebAuthn). El servidor verifica una firma del autenticador,
 * no un texto que el cliente puede inventar. El captcha de voz se queda
 * como guía en el navegador; no autoriza el JWT.
 */

export type StoredPasskey = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransport[];
  addedAt: string;
};

export type WebAuthnConfig = {
  rpID: string;
  rpName: string;
  origin: string;
};

const TTL_MS = 90_000;
const tickets = new Map<string, { challenge: string; expiresAt: number; userId?: string }>();

export function webAuthnFromOrigin(origin: string): WebAuthnConfig {
  const url = new URL(origin);
  return {
    rpID: url.hostname,
    rpName: "facelogin",
    origin: origin.replace(/\/+$/, ""),
  };
}

function sweep(): void {
  const now = Date.now();
  for (const [id, item] of tickets) {
    if (item.expiresAt < now) tickets.delete(id);
  }
}

function putTicket(challenge: string, userId?: string): string {
  sweep();
  const id = randomBytes(16).toString("base64url");
  tickets.set(id, { challenge, expiresAt: Date.now() + TTL_MS, userId });
  return id;
}

function takeTicket(id: string): { challenge: string; userId?: string } | null {
  sweep();
  const item = tickets.get(id);
  if (!item || item.expiresAt < Date.now()) return null;
  tickets.delete(id);
  return item;
}

export async function registrationOptions(
  config: WebAuthnConfig,
  user: { id: string; name: string },
  exclude: StoredPasskey[],
): Promise<{ ticket: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: exclude.map((passkey) => ({
      id: passkey.id,
      transports: passkey.transports,
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred",
      authenticatorAttachment: "platform",
    },
  });
  return { ticket: putTicket(options.challenge, user.id), options };
}

export async function verifyRegistration(
  config: WebAuthnConfig,
  ticket: string,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<StoredPasskey | null> {
  const pending = takeTicket(ticket);
  if (!pending || pending.userId !== userId) return null;
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: false,
    });
    if (!result.verified || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: response.response.transports as AuthenticatorTransport[] | undefined,
      addedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function authenticationOptions(
  config: WebAuthnConfig,
): Promise<{ ticket: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: "preferred",
  });
  return { ticket: putTicket(options.challenge), options };
}

export async function verifyAuthentication(
  config: WebAuthnConfig,
  ticket: string,
  response: AuthenticationResponseJSON,
  stored: StoredPasskey,
): Promise<{ ok: boolean; counter: number }> {
  const pending = takeTicket(ticket);
  if (!pending) return { ok: false, counter: stored.counter };
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: Buffer.from(stored.publicKey, "base64url"),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
    if (!result.verified || !result.authenticationInfo) return { ok: false, counter: stored.counter };
    return { ok: true, counter: result.authenticationInfo.newCounter };
  } catch {
    return { ok: false, counter: stored.counter };
  }
}

export function resetPasskeyChallenges(): void {
  tickets.clear();
}
