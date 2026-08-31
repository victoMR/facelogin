/**
 * Banco de evaluación del umbral, sobre CARAS REALES.
 *
 *   npm run eval:threshold
 *
 * Qué produce, en este orden:
 *   A. Geometría del descriptor de face-api — de dónde sale la conversión
 *      distancia↔coseno correcta, y por qué la que había era falsa.
 *   B. Verificación 1:1 sobre los 6000 pares oficiales de LFW: distribuciones
 *      genuina e impostora, curva DET, EER y tabla FAR/FRR por umbral.
 *   C. Identificación 1:N en conjunto abierto (FPIR/TPIR), que es lo que hace
 *      este sistema de verdad y donde ocurrió el incidente.
 *   D. Los dos `max` que inflan al impostor: muestras guardadas y variantes de
 *      augmentación del probe. De ahí salen `storedSamplesPenalty` y
 *      `multiProbePenalty`.
 *   E. Enrollo multi-condición con condiciones reales.
 *   F. Reconstrucción del incidente: la misma galería y el mismo enrollo que
 *      tenía producción, con el umbral viejo y con el nuevo.
 *   G. Comprobación de punta a punta con el `FaceEngine` real.
 *
 * La primera ejecución descarga LFW (~173 MB) y extrae 13 233 descriptores
 * (~5 min con 6 procesos). Las siguientes leen la caché y tardan segundos, con
 * resultados idénticos: no hay muestreo aleatorio sin semilla en ninguna parte.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMasterKey } from "../../backend/src/crypto.js";
import { FaceEngine } from "../../backend/src/engine.js";
import {
  BASE_COSINE_THRESHOLD,
  MAX_COSINE_THRESHOLD,
  MIN_COSINE_THRESHOLD,
  MIN_INTER_CONDITION_COSINE,
  adaptiveThreshold,
  clampThreshold,
  cosine,
  intraStats,
  l2Normalize,
  meanVector,
  multiProbePenalty,
  storedSamplesPenalty,
} from "../../backend/src/matcher.js";
import { VaultStore } from "../../backend/src/store.js";
import { ensureLfw, listPeople, readPairs } from "./dataset.mjs";
import { loadDescriptors } from "./descriptors.mjs";
import { detCurve, eer, farFrr, openSet, stats, thresholdForFar } from "./metrics.mjs";
import { VARIANTS, loadVariants } from "./variants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);
const pct = (v) => `${(v * 100).toFixed(2)} %`;
const pct3 = (v) => `${(v * 100).toFixed(3)} %`;
const f = (v, d = 4) => v.toFixed(d);

function euclid(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Máximo coseno entre cualquier probe y (centroide | muestra) de la condición. */
function scoreOf(condition, probes) {
  let best = -1;
  for (const probe of probes) {
    for (const vector of [condition.centroid, ...condition.samples]) {
      const value = cosine(probe, vector);
      if (value > best) best = value;
    }
  }
  return best;
}

