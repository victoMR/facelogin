/**
 * Enrollo multi-condición (con lentes / sin lentes).
 *
 * **Este fichero cambió de arriba abajo al recalibrar con caras reales**, y no
 * por gusto: los parámetros que usaba eran falsos. Asumía que unos lentes
 * mueven el descriptor a coseno 0.60–0.65 entre condiciones. Medido:
 *
 * - El enrollo multi-condición del vault de producción tiene
 *   `interConditionCosine` = **0.9907**.
 * - Partiendo en dos (2-medias) las fotos de 42 identidades de LFW —años
 *   distintos, poses, luces y gafas distintas— la separación entre las dos
 *   nubes es 0.9845 de media, 0.9755 en el p05 y 0.9444 en el peor caso.
 * - Dos personas **distintas** puntúan 0.8370 de media (p99 0.9093).
 *
 * Es decir: la separación entre dos condiciones de la misma persona es MUCHO
 * menor que la que había entre condiciones y personas distintas, y un
 * `crossCosine` de 0.62 no describe unos lentes: describe a otra persona. Por
 * eso `MIN_INTER_CONDITION_COSINE` pasó de 0.45 a 0.92, y por eso los montajes
 * de este fichero se rehicieron con `MEDIDO`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import {
  MIN_INTER_CONDITION_COSINE,
  adaptiveThreshold,
  clampThreshold,
  cosine,
  enrollmentQuality,
  enrollmentQualityByCondition,
  intraStats,
  meanVector,
  storedSamplesPenalty,
} from "../matcher.js";
import { VaultStore } from "../store.js";
import { MEDIDO, atCosine, makePersona, randomUnit, rng, sigmaFor, noisySample } from "./synthetic.js";

const KEY = deriveMasterKey("clave-de-prueba");

function newEngine(): FaceEngine {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-cond-")), "vault.json");
  return new FaceEngine(new VaultStore(path), KEY, "semilla-de-prueba", "secreto-de-prueba");
}

/** Persona con dos condiciones: N capturas de enrollo + 2 de reserva por condición. */
function persona(next: () => number, crossCosine: number = MEDIDO.crossCosine, perCondition = 5) {
  const p = makePersona(next, {
    crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: perCondition + 2,
  });
  return {
    conLentes: p.samplesByCondition[0].slice(0, perCondition),
    sinLentes: p.samplesByCondition[1].slice(0, perCondition),
    // Capturas NUEVAS, nunca enroladas: es lo que llega en el login.
    probeConLentes: p.samplesByCondition[0][perCondition],
    probeSinLentes: p.samplesByCondition[1][perCondition],
    centros: p.conditionCenters,
  };
}

test("con la separación REAL entre condiciones, medir en bloque ya no rechaza el alta", () => {
  const next = rng(101);
  const { conLentes, sinLentes } = persona(next, MEDIDO.crossCosineLimite);

  // Cada condición, por separado, es un cluster impecable.
  assert.equal(enrollmentQuality(conLentes).ok, true);
  assert.equal(enrollmentQuality(sinLentes).ok, true);

  // Y la mezcla también, ahora que `crossCosine` es el medido y no 0.62. Esto
  // es un resultado NEGATIVO y se deja escrito: la justificación original de
  // los sub-clusters —"medir en bloque rechaza el enrollo legítimo"— se apoyaba
  // en una separación entre condiciones que en caras reales no ocurre.
  const mezcla = intraStats([...conLentes, ...sinLentes]);
  const enBloque = enrollmentQuality([...conLentes, ...sinLentes]);
  console.log(
    `enrollo con+sin lentes en bloque (cross ${MEDIDO.crossCosineLimite}): ` +
      `intraMean ${mezcla.mean.toFixed(3)} intraStd ${mezcla.std.toFixed(3)} → ` +
      `${enBloque.ok ? "aceptado" : "RECHAZADO"}`,
  );
  assert.equal(enBloque.ok, true);

  // Lo que SÍ sigue siendo cierto, y es la razón por la que los sub-clusters se
  // quedan: la mezcla carga un umbral más alto que cualquiera de las dos nubes,
  // porque su `intraMean` es peor. Se paga en FRR sin ganar nada de FAR.
  const umbralMezcla = adaptiveThreshold(mezcla.mean, mezcla.std, 3, null);
  const propia = intraStats(sinLentes);
  const umbralPropio = adaptiveThreshold(propia.mean, propia.std, 3, null);
  console.log(`  umbral de la mezcla ${umbralMezcla.toFixed(4)} vs del sub-cluster ${umbralPropio.toFixed(4)}`);
  assert.ok(umbralMezcla > umbralPropio);

  const porCondicion = enrollmentQualityByCondition([
    { label: "con-lentes", samples: conLentes },
    { label: "sin-lentes", samples: sinLentes },
  ]);
  assert.deepEqual(porCondicion, { ok: true, reason: "ok" });
});

