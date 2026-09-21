/**
 * Registro OIDC mutable: clientes del env (fijos) + clientes creados desde
 * el panel admin (archivo `data/oidc-clients.json`).
 *
 * El vault de rostros no se toca: ciclo de vida y permisos distintos.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { randomSecret } from "../crypto.js";
import { parseClients, type ClientRegistry, type OidcClient } from "./clients.js";

const STORE_VERSION = 1 as const;

type DynamicRecord = {
  client_id: string;
  name: string;
  redirect_uris: string[];
  client_secret?: string;
  scopes: string[];
  createdAt: string;
  allow_insecure_redirect?: boolean;
};

type StoreFile = {
  version: typeof STORE_VERSION;
  clients: DynamicRecord[];
};

export type PublicOidcClient = {
  client_id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  confidential: boolean;
  source: "env" | "admin";
  createdAt: string | null;
};

export type CreateClientInput = {
  name: string;
  redirect_uris: string[];
  /** Por defecto true: apps con backend (Tetris, etc.). */
  confidential?: boolean;
};

export type CreateClientResult = {
  client: PublicOidcClient;
  /** Solo se devuelve en la creación. Después no se puede leer. */
  client_secret: string | null;
};

function emptyStore(): StoreFile {
  return { version: STORE_VERSION, clients: [] };
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "app";
}

function toOidc(record: DynamicRecord): OidcClient {
  return {
    client_id: record.client_id,
    name: record.name,
    redirect_uris: record.redirect_uris,
    client_secret: record.client_secret,
    scopes: record.scopes,
    allow_insecure_redirect: record.allow_insecure_redirect ?? false,
    confidential: Boolean(record.client_secret),
  };
}

function publicView(client: OidcClient, source: "env" | "admin", createdAt: string | null): PublicOidcClient {
  return {
    client_id: client.client_id,
    name: client.name,
    redirect_uris: [...client.redirect_uris],
    scopes: [...client.scopes],
    confidential: client.confidential,
    source,
    createdAt,
  };
}

export class ManagedClientRegistry implements ClientRegistry {
  private readonly staticClients: OidcClient[];
  private dynamic = new Map<string, DynamicRecord>();
  private readonly createdAtById = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    staticClients: OidcClient[],
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.staticClients = staticClients;
    this.reloadDynamic();
  }

  static open(filePath: string, env: NodeJS.ProcessEnv, warn: (m: string) => void = () => {}): ManagedClientRegistry {
    const raw = loadEnvClientsRaw(env);
    const staticClients = parseClients(raw ?? [], warn);
    const registry = new ManagedClientRegistry(filePath, staticClients);
    if (staticClients.length === 0 && registry.listPublic().length === 0) {
      warn(
        "[oidc] no hay clientes registrados. Crea uno en /admin o define FACELOGIN_OIDC_CLIENTS. " +
          "Ver docs/integracion-oidc.md.",
      );
    }
    return registry;
  }

  private reloadDynamic(): void {
    this.dynamic.clear();
    this.createdAtById.clear();
    const file = this.readFile();
    for (const record of file.clients) {
      // Revalidar con el mismo esquema que el env.
      const [parsed] = parseClients([record]);
      this.dynamic.set(parsed.client_id, {
        ...record,
        client_id: parsed.client_id,
        name: parsed.name,
        redirect_uris: parsed.redirect_uris,
        client_secret: parsed.client_secret,
        scopes: parsed.scopes,
        createdAt: record.createdAt || new Date().toISOString(),
      });
      this.createdAtById.set(parsed.client_id, record.createdAt || new Date().toISOString());
    }
  }

  private readFile(): StoreFile {
    if (!existsSync(this.filePath)) return emptyStore();
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      if (raw?.version !== STORE_VERSION || !Array.isArray(raw.clients)) {
        throw new Error("formato");
      }
      return raw;
    } catch (error) {
      throw new Error(
        `No se pudo leer ${this.filePath}: ${error instanceof Error ? error.message : String(error)}. ` +
          "Restaura el respaldo o mueve el archivo; no se sobrescribe a ciegas.",
      );
    }
  }

  private writeFile(file: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  private merged(): OidcClient[] {
    const byId = new Map<string, OidcClient>();
    for (const record of this.dynamic.values()) byId.set(record.client_id, toOidc(record));
    // El env gana si hay colisión de client_id.
    for (const client of this.staticClients) byId.set(client.client_id, client);
    return [...byId.values()];
  }

  get(clientId: string): OidcClient | undefined {
    const fromEnv = this.staticClients.find((client) => client.client_id === clientId);
    if (fromEnv) return fromEnv;
    const record = this.dynamic.get(clientId);
    return record ? toOidc(record) : undefined;
  }

  all(): OidcClient[] {
    return this.merged();
  }

  listPublic(): PublicOidcClient[] {
    const out: PublicOidcClient[] = [];
    for (const client of this.staticClients) {
      out.push(publicView(client, "env", null));
    }
    for (const record of this.dynamic.values()) {
      out.push(publicView(toOidc(record), "admin", record.createdAt));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  create(input: CreateClientInput): CreateClientResult {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 128) {
      throw Object.assign(new Error("El nombre debe tener entre 2 y 128 caracteres."), { status: 400 });
    }
    if (!input.redirect_uris?.length) {
      throw Object.assign(new Error("Indica al menos una redirect URI."), { status: 400 });
    }

    const confidential = input.confidential !== false;
    const client_secret = confidential ? randomSecret() : undefined;
    let client_id = `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    while (this.get(client_id)) {
      client_id = `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    }

    const createdAt = new Date().toISOString();
    const draft: DynamicRecord = {
      client_id,
      name,
      redirect_uris: input.redirect_uris.map((uri) => uri.trim()),
      client_secret,
      scopes: ["openid", "profile"],
      createdAt,
    };

    // Validar antes de persistir (TLS, openid, etc.).
    const [parsed] = parseClients([draft]);
    const record: DynamicRecord = {
      ...draft,
      redirect_uris: parsed.redirect_uris,
      scopes: parsed.scopes,
      client_secret: parsed.client_secret,
    };

    const file = this.readFile();
    file.clients.push(record);
    this.writeFile(file);
    this.dynamic.set(record.client_id, record);
    this.createdAtById.set(record.client_id, createdAt);

    return {
      client: publicView(toOidc(record), "admin", createdAt),
      client_secret: client_secret ?? null,
    };
  }

  /** Solo se pueden borrar clientes creados desde el admin, no los del env. */
  revoke(clientId: string): boolean {
    if (!this.dynamic.has(clientId)) {
      if (this.staticClients.some((c) => c.client_id === clientId)) {
        throw Object.assign(new Error("Ese cliente viene del entorno y no se puede borrar aquí."), {
          status: 400,
        });
      }
      return false;
    }
    const file = this.readFile();
    file.clients = file.clients.filter((item) => item.client_id !== clientId);
    this.writeFile(file);
    this.dynamic.delete(clientId);
    this.createdAtById.delete(clientId);
    return true;
  }
}

function loadEnvClientsRaw(env: NodeJS.ProcessEnv): unknown | null {
  const inline = env.FACELOGIN_OIDC_CLIENTS?.trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      throw new Error(`FACELOGIN_OIDC_CLIENTS no es JSON válido: ${(error as Error).message}`);
    }
  }
  const file = env.FACELOGIN_OIDC_CLIENTS_FILE?.trim();
  if (file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`No se pudo leer FACELOGIN_OIDC_CLIENTS_FILE (${file}): ${(error as Error).message}`);
    }
  }
  return null;
}
