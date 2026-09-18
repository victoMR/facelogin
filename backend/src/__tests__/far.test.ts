/**
 * FAR / FRR y recall del índice con sub-clusters.
 *
 * La pregunta que contestan estos tests: los sub-clusters y la augmentación
 * ensanchan lo que ocupa cada identidad en el espacio. ¿Se paga eso en falsas
 * aceptaciones? Se mide contra la línea base (una sola condición, cinco
 * capturas), no contra una intuición.
 *
 * **Ojo con lo que estos números NO son.** Estos impostores son sintéticos:
 * vectores colocados a un coseno que elegimos nosotros. Sirven para comparar
 * montajes entre sí (¿empeora el FAR al añadir sub-clusters?), y para nada más.
 * El FAR/FPIR de verdad se mide con caras reales en `npm run eval:threshold`, y
 * el test que vigila que no vuelva a subir es `openset.test.ts`. Lo que sí
 * cambió aquí es que los parámetros —anchura de los clusters, separación entre
 * condiciones, bandas de impostor— ya no son inventados: salen de `MEDIDO`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { buildPlanes, lshKeys, lshProbeKeys } from "../lsh.js";
import { meanVector } from "../matcher.js";
import { VaultStore } from "../store.js";
import { DIM, MEDIDO, atCosine, makePersona, noisySample, rng, sigmaFor } from "./synthetic.js";

const KEY = deriveMasterKey("clave-de-prueba");
const SECRET = "secreto-de-prueba";
const PLANES = buildPlanes("semilla-de-prueba", DIM);

function newEngine(): FaceEngine {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-far-")), "vault.json");
  return new FaceEngine(new VaultStore(path), KEY, "semilla-de-prueba", SECRET);
}

const GALLERY = 20;
const IMPOSTORS = 150;

/**
 * Impostores *duros*: no vectores aleatorios (coseno ≈ 0 — los rechaza
 * cualquier cosa y el FAR medido saldría 0 y no diría nada), sino caras a un
 * coseno controlado de alguien de la galería.
 *
 * **Las bandas se remidieron.** Estaban en 0.35–0.55 y 0.55–0.75, y decían ser
 * "donde vive un hermano o un doble en FaceNet-128". Falso: sobre los 6000
 * pares oficiales de LFW, dos personas **cualesquiera** puntúan 0.8370 de
 * media, con p95 0.8915 y máximo 0.9269. Un impostor a coseno 0.45 no existe;
 * lo que se estaba midiendo era el rechazo de vectores que no se parecen a una
 * cara. Las bandas de `MEDIDO.impostor` cubren el rango real: `parecido`
 * 0.84–0.90 (la masa de la distribución) y `extremo` 0.90–0.94 (del p99 al
 * máximo observado y un poco más allá).
 *
 * **Los impostores apuntan SIEMPRE a la condición 0**, que todos los montajes
 * tienen enrolada. Repartirlos entre las dos condiciones regalaría rechazos
 * gratis a la línea base (que nunca enroló la condición 1) y haría creer que los
 * sub-clusters degradan el FAR cuando lo que pasa es que se comparan cosas
 * distintas.
 */
const BANDAS = MEDIDO.impostor;

type Montaje = {
  nombre: string;
  enrolar: (engine: FaceEngine, name: string, p: ReturnType<typeof makePersona>) => void;
  /** Cuántos descriptores manda el cliente en cada login. */
  probesPorLogin: number;
};

type Medicion = {
  farParecido: number;
  farExtremo: number;
  /** Rechazo del dueño entrando en la condición que SÍ enroló. */
  frrMismaCondicion: number;
  /** Rechazo del dueño entrando en la otra condición (el caso de los lentes). */
  frrOtraCondicion: number;
};

