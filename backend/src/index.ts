import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { ActivityLog } from "./activity.js";
import { AdminOperatorsStore } from "./admin-operators.js";
import { createApp } from "./app.js";
import { decryptVector, deriveMasterKey, randomSecret } from "./crypto.js";
import { FaceEngine, conditionsOf } from "./engine.js";
import { ManagedClientRegistry } from "./oidc/managed-clients.js";
import { generatePrivateKeyMaterial, loadKeyRing } from "./oidc/keys.js";
import { OidcProvider } from "./oidc/provider.js";
import { VaultStore } from "./store.js";

dotenv.config({ path: resolve(process.cwd(), "../.env") });
dotenv.config();

/** Reescribe las claves existentes en lugar de anexarlas: si solo falta una, la otra no se duplica. */
function mergeEnv(existing: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

type Secrets = {
  masterKey: string;
  sessionSecret: string;
  /** HMAC de cubetas LSH. Independiente de la sesión: rotarla obliga a reconstruir el índice. */
  lshHmacKey: string;
  /** Privada RS256 del IdP, DER PKCS#8 en base64. Lista separada por comas al rotar. */
  oidcPrivateKey: string;
  /** Sal del HMAC que deriva el `sub` pairwise. Rotarla re-identifica a todos. */
  oidcPairwiseSalt: string;
  /** Bearer del panel /admin y del borrado de galería. */
  adminToken: string;
};

/**
 * Genera lo que falte y lo persiste en `.env`. Las claves del IdP se tratan con
 * el mismo cuidado que la master key: se escriben en el mismo archivo, que está
 * en `.gitignore`, y nunca se imprimen.
 */
function ensureEnv(): Secrets {
  const envPath = resolve(process.cwd(), "../.env");
  const current: Record<keyof Secrets, string | undefined> = {
    masterKey: process.env.FACELOGIN_MASTER_KEY,
    sessionSecret: process.env.FACELOGIN_SESSION_SECRET,
    lshHmacKey: process.env.FACELOGIN_LSH_HMAC_KEY,
    oidcPrivateKey: process.env.FACELOGIN_OIDC_PRIVATE_KEY,
    oidcPairwiseSalt: process.env.FACELOGIN_OIDC_PAIRWISE_SALT,
    adminToken: process.env.FACELOGIN_ADMIN_TOKEN,
  };
  const envNames: Record<keyof Secrets, string> = {
    masterKey: "FACELOGIN_MASTER_KEY",
    sessionSecret: "FACELOGIN_SESSION_SECRET",
    lshHmacKey: "FACELOGIN_LSH_HMAC_KEY",
    oidcPrivateKey: "FACELOGIN_OIDC_PRIVATE_KEY",
    oidcPairwiseSalt: "FACELOGIN_OIDC_PAIRWISE_SALT",
    adminToken: "FACELOGIN_ADMIN_TOKEN",
  };
  const generators: Record<keyof Secrets, () => string> = {
    masterKey: randomSecret,
    sessionSecret: randomSecret,
    lshHmacKey: randomSecret,
    oidcPrivateKey: generatePrivateKeyMaterial,
    oidcPairwiseSalt: randomSecret,
    adminToken: randomSecret,
  };

  const missing = (Object.keys(current) as (keyof Secrets)[]).filter((key) => !current[key]);
  if (missing.length === 0) return current as Secrets;

  const created: Record<string, string> = {};
  for (const key of missing) {
    const value = generators[key]();
    current[key] = value;
    created[envNames[key]] = value;
    process.env[envNames[key]] = value;
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(envPath, mergeEnv(existing, created), { mode: 0o600 });
  console.log(`[facelogin] secretos generados y escritos en .env: ${Object.keys(created).join(", ")}`);
  if (created.FACELOGIN_ADMIN_TOKEN) {
    console.log(
      "[facelogin] FACELOGIN_ADMIN_TOKEN generado. Úsalo en /admin (está en .env; no se imprime aquí).",
    );
  }
  return current as Secrets;
}

/**
 * Si el vault tiene plantillas, la master key actual tiene que descifrarlas.
 * Sin esta comprobación, borrar `.env` con `vault.json` presente hace que cada
 * identify reviente en el auth tag de GCM y salga un 500 sin explicación.
 */
function assertMasterKeyMatchesVault(store: VaultStore, masterKey: Buffer): void {
  const [first] = store.all();
  if (!first) return;
  const [condition] = conditionsOf(first);
  if (!condition) return;
  try {
    decryptVector(condition.encryptedCentroid, masterKey);
  } catch {
    throw new Error(
      "FACELOGIN_MASTER_KEY no descifra las plantillas de backend/data/vault.json. " +
        "La clave cambió o se regeneró: restaura la clave original en .env, o borra/archiva el vault y vuelve a enrolar.",
    );
  }
}

async function bootstrap(): Promise<void> {
  const secrets = ensureEnv();
  const port = Number(process.env.FACELOGIN_PORT ?? 8787);
  const lshSeed = process.env.FACELOGIN_LSH_SEED ?? "facelogin-lsh-v1";
  const appOrigin = (process.env.FACELOGIN_APP_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");
  const issuer = (process.env.FACELOGIN_ISSUER ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const store = new VaultStore(resolve(process.cwd(), "data/vault.json"));
  const derivedKey = deriveMasterKey(secrets.masterKey);
  assertMasterKeyMatchesVault(store, derivedKey);

  if (!process.env.FACELOGIN_ENROLL_TOKEN) {
    console.warn(
      "[facelogin] FACELOGIN_ENROLL_TOKEN no está definido: /api/enroll queda ABIERTO (modo demo). " +
        "Cualquiera con acceso a la API puede dar de alta una identidad.",
    );
  }
  if (issuer.startsWith("http://") && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(issuer)) {
    console.warn(
      `[facelogin] FACELOGIN_ISSUER apunta a ${issuer} sin TLS. Los id_token y los códigos viajarían en claro.`,
    );
  }

  const engine = new FaceEngine(store, derivedKey, lshSeed, secrets.lshHmacKey);
  const clients = ManagedClientRegistry.open(
    resolve(process.cwd(), "data/oidc-clients.json"),
    process.env,
    (message) => console.warn(message),
  );
  const activity = new ActivityLog(resolve(process.cwd(), "data/admin-activity.json"));
  const operators = new AdminOperatorsStore(resolve(process.cwd(), "data/admin-operators.json"));
  const provider = new OidcProvider({
    issuer,
    appOrigin,
    keyRing: await loadKeyRing(secrets.oidcPrivateKey),
    clients,
    pairwiseSalt: secrets.oidcPairwiseSalt,
  });

  const app = createApp({
    engine,
    sessionSecret: secrets.sessionSecret,
    allowedOrigins: [appOrigin, appOrigin.replace(/^http:/, "https:")],
    appOrigin,
    provider,
    clients,
    activity,
    operators,
    issuer,
    trustProxy: process.env.FACELOGIN_TRUST_PROXY
      ? Number(process.env.FACELOGIN_TRUST_PROXY)
      : undefined,
  });

  app.listen(port, () => {
    console.log(`facelogin api en http://localhost:${port}`);
    console.log(`facelogin idp: ${issuer}/.well-known/openid-configuration`);
    console.log(
      `facelogin admin: ${appOrigin}/admin (${clients.listPublic().length} apps, ${operators.count()} operadores)`,
    );
  });
}

bootstrap().catch((error) => {
  console.error(`[facelogin] arranque abortado: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
