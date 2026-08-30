import { SignJWT, jwtVerify } from "jose";

export type SessionPayload = {
  sub: string;
  name: string;
};

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(secret));
}

export async function readSession(secret: string, token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
  return {
    sub: String(payload.sub),
    name: String(payload.name ?? ""),
  };
}