test("dos personas distintas no caben bajo una identidad, ni siquiera pareciéndose mucho", () => {
  const next = rng(202);
  const ana = makePersona(next, { crossCosine: MEDIDO.crossCosine, withinCosine: MEDIDO.withinCosine, perCondition: 5 });
  // El impostor NO es un vector aleatorio (coseno ~0, que rechazaría cualquier
  // cosa): se coloca a 0.90, justo en el p99 de dos personas distintas medido
  // en LFW. Es el caso duro, y es el que tiene que rebotar.
  const centroAna = meanVector(ana.samplesByCondition[0]);
  const centroBeto = atCosine(centroAna, 0.9, next);
  const beto = Array.from({ length: 5 }, () =>
    noisySample(centroBeto, sigmaFor(MEDIDO.withinCosine), next),
  );

  const resultado = enrollmentQualityByCondition([
    { label: "con-lentes", samples: ana.samplesByCondition[0] },
    { label: "sin-lentes", samples: beto },
  ]);
  const similitud = cosine(centroAna, meanVector(beto));
  console.log(
    `dos personas bajo una identidad: similitud ${similitud.toFixed(3)} ` +
      `(mínimo exigido ${MIN_INTER_CONDITION_COSINE}) → ${resultado.reason}`,
  );
  assert.ok(similitud < MIN_INTER_CONDITION_COSINE, `montaje inválido: ${similitud}`);
  assert.equal(resultado.ok, false);
  assert.match(resultado.reason, /misma persona/);
});

test("enrollmentQuality por sub-cluster rechaza una condición floja aunque la otra sea perfecta", () => {
  const next = rng(203);
  const p = persona(next);
  const basura = Array.from({ length: 5 }, () => randomUnit(next));
  const resultado = enrollmentQualityByCondition([
    { label: "con-lentes", samples: p.conLentes },
    { label: "sin-lentes", samples: basura },
  ]);
  assert.equal(resultado.ok, false);
  assert.match(resultado.reason, /^\[sin-lentes\]/);
});

test("un enrollo multi-condición entra por el motor y guarda dos sub-clusters", () => {
  const engine = newEngine();
  const next = rng(303);
  const { conLentes, sinLentes, probeSinLentes } = persona(next);

  const template = engine.enroll("Ana", [
    { label: "con-lentes", samples: conLentes },
    { label: "sin-lentes", samples: sinLentes },
  ]);
  assert.equal(template.conditions.length, 2);
  assert.deepEqual(
    template.conditions.map((c) => c.label),
    ["con-lentes", "sin-lentes"],
  );
  for (const condition of template.conditions) assert.ok(condition.intraMean > 0.94);
  // La separación entre condiciones es real pero pequeña: entre el mínimo que
  // acepta el alta y 1. El montaje anterior exigía `< 0.7`, que hoy ni se enrola.
  const inter = template.interConditionCosine ?? 1;
  assert.ok(inter >= MIN_INTER_CONDITION_COSINE && inter < 1, `interConditionCosine ${inter}`);

  const decision = engine.identify(probeSinLentes);
  assert.equal(decision.matched, true);
  assert.equal(decision.displayName, "Ana");
  assert.equal(decision.condition, "sin-lentes");
});

/**
 * EL TEST QUE JUSTIFICA EL TRABAJO — y que ahora dice algo más modesto.
 *
 * Tres estrategias, la misma persona, el mismo login "sin lentes":
 *
 *  A. Línea base — solo se enroló la condición con lentes.
 *  B. Todo en un cluster — las dos condiciones en una bolsa, gate incluido.
 *  C. Sub-clusters — dos condiciones, cada una con su centroide y su umbral.
 *
 * Con la separación entre condiciones que de verdad existe (0.94–0.99), B ya no
 * se cae en el alta y A ya no falla siempre. Lo que queda es la diferencia de
 * umbral, que es pequeña pero va toda en la misma dirección. Se deja medido en
 * lugar de repetir el titular viejo, que dependía de un `crossCosine` inventado.
 */
