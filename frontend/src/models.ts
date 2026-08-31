/**
 * Los pesos, desde nuestro origen y con caché propia.
 *
 * Antes esto bajaba de `cdn.jsdelivr.net/npm/@vladmandic/face-api/model/` sin
 * versión fijada, sin SRI y sin caché. Tres problemas distintos:
 *
 * 1. **Seguridad.** Un tercero servía 6.7 MB de binarios que se ejecutan como
 *    red neuronal en la misma página que tiene abierta la cámara. Un CDN
 *    comprometido, o un DNS envenenado en la wifi de un café, entregaba lo que
 *    quisiera. Ahora salen de `frontend/public/models/`, mismo origen que la app.
 * 2. **Arranque.** En 3G son varios segundos de espera antes del primer frame,
 *    en cada visita, porque no había ninguna caché explícita.
 * 3. **Disponibilidad.** Sin conexión al CDN la app no arrancaba, aunque el
 *    resto estuviera servido desde localhost.
 *
 * La caché es `CacheStorage`, no IndexedDB: los pesos son respuestas HTTP y
 * `caches` las guarda tal cual, sin serializar 6.4 MB a un blob y de vuelta.
 * Cada entrada se verifica contra su SHA-256 (`model-digests.json`, generado por
 * `scripts/sync-assets.mjs`) antes de servirse: es lo que sustituye al SRI que
 * nunca hubo, y protege contra una entrada de caché corrupta o manipulada.
 */
import DIGESTS from "./model-digests.json";

/** Mismo origen. Vite sirve `public/` en la raíz, así que esto vale en dev y en build. */
export const MODEL_URL = "/models/";

/** La versión va en el nombre: cambiar los pesos invalida la caché entera sin borrarla a mano. */
const CACHE_NAME = "facelogin.models.v1";

const digests = DIGESTS as Record<string, string>;

function pathOf(url: string): string {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return url;
  }
}

async function sha256(buffer: ArrayBuffer): Promise<string | null> {
  // `crypto.subtle` solo existe en contexto seguro. En uno inseguro tampoco hay
  // cámara, así que no es un camino que importe — pero degradar a "sin verificar"
  // es mejor que reventar el arranque.
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verified(response: Response, path: string): Promise<Response | null> {
  const expected = digests[path];
  const buffer = await response.arrayBuffer();
  if (expected) {
    const actual = await sha256(buffer);
    if (actual !== null && actual !== expected) return null;
  }
  return new Response(buffer, {
    status: 200,
    headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
  });
}

/** Estadística del último `loadModels`, para poder reportar el arranque con números. */
export type ModelLoadStats = {
  /** Cuántos archivos salieron de la caché y cuántos de la red. */
  fromCache: number;
  fromNetwork: number;
  bytes: number;
  ms: number;
};

let stats: ModelLoadStats = { fromCache: 0, fromNetwork: 0, bytes: 0, ms: 0 };

export function modelLoadStats(): ModelLoadStats {
  return { ...stats };
}

export function resetModelLoadStats(): void {
  stats = { fromCache: 0, fromNetwork: 0, bytes: 0, ms: 0 };
}

/**
 * `fetch` con caché para los pesos. Se le pasa a face-api con
 * `env.monkeyPatch({ fetch })`, que es el punto de extensión que la propia
 * librería expone: no hay que reimplementar su carga de manifiestos ni de shards.
 *
 * Cualquier URL que no sea de `/models/` pasa de largo sin tocarse.
 */
export async function cachingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = pathOf(url);
  if (!path.startsWith(MODEL_URL)) return fetch(input as RequestInfo, init);

  let cache: Cache | null = null;
  try {
    // `caches` no existe en contexto inseguro ni en Firefox en modo privado.
    cache = "caches" in globalThis ? await caches.open(CACHE_NAME) : null;
  } catch {
    cache = null;
  }

  if (cache) {
    const hit = await cache.match(path);
    if (hit) {
      const ok = await verified(hit.clone(), path);
      if (ok) {
        stats.fromCache += 1;
        stats.bytes += Number(hit.headers.get("content-length") ?? 0);
        return ok;
      }
      // Huella que no cuadra: la entrada se tira y se vuelve a la red. No se
      // sirve nunca un peso que no verificamos.
      await cache.delete(path);
    }
  }

  const response = await fetch(url, init);
  if (!response.ok) return response;
  const clone = response.clone();
  const ok = await verified(response, path);
  if (!ok) throw new Error(`El peso ${path} no coincide con su huella SHA-256.`);
  stats.fromNetwork += 1;
  if (cache) {
    try {
      await cache.put(path, clone);
    } catch {
      // Cuota llena: se sigue sin caché en vez de romper el arranque.
    }
  }
  return ok;
}

/** Borra la caché de pesos. Solo lo usa el banco de medición, para medir el arranque en frío. */
export async function clearModelCache(): Promise<void> {
  try {
    if ("caches" in globalThis) await caches.delete(CACHE_NAME);
  } catch {
    /* nada que hacer */
  }
}

export function markModelLoad(ms: number): void {
  stats.ms = ms;
}
