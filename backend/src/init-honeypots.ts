/**
 * Script para inicializar honeypots en el vault.
 *
 * Uso:
 *   npm run init:honeypots
 *
 * Esto crea 2-3 plantillas honeypot en el vault que NO se indexan en LSH.
 * Solo aparecerán en full scan o acceso directo por ID.
 *
 * Si un atacante compromete el vault y hace match contra un honeypot,
 * se triggea alerta crítica de seguridad.
 */

import { resolve } from "node:path";
import dotenv from "dotenv";
import { deriveMasterKey } from "./crypto.js";
import { createHoneypot } from "./honeypot.js";
import { VaultStore } from "./store.js";

dotenv.config({ path: resolve(process.cwd(), "../.env") });
dotenv.config();

async function main(): Promise<void> {
  const masterKeyStr = process.env.FACELOGIN_MASTER_KEY;
  if (!masterKeyStr) {
    console.error("Error: FACELOGIN_MASTER_KEY no está definido en .env");
    process.exit(1);
  }

  const store = new VaultStore(resolve(process.cwd(), "data/vault.json"));
  const masterKey = deriveMasterKey(masterKeyStr);

  const honeypotNames = [
    "Admin User",
    "System Account",
    "Root",
  ];

  let added = 0;
  for (const name of honeypotNames) {
    const honeypot = createHoneypot(name, masterKey);

    const existing = store.all().find((t) => t.id === honeypot.id);
    if (existing) {
      console.log(`[honeypot] ya existe: ${honeypot.id}`);
      continue;
    }

    store.upsert(honeypot, honeypot.lshKeys);
    console.log(
      `[honeypot] creado: ${honeypot.displayName} (${honeypot.id})`,
    );
    added++;
  }

  if (added > 0) {
    console.log(`\n✓ ${added} honeypot(s) agregados al vault.`);
    console.log(
      "  Cualquier match contra estos IDs triggeará alerta de seguridad crítica.",
    );
  } else {
    console.log("\n✓ Todos los honeypots ya estaban presentes.");
  }
}

main().catch((error) => {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
