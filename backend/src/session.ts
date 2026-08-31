import { SignJWT, jwtVerify } from "jose";

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
};

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(secret));
}

export async function readSession(secret: string, token: string): Promise<Session> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
  });
  return {
    sub: String(payload.sub),
    name: String(payload.name ?? ""),
    authTime: typeof payload.iat === "number" ? payload.iat : 0,
  };
}
