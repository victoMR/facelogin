/**
 * Elección **verificada** del backend de cómputo de tfjs.
 *
 * `tf.setBackend('webgl')` puede devolver `true` y aun así fallar en la primera
 * convolución: el contexto WebGL se crea, pero el driver lo pierde, o la GPU
 * está en la lista negra del navegador, o es un WebGL de software que va más
 * lento que la CPU. Por eso aquí no se *asume* nada: se pide el backend, se
 * corre una operación real y solo si vuelve el resultado correcto se da por
 * bueno. Si falla, se prueba el siguiente.
 *
 * Orden: WebGL → WASM (con SIMD) → CPU. Los `.wasm` salen de `/tfjs/`, mismo
 * origen que la app, copiados por `scripts/sync-assets.mjs`; el tfjs que trae
 * face-api los buscaría si no en un CDN.
 */
import type * as FaceApi from "@vladmandic/face-api";
import type { ComputeBackend } from "./perf";

/**
 * Los tipos que face-api reexporta de tfjs (`faceapi.tf`) están recortados: no
 * declaran `setBackend`, `ready`, `getBackend` ni los constructores de tensores,
 * aunque el objeto de runtime sí los trae (es el namespace completo de tfjs).
 * En vez de castear a `any` en cada llamada, se declara aquí la superficie
 * exacta que este módulo usa; si mañana falta algo, falla al compilar en un solo
 * sitio en vez de reventar en el navegador.
 */
type Tensor = { data(): Promise<ArrayLike<number>>; dispose(): void };
type TfLike = {
  setBackend(name: string): Promise<boolean>;
  getBackend(): string;
  ready(): Promise<void>;
  ones(shape: number[]): Tensor;
  conv2d(input: Tensor, kernel: Tensor, strides: number, pad: string): Tensor;
  setWasmPaths?: (prefix: string) => void;
};

export type BackendReport = {
  backend: ComputeBackend;
  /** Los que se intentaron y por qué no fueron, en orden. Va a los detalles técnicos. */
  rejected: { backend: string; reason: string }[];
  /** Coste de la operación de comprobación, en ms. Primera señal de lo que da el equipo. */
  probeMs: number;
  simd: boolean;
};

let report: BackendReport | null = null;

export function backendReport(): BackendReport | null {
  return report;
}

/**
 * Operación de prueba: una convolución 2D pequeña, no un `add`.
 *
 * Un `tf.add` pasa en cualquier backend roto porque ni siquiera compila un
 * shader. La convolución es lo que de verdad va a correr la red, y es lo que
 * revela un WebGL que se declara disponible y luego no puede compilar.
 */
async function probe(tf: TfLike): Promise<number> {
  const started = performance.now();
  const input = tf.ones([1, 32, 32, 3]);
  const kernel = tf.ones([3, 3, 3, 4]);
  const output = tf.conv2d(input, kernel, 1, "same");
  const data = await output.data();
  input.dispose();
  kernel.dispose();
  output.dispose();
  if (!data.length || !Number.isFinite(data[0]) || data[0] === 0) {
    throw new Error("la operación de prueba devolvió basura");
  }
  return performance.now() - started;
}

async function hasSimd(): Promise<boolean> {
  try {
    // Módulo WASM mínimo que usa una instrucción SIMD (v128.const). Si el
    // navegador no la soporta, `validate` devuelve false.
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

async function tryBackend(tf: TfLike, name: string): Promise<number> {
  const ok = await tf.setBackend(name);
  if (!ok) throw new Error("setBackend devolvió false");
  await tf.ready();
  if (tf.getBackend() !== name) throw new Error(`tfjs quedó en ${tf.getBackend()}`);
  return probe(tf);
}

/**
 * Deja tfjs en el mejor backend que **funcione de verdad** y devuelve cuál tocó.
 * Idempotente: la segunda llamada devuelve el informe guardado.
 */
export async function selectBackend(api: typeof FaceApi): Promise<BackendReport> {
  if (report) return report;
  const tf = api.tf as unknown as TfLike;
  const rejected: { backend: string; reason: string }[] = [];
  const simd = await hasSimd();

  const candidates: ComputeBackend[] = ["webgl", "wasm", "cpu"];
  for (const name of candidates) {
    if (name === "wasm") {
      // Sin SIMD, el backend WASM rinde parecido al de CPU y carga 300 kB más;
      // no vale la pena el intento.
      if (!simd) {
        rejected.push({ backend: "wasm", reason: "el navegador no tiene WASM SIMD" });
        continue;
      }
      try {
        // Los `.wasm` desde nuestro origen (`scripts/sync-assets.mjs` los copia
        // a `public/tfjs/`). Sin esto, el tfjs que trae face-api los pediría a
        // un CDN, que es justo la dependencia externa que este pase elimina.
        tf.setWasmPaths?.("/tfjs/");
      } catch {
        /* si no existe, tfjs usará su ruta por defecto */
      }
    }
    try {
      const probeMs = await tryBackend(tf, name);
      report = { backend: name, rejected, probeMs, simd };
      return report;
    } catch (error) {
      rejected.push({
        backend: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Ni siquiera CPU: no hay nada que hacer, pero se deja un informe coherente
  // para que la UI pueda decirlo en vez de quedarse en blanco.
  report = { backend: "cpu", rejected, probeMs: Number.POSITIVE_INFINITY, simd };
  return report;
}