function medir(montaje: Montaje, seed: number): Medicion {
  const engine = newEngine();
  const next = rng(seed);
  const personas = Array.from({ length: GALLERY }, (_, i) => {
    const p = makePersona(next, {
      crossCosine: MEDIDO.crossCosine,
      withinCosine: MEDIDO.withinCosine,
      perCondition: 6,
    });
    montaje.enrolar(engine, `Persona ${i}`, p);
    return p;
  });

  const login = (center: number[]) =>
    engine.identify(
      Array.from({ length: montaje.probesPorLogin }, () =>
        // Frame de login nuevo y mediocre: es donde se decide el FRR.
        noisySample(center, sigmaFor(MEDIDO.probeCosine.bueno), next),
      ),
    );

  let misma = 0;
  let otra = 0;
  for (const p of personas) {
    if (!login(p.conditionCenters[0]).matched) misma += 1;
    if (!login(p.conditionCenters[1]).matched) otra += 1;
  }

  // Los impostores salen de un flujo de azar PROPIO, sembrado aparte. Si
  // salieran de `next`, cada montaje consumiría una cantidad distinta de números
  // (1 vs 8 descriptores por login) y compararía contra caras distintas: la
  // diferencia medida sería ruido de muestreo, no efecto del montaje.
  const far = (banda: readonly [number, number], semilla: number) => {
    const impostorRng = rng(semilla);
    let aceptados = 0;
    for (let i = 0; i < IMPOSTORS; i += 1) {
      const victima = personas[i % personas.length];
      const objetivo = banda[0] + (banda[1] - banda[0]) * impostorRng();
      const cara = atCosine(victima.conditionCenters[0], objetivo, impostorRng);
      const probes = Array.from({ length: montaje.probesPorLogin }, () =>
        noisySample(cara, sigmaFor(MEDIDO.withinCosine), impostorRng),
      );
      if (engine.identify(probes).matched) aceptados += 1;
    }
    return aceptados / IMPOSTORS;
  };

  return {
    farParecido: far(BANDAS.parecido, seed + 1),
    farExtremo: far(BANDAS.extremo, seed + 2),
    frrMismaCondicion: misma / personas.length,
    frrOtraCondicion: otra / personas.length,
  };
}

const enrolarSubClusters: Montaje["enrolar"] = (engine, name, p) => {
  engine.enroll(name, [
    { label: "con-lentes", samples: p.samplesByCondition[0].slice(0, 5) },
    { label: "sin-lentes", samples: p.samplesByCondition[1].slice(0, 5) },
  ]);
};

test("FAR/FRR: los sub-clusters bajan el FRR sin degradar el FAR", () => {
  const montajes: Montaje[] = [
    {
      nombre: "línea base  (1 condición × 5,  1 descriptor/login)",
      enrolar: (engine, name, p) => {
        engine.enroll(name, p.samplesByCondition[0].slice(0, 5));
      },
      probesPorLogin: 1,
    },
    {
      nombre: "sub-clusters (2 × 5,           1 descriptor/login)",
      enrolar: enrolarSubClusters,
      probesPorLogin: 1,
    },
    {
      nombre: "sub-clusters (2 × 5,           4 descriptores/login)",
      enrolar: enrolarSubClusters,
      probesPorLogin: 4,
    },
    {
      nombre: "sub-clusters + augmentación (2 × 6, 4 descriptores/login)",
      enrolar: (engine, name, p) => {
        engine.enroll(name, [
          { label: "con-lentes", samples: p.samplesByCondition[0] },
          { label: "sin-lentes", samples: p.samplesByCondition[1] },
        ]);
      },
      probesPorLogin: 4,
    },
  ];

  const resultados = montajes.map((montaje) => ({ nombre: montaje.nombre, ...medir(montaje, 4242) }));

  console.log(`galería de ${GALLERY}, ${IMPOSTORS} impostores por banda:`);
  for (const r of resultados) {
    console.log(
      `  ${r.nombre}\n` +
        `      FAR parecido(${BANDAS.parecido[0]}–${BANDAS.parecido[1]}) ${(r.farParecido * 100).toFixed(2)} % | ` +
        `FAR extremo(${BANDAS.extremo[0]}–${BANDAS.extremo[1]}) ${(r.farExtremo * 100).toFixed(2)} % | ` +
        `FRR misma condición ${(r.frrMismaCondicion * 100).toFixed(1)} % | ` +
        `FRR otra condición ${(r.frrOtraCondicion * 100).toFixed(1)} %`,
    );
  }

  const [base, sub, subMulti, aumentado] = resultados;

  // 1. El caso que motiva todo: entrar en la condición que no se enroló. Con la
  //    separación REAL entre condiciones la línea base ya no falla siempre —eso
  //    era un artefacto del `crossCosine` 0.62 inventado— pero sigue fallando
  //    bastante más que los sub-clusters.
  assert.ok(
    base.frrOtraCondicion > sub.frrOtraCondicion,
    `la línea base debería rechazar más al dueño: ${base.frrOtraCondicion} vs ${sub.frrOtraCondicion}`,
  );
  // Y con la condición enrolada, entrar por ella no es peor que entrar por la
  // propia: es exactamente lo que se compra enrolando las dos.
  assert.ok(
    sub.frrOtraCondicion <= sub.frrMismaCondicion + 0.1,
    `entrar por la otra condición enrolada no debería costar más: ` +
      `${sub.frrMismaCondicion} → ${sub.frrOtraCondicion}`,
  );

  // 2. Y no se paga con FAR. La penalización por separación entre condiciones
  //    (`adaptiveThreshold`) compensa de sobra el espacio extra que ocupan.
  for (const r of [sub, subMulti, aumentado]) {
    assert.ok(
      r.farParecido <= base.farParecido,
      `${r.nombre} subió el FAR de parecidos: ${base.farParecido} → ${r.farParecido}`,
    );
    assert.ok(
      r.farExtremo <= base.farExtremo,
      `${r.nombre} subió el FAR extremo: ${base.farExtremo} → ${r.farExtremo}`,
    );
  }

  // 3. Nadie empeora al dueño en su propia condición.
  for (const r of [sub, subMulti, aumentado]) {
    assert.ok(r.frrMismaCondicion <= base.frrMismaCondicion + 1e-9);
  }
});

