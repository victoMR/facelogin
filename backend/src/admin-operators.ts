/**
 * Operadores del panel /admin: identidades que pueden entrar con la cara
 * después del bootstrap con FACELOGIN_ADMIN_TOKEN.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STORE_VERSION = 1 as const;

export type AdminOperator = {
  identityId: string;
  displayName: string;
  promotedAt: string;
};

type StoreFile = {
  version: typeof STORE_VERSION;
  operators: AdminOperator[];
};

function empty(): StoreFile {
  return { version: STORE_VERSION, operators: [] };
}

export class AdminOperatorsStore {
  private cache: StoreFile | null = null;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private load(): StoreFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = empty();
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      if (raw?.version !== STORE_VERSION || !Array.isArray(raw.operators)) throw new Error("formato");
      this.cache = raw;
      return this.cache;
    } catch (error) {
      throw new Error(
        `No se pudo leer ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private save(file: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    this.cache = file;
  }

  count(): number {
    return this.load().operators.length;
  }

  list(): AdminOperator[] {
    return [...this.load().operators];
  }

  isOperator(identityId: string): boolean {
    return this.load().operators.some((item) => item.identityId === identityId);
  }

  promote(identityId: string, displayName: string): AdminOperator {
    const id = identityId.trim();
    const name = displayName.trim() || "Operador";
    if (!id) {
      throw Object.assign(new Error("Falta la identidad."), { status: 400 });
    }
    const file = this.load();
    const existing = file.operators.find((item) => item.identityId === id);
    if (existing) return existing;
    const operator: AdminOperator = {
      identityId: id,
      displayName: name.slice(0, 64),
      promotedAt: new Date().toISOString(),
    };
    file.operators.push(operator);
    this.save(file);
    return operator;
  }
}
