/**
 * Par de claves RS256 del proveedor OIDC.
 *
 * La sesión propia de la app firma con HS256 y un secreto simétrico, y eso está
 * bien mientras el único que verifica es este mismo servidor. En cuanto hay
 * clientes externos, HS256 obligaría a repartir el secreto de firma entre todos
 * los servicios que quieran validar un token — y quien puede *verificar* con un
 * secreto compartido también puede *emitir*. Con RS256 el cliente solo necesita
 * la clave pública publicada en el JWKS.
 *
 * La privada se guarda como DER PKCS#8 en base64 (una sola línea, cabe en `.env`
 * junto a la master key y con el mismo cuidado: fuera de git).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, type JWK } from "jose";

export type SigningKey = {
  /** Thumbprint RFC 7638 de la clave pública: estable por clave, cambia al rotar. */
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: JWK;
};

export type KeyRing = {
  /** Con la que se firma hoy. */
  active: SigningKey;
  /**
   * Todas las publicadas, incluida la activa. Las demás son claves retiradas que
   * siguen en el JWKS para que los tokens que aún viven se puedan verificar.
   */
  published: SigningKey[];
};

/** Material nuevo en base64 (DER PKCS#8), listo para escribir en `.env`. */
export function generatePrivateKeyMaterial(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}

async function toSigningKey(base64: string): Promise<SigningKey> {
  const privateKey = createPrivateKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  // exportJWK sobre la clave PÚBLICA: nunca sobre la privada. Así el JWKS no
  // puede filtrar `d`/`p`/`q` ni por accidente.
  const publicKey = createPublicKey(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}

/**
 * `material` es una lista separada por comas. La primera clave firma; el resto
 * solo se publican. Rotar es: generar una nueva, ponerla delante, y dejar la
 * vieja detrás hasta que caduque el último token que firmó.
 */
export async function loadKeyRing(material: string): Promise<KeyRing> {
  const entries = material
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("FACELOGIN_OIDC_PRIVATE_KEY está vacío.");
  }
  const published = await Promise.all(entries.map(toSigningKey));
  return { active: published[0], published };
}

/** Documento JWKS: solo material público. */
export function jwksOf(ring: KeyRing): { keys: JWK[] } {
  return { keys: ring.published.map((key) => key.publicJwk) };
}