test("mandar varios descriptores no abre la puerta: multiProbePenalty compensa el máximo", () => {
  // Mismo enrollo, solo cambia cuántos descriptores manda el cliente. El
  // servidor se queda con el mejor de N: sin penalización, el FAR subiría con N.
  const uno = medir({ nombre: "1", enrolar: enrolarSubClusters, probesPorLogin: 1 }, 909);
  const ocho = medir({ nombre: "8", enrolar: enrolarSubClusters, probesPorLogin: 8 }, 909);
  console.log(
    `descriptores por login → 1: FAR ${(uno.farParecido * 100).toFixed(2)} %/${(uno.farExtremo * 100).toFixed(2)} % ` +
      `FRR ${(uno.frrOtraCondicion * 100).toFixed(1)} % | ` +
      `8: FAR ${(ocho.farParecido * 100).toFixed(2)} %/${(ocho.farExtremo * 100).toFixed(2)} % ` +
      `FRR ${(ocho.frrOtraCondicion * 100).toFixed(1)} %`,
  );
  // Lo que se sostiene: en la banda que importa (por debajo del umbral) mandar 8
  // descriptores no abre nada.
  assert.ok(
    ocho.farParecido <= uno.farParecido + 0.01,
    `mandar 8 descriptores subió el FAR de parecidos: ${uno.farParecido} → ${ocho.farParecido}`,
  );
  assert.ok(ocho.frrOtraCondicion <= uno.frrOtraCondicion);
  // Y en la banda extrema tampoco. Los coeficientes de `multiProbePenalty` ya
  // NO se dimensionan aquí: se midieron con las variantes de augmentación
  // reales sobre LFW (pasar de 1 a 7 descriptores sube el p99 del impostor
  // 0.0039). Este test solo comprueba que mandar más descriptores no abre la
  // puerta. Margen de 3 puntos por ruido de muestreo.
  assert.ok(
    ocho.farExtremo <= uno.farExtremo + 0.03,
    `el FAR extremo subió con 8 descriptores: ${uno.farExtremo} → ${ocho.farExtremo}`,
  );
});

test("recall del LSH con los dos sub-clusters indexados", () => {
  const TRIALS = 300;
  const next = rng(1313);
  let soloPrimera = 0;
  let ambasCondiciones = 0;

  for (let i = 0; i < TRIALS; i += 1) {
    const p = makePersona(next, {
      crossCosine: MEDIDO.crossCosine,
      withinCosine: MEDIDO.withinCosine,
      perCondition: 5,
    });
    const [conLentes, sinLentes] = p.samplesByCondition;
    // Login sin lentes: la condición que NO se indexaría si solo se guardara una.
    const probe = noisySample(p.conditionCenters[1], sigmaFor(MEDIDO.probeCosine.bueno), next);
    const clavesProbe = lshProbeKeys(probe, PLANES, SECRET);

    const indiceUnaCondicion = [
      ...lshKeys(meanVector(conLentes), PLANES, SECRET),
      ...conLentes.flatMap((s) => lshKeys(s, PLANES, SECRET)),
    ];
    const indiceDosCondiciones = [
      ...indiceUnaCondicion,
      ...lshKeys(meanVector(sinLentes), PLANES, SECRET),
      ...sinLentes.flatMap((s) => lshKeys(s, PLANES, SECRET)),
    ];

    const set = new Set(clavesProbe);
    if (indiceUnaCondicion.some((k) => set.has(k))) soloPrimera += 1;
    if (indiceDosCondiciones.some((k) => set.has(k))) ambasCondiciones += 1;
  }

  console.log(
    `recall del índice para un login SIN lentes: solo condición "con lentes" ` +
      `${((soloPrimera / TRIALS) * 100).toFixed(1)} % → ambas condiciones indexadas ` +
      `${((ambasCondiciones / TRIALS) * 100).toFixed(1)} %`,
  );
  // Resultado honesto: el recall NO es donde ganan los sub-clusters. El
  // multi-probe Hamming-1 sobre 10 tablas, indexando ya centroide + cada
  // muestra, satura el recall sin necesidad de la segunda
  // condición. Lo que aporta indexarla es que no se pierde nada al añadirla —
  // la ganancia real de los sub-clusters está en el alta y en el umbral.
  assert.ok(ambasCondiciones / TRIALS > 0.99, `recall insuficiente: ${ambasCondiciones / TRIALS}`);
  assert.ok(
    ambasCondiciones >= soloPrimera,
    "indexar la segunda condición nunca debería bajar el recall",
  );
});

