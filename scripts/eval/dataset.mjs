/**
 * LFW (Labeled Faces in the Wild) — el banco de caras reales del proyecto.
 *
 * Fuente:  https://vis-www.cs.umass.edu/lfw/  (Huang et al., UMass Amherst, 2007)
 * Espejo:  https://ndownloader.figshare.com/files/5976018  (el que usa
 *          `sklearn.datasets.fetch_lfw_people`; el host original de UMass no
 *          siempre es alcanzable).
 * Licencia: las imágenes proceden de Yahoo! News y se publican para
 *          investigación. UMass no reclama copyright y pide citar el technical
 *          report UM-CS-2007-049. No se redistribuye nada aquí: el archivo se
 *          descarga a `.eval-data/`, que está en `.gitignore`.
 *
 * Protocolo: `pairs.txt` es la View 2 oficial — 10 pliegues × (300 pares
 * genuinos + 300 impostores) = 6000 pares. Es la comparación estándar que
 * publica todo el mundo, así que los números de aquí son comparables con la
 * literatura.
 *
 * LÍMITES CONOCIDOS (importan para leer los resultados):
 * - Sesgo demográfico fuerte: ~77 % hombres y ~83 % piel clara (Han & Jain,
 *   2014). El FAR medido NO se puede extrapolar a poblaciones distintas.
 * - Son fotos de prensa: frontales, enfocadas, bien iluminadas. Una webcam en
 *   una habitación real es MÁS difícil, así que el FRR aquí es optimista.
 * - 4069 de las 5749 personas tienen una sola imagen. Eso es bueno para el
 *   conjunto no-mated de 1:N y malo para galerías grandes con muchas muestras.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./faceapi-node.mjs";

export const DATA_DIR = path.join(ROOT, ".eval-data");
export const LFW_DIR = path.join(DATA_DIR, "lfw");

const ARCHIVE = {
  file: "lfw.tgz",
  url: "https://ndownloader.figshare.com/files/5976018",
  sha256: "055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0",
  md5: "a17d05bd522c52d84eca14327a23d494",
};
const PAIRS = {
  file: "pairs.txt",
  url: "https://ndownloader.figshare.com/files/5976006",
  sha256: null,
};

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} devolvió ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Descarga (si hace falta), verifica el hash y extrae. Idempotente. */
export async function ensureLfw({ log = () => {} } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const archive = path.join(DATA_DIR, ARCHIVE.file);
  if (!existsSync(archive)) {
    log(`descargando ${ARCHIVE.file} (~173 MB) desde ${ARCHIVE.url}`);
    await download(ARCHIVE.url, archive);
  }
  const digest = sha256(archive);
  if (digest !== ARCHIVE.sha256) {
    throw new Error(`SHA-256 de ${ARCHIVE.file} no coincide: ${digest} != ${ARCHIVE.sha256}`);
  }
  if (!existsSync(LFW_DIR)) {
    log("extrayendo lfw.tgz");
    execFileSync("tar", ["xzf", archive], { cwd: DATA_DIR });
  }
  const pairs = path.join(DATA_DIR, PAIRS.file);
  if (!existsSync(pairs)) {
    log(`descargando ${PAIRS.file}`);
    await download(PAIRS.url, pairs);
  }
  return { archive, pairs, images: LFW_DIR, sha256: digest };
}

const pad = (n) => String(n).padStart(4, "0");

/** Ruta relativa canónica de una imagen LFW. */
export function imageOf(person, index) {
  return `${person}/${person}_${pad(index)}.jpg`;
}

/**
 * View 2 oficial: 6000 pares (3000 genuinos, 3000 impostores) en 10 pliegues.
 * Formato del fichero: `nombre i j` (mismo sujeto) o `n1 i n2 j` (distintos).
 */
export function readPairs(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const [folds, perFold] = lines[0].split(/\s+/).map(Number);
  const pairs = [];
  let cursor = 1;
  for (let fold = 0; fold < folds; fold += 1) {
    for (let k = 0; k < perFold; k += 1) {
      const [name, i, j] = lines[cursor++].split(/\s+/);
      pairs.push({ fold, same: true, a: imageOf(name, Number(i)), b: imageOf(name, Number(j)) });
    }
    for (let k = 0; k < perFold; k += 1) {
      const [n1, i, n2, j] = lines[cursor++].split(/\s+/);
      pairs.push({ fold, same: false, a: imageOf(n1, Number(i)), b: imageOf(n2, Number(j)) });
    }
  }
  return pairs;
}

/** `{persona: [rutas relativas ordenadas]}` leído del disco. */
export function listPeople(dir = LFW_DIR) {
  const people = new Map();
  for (const person of readdirSync(dir).sort()) {
    const full = path.join(dir, person);
    if (!statSync(full).isDirectory()) continue;
    const files = readdirSync(full)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => `${person}/${f}`);
    if (files.length > 0) people.set(person, files);
  }
  return people;
}
