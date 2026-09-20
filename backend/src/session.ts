import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_ISS = "facelogin";
export const SESSION_AUD = "facelogin-app";

export type SessionAmr = "face" | "hwk" | "passkey";

export type SessionPayload = {
  sub: string;
  name: string;
  amr?: SessionAmr[];
};

export type Session = SessionPayload & {
  /**
   * Instante (epoch en segundos) en el que esta sesión se abrió con la cara. Es
   * el `auth_time` que acaba en el `id_token`: el cliente OIDC tiene derecho a
   * saber si la persona se acaba de identificar o si arrastra una sesión de
   * hace horas.
   */
  authTime: number;
  jti: string;
};

export const STEP_UP_MAX_AGE_SEC = 5 * 60;

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const amr = payload.amr?.length ? payload.amr : (["face"] as SessionAmr[]);
  return new SignJWT({ ...payload, amr })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISS)
    .setAudience(SESSION_AUD)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(secret));
}

export function sessionIsFresh(session: Session, now = Math.floor(Date.now() / 1000)): boolean {
  return now - session.authTime <= STEP_UP_MAX_AGE_SEC;
}

export async function readSession(secret: string, token: string): Promise<Session> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: SESSION_ISS,
    audience: SESSION_AUD,
  });
  const amr = Array.isArray(payload.amr)
    ? payload.amr.filter((item): item is SessionAmr => item === "face" || item === "hwk" || item === "passkey")
    : (["face"] as SessionAmr[]);
  return {
    sub: String(payload.sub),
    name: String(payload.name ?? ""),
    amr: amr.length ? amr : ["face"],
    authTime: typeof payload.iat === "number" ? payload.iat : 0,
    jti: String(payload.jti ?? ""),
  };
}
