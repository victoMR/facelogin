import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_ISS = "facelogin";
export const SESSION_AUD = "facelogin-app";

export type SessionPayload = {
  sub: string;
  name: string;
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

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISS)
    .setAudience(SESSION_AUD)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(secret));
}

export async function readSession(secret: string, token: string): Promise<Session> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: SESSION_ISS,
    audience: SESSION_AUD,
  });
  return {
    sub: String(payload.sub),
    name: String(payload.name ?? ""),
    authTime: typeof payload.iat === "number" ? payload.iat : 0,
    jti: String(payload.jti ?? ""),
  };
}