/** Mejor score de la galería, con la misma regla de `engine.bestCandidate`. */
function bestScore(gallery, probes) {
  let best = { id: null, score: -1 };
  for (const item of gallery) {
    for (const condition of item.conditions) {
      const score = scoreOf(condition, probes);
      if (score > best.score) best = { id: item.id, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
const report = {};
const started = Date.now();
const { pairs: pairsFile } = await ensureLfw({ log });
const raw = await loadDescriptors({ log });
const people = listPeople();
const totalImages = [...people.values()].flat().length;
log(
  `\nLFW: ${people.size} personas, ${totalImages} imágenes; descriptor extraído en ` +
    `${raw.size} (${pct(raw.size / totalImages)}). El resto no pasa el detector de` +
    ` extracción (416 px / score 0.6), que es el mismo gate que el navegador.`,
);
report.dataset = {
  nombre: "LFW (Labeled Faces in the Wild), View 2",
  fuente: "https://ndownloader.figshare.com/files/5976018",
  personas: people.size,
  imagenes: totalImages,
  conDescriptor: raw.size,
  tasaDeteccion: raw.size / totalImages,
};

const unit = new Map();
for (const [name, vector] of raw) unit.set(name, l2Normalize(Array.from(vector)));

// --- A ----------------------------------------------------------------------
log("\n=== A. Geometría del descriptor de face-api ===");
const normStats = stats([...raw.values()].map((v) => Math.hypot(...v)));
const R2 = normStats.mean ** 2;
const cosDe = (d) => 1 - (d * d) / (2 * R2);
const distDe = (c) => Math.sqrt(2 * R2 * (1 - c));
log(`norma ‖d‖: media ${f(normStats.mean)} (p01 ${f(normStats.p01)}, p99 ${f(normStats.p99)}). NO son unitarios.`);
log(`  d² = 2r²(1 − cos)  ⇒  el listón 0.6 de face-api es coseno ${f(cosDe(0.6))}, no 0.82.`);
log(`  coseno 0.82 es distancia ${f(distDe(0.82))}: muy por encima del listón.`);
report.geometria = {
  norma: normStats,
  cosenoDeDistancia06: cosDe(0.6),
  distanciaDeCoseno082: distDe(0.82),
};

// --- B ----------------------------------------------------------------------
log("\n=== B. Verificación 1:1 — LFW View 2, 6000 pares oficiales ===");
const genuine = [];
const impostor = [];
const genuineDist = [];
const impostorDist = [];
let descartados = 0;
for (const pair of readPairs(pairsFile)) {
  const a = unit.get(pair.a);
  const b = unit.get(pair.b);
  if (!a || !b) {
    descartados += 1;
    continue;
  }
  (pair.same ? genuine : impostor).push(cosine(a, b));
  (pair.same ? genuineDist : impostorDist).push(euclid(raw.get(pair.a), raw.get(pair.b)));
}
const gs = stats(genuine);
const is = stats(impostor);
log(`pares usables: ${genuine.length} genuinos + ${impostor.length} impostores (${descartados} sin detección en alguna de las dos caras)`);
log(`coseno genuino : media ${f(gs.mean)} σ ${f(gs.std)} | p01 ${f(gs.p01)} p05 ${f(gs.p05)} p50 ${f(gs.p50)} p95 ${f(gs.p95)} | min ${f(gs.min)}`);
log(`coseno impostor: media ${f(is.mean)} σ ${f(is.std)} | p50 ${f(is.p50)} p95 ${f(is.p95)} p99 ${f(is.p99)} | max ${f(is.max)}`);
log(`distancia euclidiana cruda: genuina ${f(stats(genuineDist).mean)} | impostora ${f(stats(impostorDist).mean)}`);
const equal = eer(genuine, impostor);
log(`EER ${pct(equal.eer)} en coseno ${f(equal.threshold)}  ← NO es el punto de operación (ver C)`);

log("\ntabla FAR/FRR por umbral (1:1):");
log("  coseno | dist.equiv |   FAR 1:1 |  FRR 1:1");
const tabla = [];
for (let t = 0.84; t <= 0.9701; t += 0.01) {
  const { far, frr } = farFrr(genuine, impostor, t);
  tabla.push({ t: Number(t.toFixed(2)), far, frr });
  log(`   ${f(t, 2)}  |   ${f(distDe(t), 3)}    | ${pct3(far).padStart(9)} | ${pct(frr).padStart(8)}`);
}
report.verificacion11 = {
  genuinos: genuine.length,
  impostores: impostor.length,
  distribucionGenuina: gs,
  distribucionImpostora: is,
  eer: equal,
  tabla,
};
log("");
for (const target of [0.01, 0.001, 0.0001]) {
  const point = thresholdForFar(genuine, impostor, target);
  log(`FAR 1:1 ≤ ${pct3(target)} exige coseno ≥ ${f(point.t)} y cuesta FRR ${pct(point.frr)}`);
}

// --- C ----------------------------------------------------------------------
log("\n=== C. Identificación 1:N en conjunto abierto (FPIR / TPIR) ===");
const ENROLL = 5;
const enrolables = [...people.entries()]
  .map(([name, files]) => [name, files.filter((file) => unit.has(file))])
  .filter(([, files]) => files.length >= ENROLL + 2)
  .sort(([a], [b]) => (a < b ? -1 : 1));
const unaSola = [...people.entries()]
  .filter(([, files]) => files.length === 1 && unit.has(files[0]))
  .sort(([a], [b]) => (a < b ? -1 : 1));
const NON_MATED = 1500;
const desconocidos = unaSola.slice(0, NON_MATED).map(([, files]) => files[0]);
log(`identidades enrolables (≥ ${ENROLL + 2} imágenes con detección): ${enrolables.length}`);
log(`probes NO enrolados (personas con una única foto en todo LFW): ${desconocidos.length}`);

function plantilla(id, grupos) {
  return {
    id,
    conditions: grupos.map((files) => {
      const samples = files.map((file) => unit.get(file));
      return { centroid: meanVector(samples), samples, ...intraStats(samples) };
    }),
  };
}

function montar(size, { muestras = ENROLL, soloCentroide = false } = {}) {
  const elegidas = enrolables.slice(0, size);
  const gallery = elegidas.map(([name, files]) => {
    const t = plantilla(name, [files.slice(0, muestras)]);
    if (soloCentroide) for (const c of t.conditions) c.samples = [];
    return t;
  });
  const mated = [];
  for (const [name, files] of elegidas) {
    for (const file of files.slice(muestras, muestras + 2)) {
      const best = bestScore(gallery, [unit.get(file)]);
      mated.push({ score: best.score, correct: best.id === name });
    }
  }
  const nonMated = desconocidos.map((file) => bestScore(gallery, [unit.get(file)]).score);
  return { gallery, mated, nonMated };
}

const TAMANOS = [1, 2, 3, 5, 10, 25, 50, 100, 200];
const UMBRALES = [0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97];
const barrido = TAMANOS.filter((n) => n <= enrolables.length).map((size) => {
  const { mated, nonMated } = montar(size);
  return {
    galeria: size,
    mated: mated.length,
    nonMated: nonMated.length,
    puntos: UMBRALES.map((t) => ({ t, ...openSet(mated, nonMated, t) })),
  };
});
log(`\nFPIR / TPIR (enrollo de ${ENROLL} muestras, ${desconocidos.length} desconocidos):`);
log("  umbral " + barrido.map((r) => `| N=${String(r.galeria).padStart(3)}`.padEnd(17)).join(""));
for (let i = 0; i < UMBRALES.length; i += 1) {
  log(
    `   ${f(UMBRALES[i], 2)}   ` +
      barrido
        .map((r) => `| ${pct3(r.puntos[i].fpir).padStart(8)}/${pct(r.puntos[i].tpir).padStart(6)}`)
        .join(""),
  );
}
report.identificacion1N = { muestras: ENROLL, desconocidos: desconocidos.length, barrido };

// --- D ----------------------------------------------------------------------
log("\n=== D. Los dos `max` que inflan al impostor ===");
log("\nD.1 muestras guardadas (centroide fijo de 5, galería de 38 identidades con ≥22 fotos):");
const ricos = enrolables.filter(([, files]) => files.length >= 22).slice(0, 40);
const almacenadas = [];
for (const K of [0, 1, 3, 5, 10, 20]) {
  const gallery = ricos.map(([name, files]) => {
    const t = plantilla(name, [files.slice(0, ENROLL)]);
    t.conditions[0].samples = files.slice(0, K).map((file) => unit.get(file));
    return t;
  });
  const sc = stats(desconocidos.map((file) => bestScore(gallery, [unit.get(file)]).score));
  almacenadas.push({ muestras: K, p50: sc.p50, p95: sc.p95, p99: sc.p99, penalizacion: storedSamplesPenalty(K) });
  log(
    `  K=${String(K).padStart(2)}: impostor p50 ${f(sc.p50)} p95 ${f(sc.p95)} p99 ${f(sc.p99)}` +
      `   storedSamplesPenalty(${K}) = ${f(storedSamplesPenalty(K), 4)}`,
  );
}
report.penalizacionMuestras = { identidades: ricos.length, filas: almacenadas };

log("\nD.2 variantes de augmentación del probe (las de verdad: espejo, brillo, giro, encuadre):");
const G100 = Math.min(100, enrolables.length);
const matedProbe = [];
for (const [name, files] of enrolables.slice(0, G100)) {
  for (const file of files.slice(ENROLL, ENROLL + 2)) matedProbe.push([name, file]);
}
const probeFiles = [...desconocidos.slice(0, 1000), ...matedProbe.map(([, file]) => file)];
const variantes = await loadVariants(probeFiles, { log });
const galeria100 = enrolables.slice(0, G100).map(([name, files]) => plantilla(name, [files.slice(0, ENROLL)]));
const multiProbe = [];
log("   N | impostor p50   p95   p99  | dueño p05   p50  | multiProbePenalty");
for (const N of [1, 3, 7]) {
  const imp = desconocidos
    .slice(0, 1000)
    .filter((file) => variantes.has(file))
    .map((file) => bestScore(galeria100, variantes.get(file).slice(0, N).map(l2Normalize)).score);
  const mat = matedProbe
    .filter(([, file]) => variantes.has(file))
    .map(([, file]) => bestScore(galeria100, variantes.get(file).slice(0, N).map(l2Normalize)).score);
  const a = stats(imp);
  const m = stats(mat);
  multiProbe.push({ n: N, impostorP99: a.p99, duenoP05: m.p05, penalizacion: multiProbePenalty(N) });
  log(
    `   ${N} | ${f(a.p50)} ${f(a.p95)} ${f(a.p99)} | ${f(m.p05)} ${f(m.p50)} | ${f(multiProbePenalty(N), 4)}`,
  );
}
log(`   variantes disponibles: ${VARIANTS.map((v) => v.name).join(", ")}`);
report.penalizacionMultiProbe = multiProbe;

// --- E ----------------------------------------------------------------------
log("\n=== E. Enrollo multi-condición, con condiciones reales ===");
log("LFW no etiqueta 'con lentes' / 'sin lentes'. Se parte cada persona en dos grupos con");
log("2-medias sobre sus propios descriptores: son dos nubes reales (pose, luz, época, gafas).");
function dosCondiciones(files) {
  const vectors = files.map((file) => unit.get(file));
  let a = vectors[0];
  let b = vectors.reduce((worst, v) => (cosine(v, a) < cosine(worst, a) ? v : worst), vectors[0]);
  let grupoA = [];
  let grupoB = [];
  for (let iter = 0; iter < 12; iter += 1) {
    grupoA = [];
    grupoB = [];
    for (let i = 0; i < vectors.length; i += 1) {
      (cosine(vectors[i], a) >= cosine(vectors[i], b) ? grupoA : grupoB).push(i);
    }
    if (grupoA.length === 0 || grupoB.length === 0) return null;
    a = meanVector(grupoA.map((i) => vectors[i]));
    b = meanVector(grupoB.map((i) => vectors[i]));
  }
  return { inter: cosine(a, b), grupoA: grupoA.map((i) => files[i]), grupoB: grupoB.map((i) => files[i]) };
}
const inters = [];
const cruzados = [];
const propios = [];
const ambas = [];
for (const [, files] of enrolables.slice(0, 400)) {
  if (files.length < 10) continue;
  const split = dosCondiciones(files);
  if (!split || split.grupoA.length < 4 || split.grupoB.length < 4) continue;
  inters.push(split.inter);
  const soloA = plantilla("x", [split.grupoA.slice(0, ENROLL)]);
  const lasDos = plantilla("x", [split.grupoA.slice(0, ENROLL), split.grupoB.slice(0, ENROLL)]);
  for (const file of split.grupoB.slice(ENROLL, ENROLL + 2)) {
    cruzados.push(bestScore([soloA], [unit.get(file)]).score);
    ambas.push(bestScore([lasDos], [unit.get(file)]).score);
  }
  for (const file of split.grupoA.slice(ENROLL, ENROLL + 2)) {
    propios.push(bestScore([soloA], [unit.get(file)]).score);
  }
}
const si = stats(inters);
const sc = stats(cruzados);
const sp = stats(propios);
const sa = stats(ambas);
log(`identidades partidas en dos condiciones: ${inters.length}`);
log(`coseno entre centroides de las dos condiciones: media ${f(si.mean)} p05 ${f(si.p05)} min ${f(si.min)}`);
log(`  (MIN_INTER_CONDITION_COSINE = ${MIN_INTER_CONDITION_COSINE}; el p99 de dos personas DISTINTAS es ${f(is.p99)})`);
log(`dueño, enroló A y entra en A            : p05 ${f(sp.p05)} p50 ${f(sp.p50)}`);
log(`dueño, enroló SOLO A y entra en B       : p05 ${f(sc.p05)} p50 ${f(sc.p50)}   ← la "tolerancia" que se pierde`);
log(`dueño, enroló A y B  y entra en B       : p05 ${f(sa.p05)} p50 ${f(sa.p50)}   ← la solución correcta`);
report.multiCondicion = { identidades: inters.length, inter: si, propio: sp, cruzadoSinEnrolar: sc, cruzadoEnrolado: sa };

// --- F ----------------------------------------------------------------------
log("\n=== F. Reconstrucción del incidente ===");
log("Galería de 3 identidades y enrollo de 2 condiciones × 15 muestras: la forma exacta");
log("que tenía el vault de producción (interConditionCosine medido allí: 0.9907).");
const tres = enrolables.filter(([, files]) => files.length >= 32).slice(0, 3);
const galeriaIncidente = tres.map(([name, files]) =>
  plantilla(name, [files.slice(0, 15), files.slice(15, 30)]),
);
log(`  identidades: ${tres.map(([n, fl]) => `${n} (${fl.length} fotos)`).join(", ")}`);
log(`  interConditionCosine de cada una: ${galeriaIncidente
  .map((t) => f(cosine(t.conditions[0].centroid, t.conditions[1].centroid)))
  .join("  ")}`);
const scoresDesconocidos = desconocidos.map((file) => bestScore(galeriaIncidente, [unit.get(file)]).score);
const sd = stats(scoresDesconocidos);
log(`  score del DESCONOCIDO contra esa galería: p50 ${f(sd.p50)} p95 ${f(sd.p95)} p99 ${f(sd.p99)} max ${f(sd.max)}`);
const scoresDueno = [];
for (const [name, files] of tres) {
  const t = galeriaIncidente.find((x) => x.id === name);
  for (const file of files.slice(30, 40)) scoresDueno.push(bestScore([t], [unit.get(file)]).score);
}
const sdu = stats(scoresDueno);
log(`  score del DUEÑO:                         p05 ${f(sdu.p05)} p50 ${f(sdu.p50)} min ${f(sdu.min)}`);

// Umbral efectivo que aplicaría cada calibración a esa plantilla.
const condIncidente = galeriaIncidente[0].conditions[0];
const interIncidente = cosine(galeriaIncidente[0].conditions[0].centroid, galeriaIncidente[0].conditions[1].centroid);
const umbralNuevo = clampThreshold(
  adaptiveThreshold(condIncidente.mean, condIncidente.std, 3, interIncidente) + storedSamplesPenalty(15),
);
const UMBRAL_VIEJO = 0.5772533624634173; // thresholdAtEnroll leído del vault de producción
const fpirDe = (t) => scoresDesconocidos.filter((s) => s >= t).length / scoresDesconocidos.length;
const tpirDe = (t) => scoresDueno.filter((s) => s >= t).length / scoresDueno.length;
log("");
log("  calibración                     | umbral  | FPIR                  | TPIR");
log(`  la que había (base 0.52)        | ${f(UMBRAL_VIEJO)}  | ${pct3(fpirDe(UMBRAL_VIEJO)).padStart(8)} (${scoresDesconocidos.filter((s) => s >= UMBRAL_VIEJO).length}/${scoresDesconocidos.length}) | ${pct(tpirDe(UMBRAL_VIEJO))}`);
log(`  su techo absoluto (0.72)        | 0.7200  | ${pct3(fpirDe(0.72)).padStart(8)} (${scoresDesconocidos.filter((s) => s >= 0.72).length}/${scoresDesconocidos.length}) | ${pct(tpirDe(0.72))}`);
log(`  la nueva (base 0.93)            | ${f(umbralNuevo)}  | ${pct3(fpirDe(umbralNuevo)).padStart(8)} (${scoresDesconocidos.filter((s) => s >= umbralNuevo).length}/${scoresDesconocidos.length}) | ${pct(tpirDe(umbralNuevo))}`);
report.incidente = {
  identidades: tres.map(([n]) => n),
  umbralViejo: UMBRAL_VIEJO,
  umbralNuevo,
  scoreDesconocido: sd,
  scoreDueno: sdu,
  fpirViejo: fpirDe(UMBRAL_VIEJO),
  fpirNuevo: fpirDe(umbralNuevo),
  tpirNuevo: tpirDe(umbralNuevo),
};

// --- G ----------------------------------------------------------------------
log("\n=== G. Comprobación de punta a punta con el FaceEngine real ===");
log(`BASE ${BASE_COSINE_THRESHOLD}  MIN ${MIN_COSINE_THRESHOLD}  MAX ${MAX_COSINE_THRESHOLD}`);
const motor = [];
for (const size of [3, 25, 100]) {
  if (size > enrolables.length) continue;
  const elegidas = enrolables.slice(0, size);
  const vaultPath = path.join(mkdtempSync(path.join(tmpdir(), "facelogin-eval-")), "vault.json");
  const engine = new FaceEngine(
    new VaultStore(vaultPath),
    deriveMasterKey("clave-de-evaluacion"),
    "semilla-de-evaluacion",
    "secreto-de-evaluacion",
  );
  const nombrePorId = new Map();
  for (const [name, files] of elegidas) {
    const template = engine.enroll(name, files.slice(0, ENROLL).map((file) => Array.from(raw.get(file))));
    nombrePorId.set(template.id, name);
  }
  let aciertos = 0;
  let total = 0;
  for (const [name, files] of elegidas) {
    for (const file of files.slice(ENROLL, ENROLL + 2)) {
      const decision = engine.identify(Array.from(raw.get(file)));
      total += 1;
      if (decision.matched && nombrePorId.get(decision.identityId) === name) aciertos += 1;
    }
  }
  const falsos = desconocidos.filter((file) => engine.identify(Array.from(raw.get(file))).matched).length;
  motor.push({ galeria: size, tpir: aciertos / total, fpir: falsos / desconocidos.length, falsos });
  log(
    `  galería ${String(size).padStart(3)}: TPIR ${pct(aciertos / total).padStart(7)}   ` +
      `FPIR ${pct3(falsos / desconocidos.length).padStart(8)}  (${falsos}/${desconocidos.length} desconocidos aceptados)`,
  );
}
report.motorReal = motor;

// --- fixture para el test de regresión --------------------------------------
// El test de `npm test` no puede depender de tener LFW descargado, así que aquí
// se congela el subconjunto mínimo con el que se recalcula el FPIR: 30
// identidades enroladas y 400 desconocidos, en descriptores CRUDOS (el motor
// los normaliza él). 4 decimales bastan: el error en coseno queda por debajo
// de 1e-3, tres órdenes de magnitud por debajo del margen que se vigila.
const round = (v) => Number(v.toFixed(4));
const fixture = {
  origen: "LFW View 2 — generado por `npm run eval:threshold`",
  descripcion:
    "30 identidades enroladas con 5 muestras + 400 personas que NO están en la galería. " +
    "Sirve para recalcular FPIR/TPIR contra las constantes vigentes.",
  muestrasPorIdentidad: ENROLL,
  identidades: enrolables.slice(0, 30).map(([name, files]) => ({
    nombre: name,
    enrollo: files.slice(0, ENROLL).map((file) => Array.from(raw.get(file)).map(round)),
    probes: files.slice(ENROLL, ENROLL + 2).map((file) => Array.from(raw.get(file)).map(round)),
  })),
  desconocidos: desconocidos.slice(0, 400).map((file) => Array.from(raw.get(file)).map(round)),
};
const fixtureDir = path.join(HERE, "..", "..", "backend", "src", "__tests__", "fixtures");
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(path.join(fixtureDir, "lfw-openset.json"), `${JSON.stringify(fixture)}\n`);
log(`\nfixture de regresión → backend/src/__tests__/fixtures/lfw-openset.json`);

const outDir = path.join(HERE, "resultados");
mkdirSync(outDir, { recursive: true });
report.generado = new Date().toISOString();
report.segundos = (Date.now() - started) / 1000;
writeFileSync(path.join(outDir, "lfw.json"), `${JSON.stringify(report, null, 2)}\n`);
log(`informe completo     → scripts/eval/resultados/lfw.json  (${report.segundos.toFixed(1)} s)`);
