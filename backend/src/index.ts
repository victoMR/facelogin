import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { deriveMasterKey, randomSecret } from "./crypto.js";
import { FaceEngine } from "./engine.js";
import { createRouter } from "./routes.js";
import { VaultStore } from "./store.js";

dotenv.config({ path: resolve(process.cwd(), "../.env") });
dotenv.config();

function ensureEnv(): { masterKey: string; sessionSecret: string } {
  const envPath = resolve(process.cwd(), "../.env");
  let masterKey = process.env.FACELOGIN_MASTER_KEY;
  let sessionSecret = process.env.FACELOGIN_SESSION_SECRET;

  if (!masterKey || !sessionSecret) {
    masterKey ||= randomSecret();
    sessionSecret ||= randomSecret();
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const next = [
      existing.trim(),
      `FACELOGIN_MASTER_KEY=${masterKey}`,
      `FACELOGIN_SESSION_SECRET=${sessionSecret}`,
    ]
      .filter(Boolean)
      .join("\n")
      .concat("\n");
    writeFileSync(envPath, next);
    process.env.FACELOGIN_MASTER_KEY = masterKey;
    process.env.FACELOGIN_SESSION_SECRET = sessionSecret;
  }

  return { masterKey, sessionSecret };
}

const { masterKey, sessionSecret } = ensureEnv();
const port = Number(process.env.FACELOGIN_PORT ?? 8787);
const lshSeed = process.env.FACELOGIN_LSH_SEED ?? "facelogin-lsh-v1";
const store = new VaultStore(resolve(process.cwd(), "data/vault.json"));
const engine = new FaceEngine(store, deriveMasterKey(masterKey), lshSeed, sessionSecret);

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ["http://localhost:5173"], credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", createRouter(engine, sessionSecret));

app.listen(port, () => {
  console.log(`facelogin api en http://localhost:${port}`);
});
