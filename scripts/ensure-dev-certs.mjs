import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const certDir = resolve(root, "frontend/certs");
const cert = resolve(certDir, "localhost.pem");
const key = resolve(certDir, "localhost-key.pem");
const cnf = resolve(root, "scripts/localhost.cnf");

mkdirSync(certDir, { recursive: true });

if (!existsSync(cert) || !existsSync(key)) {
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "825",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-config",
    cnf,
  ], { stdio: "inherit" });
}

console.log(`HTTPS listo: ${cert}`);
console.log("Abre Chrome con: npm run dev:cam");