test("sub-clusters no pierden nunca frente al cluster único ni a enrolar una sola condición", () => {
  const TRIALS = 200;
  const GALLERY = 3;
  type Fila = { cross: number; probeQ: number; base: number; promedio: number; sub: number };
  const filas: Fila[] = [];

  for (const probeQ of [MEDIDO.probeCosine.bueno, MEDIDO.probeCosine.mediocre]) {
    for (const cross of [0.93, 0.96, 0.98, 0.99]) {
      const next = rng(Math.round(cross * 1000) + Math.round(probeQ * 100));
      let base = 0;
      let promedio = 0;
      let sub = 0;

      for (let i = 0; i < TRIALS; i += 1) {
        const p = makePersona(next, {
          crossCosine: cross,
          withinCosine: MEDIDO.withinCosine,
          perCondition: 5,
        });
        const [conLentes, sinLentes] = p.samplesByCondition;
        const probe = noisySample(p.conditionCenters[1], sigmaFor(probeQ), next);
        const cCon = meanVector(conLentes);
        const cSin = meanVector(sinLentes);
        const union = [...conLentes, ...sinLentes];
        const score = (centroid: number[], samples: number[][]) =>
          Math.max(cosine(probe, centroid), ...samples.map((s) => cosine(probe, s)));
        const umbral = (mean: number, std: number, inter: number | null, muestras: number) =>
          clampThreshold(adaptiveThreshold(mean, std, GALLERY, inter) + storedSamplesPenalty(muestras));

        // A. Solo con lentes.
        const statsCon = intraStats(conLentes);
        if (score(cCon, conLentes) >= umbral(statsCon.mean, statsCon.std, null, conLentes.length)) {
          base += 1;
        }

        // B. Las dos condiciones en un solo cluster promediado, gate incluido.
        const statsUnion = intraStats(union);
        if (
          enrollmentQuality(union).ok &&
          score(meanVector(union), union) >= umbral(statsUnion.mean, statsUnion.std, null, union.length)
        ) {
          promedio += 1;
        }

        // C. Sub-clusters: gana el más cercano y el umbral sale de ESA condición.
        const inter = cosine(cCon, cSin);
        const statsSin = intraStats(sinLentes);
        const umbralSub = Math.min(
          umbral(statsSin.mean, statsSin.std, inter, sinLentes.length),
          umbral(statsCon.mean, statsCon.std, inter, conLentes.length),
        );
        if (Math.max(score(cSin, sinLentes), score(cCon, conLentes)) >= umbralSub) sub += 1;
      }

      filas.push({ cross, probeQ, base: base / TRIALS, promedio: promedio / TRIALS, sub: sub / TRIALS });
    }
  }

  console.log("aceptación del dueño legítimo (enroló con lentes, entra SIN lentes), 200 intentos/fila:");
  for (const fila of filas) {
    console.log(
      `  cos(con,sin)=${fila.cross.toFixed(2)} frame=${fila.probeQ.toFixed(2)}: ` +
        `solo-una-condición ${(fila.base * 100).toFixed(1)} % | ` +
        `cluster único promediado ${(fila.promedio * 100).toFixed(1)} % | ` +
        `sub-clusters ${(fila.sub * 100).toFixed(1)} %`,
    );
  }

  // Lo que se sostiene con datos reales: los sub-clusters nunca pierden.
  for (const fila of filas) {
    assert.ok(
      fila.sub >= fila.promedio,
      `el cluster único superó a los sub-clusters en cross=${fila.cross} q=${fila.probeQ}`,
    );
    assert.ok(
      fila.sub >= fila.base,
      `la línea base superó a los sub-clusters en cross=${fila.cross} q=${fila.probeQ}`,
    );
  }
  // Y donde más se separan las condiciones es donde más se nota.
  const peor = filas.find((f) => f.cross === 0.93 && f.probeQ === MEDIDO.probeCosine.mediocre);
  assert.ok(peor, "falta la fila del caso peor");
  assert.ok(
    peor.sub - peor.base > 0,
    `los sub-clusters deberían ganar algo en el caso peor: ${peor.base} → ${peor.sub}`,
  );
});

test("identify acepta varios descriptores y se queda con el mejor", () => {
  const engine = newEngine();
  const next = rng(505);
  const { conLentes, sinLentes, probeSinLentes } = persona(next);
  engine.enroll("Ana", [
    { label: "con-lentes", samples: conLentes },
    { label: "sin-lentes", samples: sinLentes },
  ]);

  // Una tanda realista de login: capturas mediocres + la buena. Antes se mandaba
  // solo la última (la del parpadeo), que es la peor de la sesión.
  const sigma = sigmaFor(MEDIDO.probeCosine.mediocre);
  const malas = Array.from({ length: 3 }, () => noisySample(probeSinLentes, sigma, next));

  assert.equal(engine.identify([...malas, probeSinLentes]).matched, true);
  const soloUnaMala = engine.identify(malas[0]);
  console.log(
    `login con 4 descriptores: aceptado | solo una captura mediocre: ` +
      `score ${soloUnaMala.score.toFixed(3)} vs umbral ${soloUnaMala.threshold.toFixed(3)}`,
  );
});

test("una plantilla sin `conditions` (vault anterior) sigue identificando", () => {
  const engine = newEngine();
  const next = rng(606);
  const { conLentes, probeConLentes } = persona(next);
  const template = engine.enroll("Vieja", conLentes);

  // Se degrada la plantilla a la forma anterior a los sub-clusters.
  const legacy = template as unknown as Record<string, unknown>;
  legacy.encryptedCentroid = template.conditions[0].encryptedCentroid;
  legacy.encryptedSamples = template.conditions[0].encryptedSamples;
  legacy.conditions = [];

  const decision = engine.identify(probeConLentes);
  assert.equal(decision.matched, true);
  assert.equal(decision.displayName, "Vieja");
  assert.equal(decision.condition, "default");
});

test("atCosine y sigmaFor calibran lo que dicen calibrar", () => {
  const next = rng(707);
  const base = randomUnit(next);
  assert.ok(Math.abs(cosine(base, atCosine(base, 0.7, next)) - 0.7) < 1e-9);
  for (const objetivo of [0.9, 0.96]) {
    const muestras = Array.from({ length: 40 }, () => noisySample(base, sigmaFor(objetivo), next));
    assert.ok(Math.abs(intraStats(muestras).mean - objetivo) < 0.03);
  }
});
