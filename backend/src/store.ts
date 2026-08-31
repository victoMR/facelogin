import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FaceTemplate, VaultFile } from "./types.js";

const emptyVault = (): VaultFile => ({
  version: 1,
  templates: [],
  buckets: {},
});

/** El vault existe pero no se puede interpretar. Nunca se degrada a vault vacío. */
export class VaultCorruptError extends Error {
  constructor(filePath: string, detail: string) {
    super(
      `El vault ${filePath} existe pero no es legible (${detail}). ` +
        "No se arranca ni se escribe para no borrar identidades. Restaura el respaldo o mueve el archivo a mano.",
    );
    this.name = "VaultCorruptError";
  }
}

export class VaultStore {
  private cache: VaultFile | null = null;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  load(): VaultFile {
    if (this.cache) return this.cache;
    this.cache = this.readFromDisk();
    return this.cache;
  }

  save(vault: VaultFile): void {
    const tmpPath = `${this.filePath}.tmp`;
    const serialized = JSON.stringify(vault, null, 2);
    try {
      writeFileSync(tmpPath, serialized);
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
    this.cache = vault;
  }

  upsert(template: FaceTemplate, lshKeys: string[]): FaceTemplate {
    const vault = this.load();
    this.detach(vault, template.id);
    vault.templates = vault.templates.filter((item) => item.id !== template.id);
    vault.templates.push(template);
    for (const key of lshKeys) {
      const bucket = vault.buckets[key] ?? [];
      if (!bucket.includes(template.id)) bucket.push(template.id);
      vault.buckets[key] = bucket;
    }
    this.save(vault);
    return template;
  }

  candidates(lshKeys: string[]): FaceTemplate[] {
    const vault = this.load();
    const ids = new Set<string>();
    for (const key of lshKeys) {
      for (const id of vault.buckets[key] ?? []) ids.add(id);
    }
    if (ids.size === 0) return [];
    return vault.templates.filter((template) => ids.has(template.id));
  }

  all(): FaceTemplate[] {
    return this.load().templates;
  }

  private readFromDisk(): VaultFile {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
      throw new VaultCorruptError(this.filePath, (error as Error).message);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new VaultCorruptError(this.filePath, `JSON inválido: ${(error as Error).message}`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new VaultCorruptError(this.filePath, "la raíz no es un objeto");
    }
    const vault = parsed as Partial<VaultFile>;
    if (vault.version !== 1) {
      throw new VaultCorruptError(this.filePath, `versión desconocida: ${String(vault.version)}`);
    }
    if (!Array.isArray(vault.templates)) {
      throw new VaultCorruptError(this.filePath, "falta el arreglo templates");
    }
    if (typeof vault.buckets !== "object" || vault.buckets === null || Array.isArray(vault.buckets)) {
      throw new VaultCorruptError(this.filePath, "falta el mapa buckets");
    }
    return { version: 1, templates: vault.templates, buckets: vault.buckets };
  }

  private detach(vault: VaultFile, id: string): void {
    for (const [key, ids] of Object.entries(vault.buckets)) {
      const remaining = ids.filter((item) => item !== id);
      if (remaining.length === 0) delete vault.buckets[key];
      else vault.buckets[key] = remaining;
    }
  }
}
