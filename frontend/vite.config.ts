import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const cert = resolve(root, "certs/localhost.pem");
const key = resolve(root, "certs/localhost-key.pem");
const useHttps = process.env.FACELOGIN_HTTPS === "1";

if (useHttps && !(existsSync(cert) && existsSync(key))) {
  throw new Error("Faltan frontend/certs. Corre: node scripts/ensure-dev-certs.mjs");
}

export default defineConfig({
  plugins: [react()],
  build: {
    /**
     * face-api ya **no** está en el chunk de arranque: se carga con `import()`
     * dinámico desde `face.ts`, así que quien solo abre la portada no lo baja.
     * Lo que queda por encima de 500 kB es ese único chunk diferido —tfjs entero
     * con sus backends CPU, WebGL y WASM—, y no se puede partir más sin
     * romperlo. El aviso ya cumplió su función; dejarlo encendido solo enseña a
     * ignorar la salida del build.
     */
    chunkSizeWarningLimit: 1400,
  },
  server: {
    port: 5173,
    strictPort: true,
    https: useHttps
      ? { cert: readFileSync(cert), key: readFileSync(key) }
      : undefined,
    proxy: {
      // Configurable para poder levantar una segunda instancia (por ejemplo,
      // probar el flujo OIDC contra un backend de pruebas) sin tocar el archivo.
      "/api": process.env.FACELOGIN_API_TARGET ?? "http://localhost:8787",
    },
  },
});