test("el motor indexa cubetas de las dos condiciones y las recupera sin barrido", () => {
  const engine = newEngine();
  const next = rng(1414);
  const p = makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 6,
  });
  // Ruido en la galería para que el barrido completo no sea trivialmente igual.
  for (let i = 0; i < 12; i += 1) {
    const otra = makePersona(next, {
      crossCosine: MEDIDO.crossCosine,
      withinCosine: MEDIDO.withinCosine,
      perCondition: 5,
    });
    engine.enroll(`Otra ${i}`, otra.samplesByCondition[0]);
  }
  engine.enroll("Ana", [
    { label: "con-lentes", samples: p.samplesByCondition[0].slice(0, 5) },
    { label: "sin-lentes", samples: p.samplesByCondition[1].slice(0, 5) },
  ]);

  for (const [indice, etiqueta] of [
    [0, "con-lentes"],
    [1, "sin-lentes"],
  ] as const) {
    const probe = noisySample(p.conditionCenters[indice], sigmaFor(MEDIDO.probeCosine.bueno), next);
    const decision = engine.identify(probe);
    assert.equal(decision.matched, true, `no identificó en ${etiqueta}`);
    assert.equal(decision.displayName, "Ana");
    assert.equal(decision.condition, etiqueta);
    assert.equal(decision.reason, "lsh", `${etiqueta} necesitó barrido completo`);
  }
});

test("MEDIDO contiene los valores calibrados de withinCosine", () => {
  assert.ok(MEDIDO.withinCosine > 0.88);
  assert.ok(MEDIDO.withinCosine < 1);
});

test("MEDIDO contiene los valores calibrados de crossCosine", () => {
  assert.ok(MEDIDO.crossCosine > 0.92);
  assert.ok(MEDIDO.crossCosine < 1);
  // crossCosine puede ser mayor o igual que withinCosine en el límite
  assert.ok(MEDIDO.crossCosine <= MEDIDO.withinCosine + 0.05);
});

test("MEDIDO impostor parecido está en rango realista", () => {
  const [min, max] = MEDIDO.impostor.parecido;
  assert.ok(min >= 0.8 && min <= 0.9);
  assert.ok(max > min && max <= 0.95);
});

test("MEDIDO impostor extremo está por encima de parecido", () => {
  const [minParecido, maxParecido] = MEDIDO.impostor.parecido;
  const [minExtremo, maxExtremo] = MEDIDO.impostor.extremo;
  assert.ok(minExtremo >= maxParecido);
  assert.ok(maxExtremo > minExtremo);
});

test("MEDIDO probeCosine bueno es mayor que mediocre", () => {
  assert.ok(MEDIDO.probeCosine.bueno > MEDIDO.probeCosine.mediocre);
  assert.ok(MEDIDO.probeCosine.bueno > 0.9);
});

test("medir devuelve todas las métricas esperadas", () => {
  const montaje: Montaje = {
    nombre: "test",
    enrolar: (engine, name, p) => engine.enroll(name, p.samplesByCondition[0].slice(0, 5)),
    probesPorLogin: 1,
  };
  const medicion = medir(montaje, 9999);
  assert.ok("farParecido" in medicion);
  assert.ok("farExtremo" in medicion);
  assert.ok("frrMismaCondicion" in medicion);
  assert.ok("frrOtraCondicion" in medicion);
  assert.ok(typeof medicion.farParecido === "number");
});
