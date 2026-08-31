/**
 * Registro de clientes OIDC.
 *
 * Vive en configuración (archivo JSON o variable de entorno), **nunca** en
 * `vault.json`: el vault guarda plantillas biométricas cifradas y no tiene por
 * qué compartir ciclo de vida, respaldo ni permisos con una lista de servicios.
 */
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const redirectUriSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.hash === "" && (url.protocol === "https:" || url.protocol === "http:");
    } catch {
      return false;
    }
  }, "redirect_uri debe ser una URL absoluta http(s) sin fragmento");

const clientSchema = z.object({
  client_id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  /** Allowlist EXACTA. No hay comodines ni coincidencia por prefijo. */
  redirect_uris: z.array(redirectUriSchema).min(1).max(16),
  /** Si está, el cliente es confidencial y `/token` le exige autenticarse. */
  client_secret: z.string().min(16).optional(),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["openid", "profile"]),
  /**
   * Agrupa varios `client_id` bajo el mismo `sub` pairwise a propósito (varias
   * apps del mismo equipo). Por omisión cada cliente es su propio sector, que es
   * lo que evita la correlación entre servicios distintos.
   */
  sector_identifier: z.string().trim().min(1).max(128).optional(),
  /** Escape explícito para un callback http fuera de loopback. Se avisa al arrancar. */
  allow_insecure_redirect: z.boolean().default(false),
});

const registrySchema = z.array(clientSchema);

export type OidcClient = z.infer<typeof clientSchema> & { confidential: boolean };

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Comparación en tiempo constante; longitudes distintas salen antes sin comparar. */
export function secretMatches(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type ClientRegistry = {
  get(clientId: string): OidcClient | undefined;
  all(): OidcClient[];
};

export function parseClients(raw: unknown, warn: (message: string) => void = () => {}): OidcClient[] {
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Registro de clientes OIDC inválido: ${parsed.error.issues[0]?.message ?? "formato"}`);
  }

  const seen = new Set<string>();
  return parsed.data.map((client) => {
    if (seen.has(client.client_id)) {
      throw new Error(`client_id duplicado en el registro OIDC: ${client.client_id}`);
    }
    seen.add(client.client_id);

    for (const uri of client.redirect_uris) {
      const url = new URL(uri);
      if (url.protocol === "http:" && !isLoopback(url) && !client.allow_insecure_redirect) {
        throw new Error(
          `redirect_uri sin TLS fuera de loopback en el cliente ${client.client_id}: ${uri}. ` +
            "Un código de autorización viaja en esa URL. Usa https, o marca allow_insecure_redirect si de verdad es una red cerrada.",
        );
      }
      if (url.protocol === "http:" && !isLoopback(url)) {
        warn(
          `[oidc] el cliente ${client.client_id} recibe códigos por http sin TLS (${uri}): allow_insecure_redirect está activo.`,
        );
      }
    }

    if (!client.scopes.includes("openid")) {
      throw new Error(`El cliente ${client.client_id} debe incluir el scope "openid".`);
    }
    if (!client.client_secret) {
      warn(
        `[oidc] el cliente ${client.client_id} es público (sin client_secret): su única prueba en /token es PKCE.`,
      );
    }

    return { ...client, confidential: Boolean(client.client_secret) };
  });
}

/**
 * Orden de resolución: JSON en `FACELOGIN_OIDC_CLIENTS`, luego el archivo de
 * `FACELOGIN_OIDC_CLIENTS_FILE`, luego nada (el IdP arranca sin clientes y lo
 * avisa; los endpoints OIDC siguen respondiendo, simplemente no reconocen a
 * nadie).
 */
export function loadClients(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {},
): OidcClient[] {
  const inline = env.FACELOGIN_OIDC_CLIENTS?.trim();
  if (inline) {
    let raw: unknown;
    try {
      raw = JSON.parse(inline);
    } catch (error) {
      throw new Error(`FACELOGIN_OIDC_CLIENTS no es JSON válido: ${(error as Error).message}`);
    }
    return parseClients(raw, warn);
  }

  const file = env.FACELOGIN_OIDC_CLIENTS_FILE?.trim();
  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`No se pudo leer FACELOGIN_OIDC_CLIENTS_FILE (${file}): ${(error as Error).message}`);
    }
    return parseClients(raw, warn);
  }

  warn(
    "[oidc] no hay clientes registrados (ni FACELOGIN_OIDC_CLIENTS ni FACELOGIN_OIDC_CLIENTS_FILE). " +
      "/authorize rechazará cualquier client_id. Ver docs/integracion-oidc.md.",
  );
  return [];
}

export function createRegistry(clients: OidcClient[]): ClientRegistry {
  const byId = new Map(clients.map((client) => [client.client_id, client]));
  return {
    get: (clientId: string) => byId.get(clientId),
    all: () => [...clients],
  };
}
