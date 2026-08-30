import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FaceTemplate, VaultFile } from "./types.js";

const emptyVault = (): VaultFile => ({
  version: 1,
  templates: [],
  buckets: {},
});

export class VaultStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  load(): VaultFile {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as VaultFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.templates)) return emptyVault();
      return parsed;
    } catch {
      return emptyVault();
    }
  }

  save(vault: VaultFile): void {
    writeFileSync(this.filePath, JSON.stringify(vault, null, 2));
  }

  upsert(template: FaceTemplate, lshKeys: string[]): FaceTemplate {
    const vault = this.load();
    const existing = vault.templates.find((item) => item.id === template.id);
    if (existing) {
      this.detach(vault, existing.id);
    }
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
    return vault.templates.filter((template) => ids.has(template.id));
  }

  all(): FaceTemplate[] {
    return this.load().templates;
  }

  private detach(vault: VaultFile, id: string): void {
    for (const [key, ids] of Object.entries(vault.buckets)) {
      vault.buckets[key] = ids.filter((item) => item !== id);
      if (vault.buckets[key].length === 0) delete vault.buckets[key];
    }
  }
}
