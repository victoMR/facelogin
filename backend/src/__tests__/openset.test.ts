/**
 * **La regresión que no puede volver.**
 *
 * En producción entró una persona que no estaba enrolada. La causa fue un
 * umbral calibrado con vectores sintéticos: con la calibración anterior (base
 * 0.52, techo 0.72) el FPIR medido sobre caras reales era del **100 %** — los
 * 1500 desconocidos probados fueron aceptados, todos.
 *
 * Este test recalcula el FPIR con descriptores REALES contra las constantes que
 * estén vigentes en `matcher.ts`. Si alguien vuelve a bajar el umbral, el
 * fallo sale aquí y no en producción.
 *
 * El fixture (`fixtures/lfw-openset.json`) lo genera `npm run eval:threshold` a
 * partir de LFW: 30 identidades con 5 capturas de enrollo y 2 de login
 * retenidas, más 400 personas que aparecen **una sola vez en todo el dataset** y
 * por tanto no pueden estar en la galería. Son descriptores de 128-d crudos,
 * los mismos que produce el navegador; el motor los normaliza él.
 *
 * No se descarga nada al correr `npm test`: el fixture está commiteado.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { BASE_COSINE_THRESHOLD } from "../matcher.js";
import { VaultStore } from "../store.js";

type Fixture = {
  origen: string;
  muestrasPorIdentidad: number;
  identidades: { nombre: string; enrollo: number[][]; probes: number[][] }[];
  desconocidos: number[][];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture: Fixture = JSON.parse(
  readFileSync(join(HERE, "fixtures", "lfw-openset.json"), "utf8"),
);

/**
 * Objetivo de diseño. Se elige por FPIR y no por EER porque en autenticación un
 * falso positivo entrega la cuenta y un falso rechazo solo obliga a reintentar.
 * Con 400 desconocidos, 1 aceptación son 0.25 %: el margen que se tolera aquí.
 */
const FPIR_OBJETIVO = 0.0025;

/**
 * TPIR mínimo, por tamaño de galería. Son dos escenarios distintos y conviene
 * no mezclarlos:
 *
 * - **3 identidades** es lo que tiene este producto (el vault de producción
 *   tenía 3). Ahí el margen de identificación apenas suma y el umbral queda en
 *   ~0.957: el dueño entra siempre.
 * - **30 identidades** es un caso de estrés. El margen empuja el umbral contra
 *   el techo de 0.96 y el TPIR baja a ~88 %. Es el precio elegido a
 *   sabiendas: a 0.96 el FPIR es 0.067 % y a 0.95 sube a 0.20 %, y en este
 *   sistema un desconocido dentro cuesta mucho más que un reintento.
 *
 * Los probes del fixture son fotos de LFW tomadas en momentos y sitios
 * distintos del enrollo, que es el caso difícil; un login real ocurre con la
 * misma cámara y luz parecida y puntúa más alto.
 */
const TPIR_MINIMO = { 3: 0.95, 30: 0.85 } as const;

function nuevoMotor(): FaceEngine {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-openset-")), "vault.json");
  return new FaceEngine(
    new VaultStore(path),
    deriveMasterKey("clave-de-prueba"),
    "semilla-de-prueba",
    "secreto-de-prueba",
  );
}

function medir(tamano: 3 | 30) {
  const engine = nuevoMotor();
  const identidades = fixture.identidades.slice(0, tamano);
  const nombrePorId = new Map<string, string>();
  for (const identidad of identidades) {
    const template = engine.enroll(identidad.nombre, identidad.enrollo);
    nombrePorId.set(template.id, identidad.nombre);
  }

  const aceptados = fixture.desconocidos.filter((probe) => engine.identify(probe).matched).length;
  let aciertos = 0;
  let intentos = 0;
  for (const identidad of identidades) {
    for (const probe of identidad.probes) {
      intentos += 1;
      const decision = engine.identify(probe);
      if (decision.matched && nombrePorId.get(decision.identityId ?? "") === identidad.nombre) {
        aciertos += 1;
      }
    }
  }
  return {
    aceptados,
    fpir: aceptados / fixture.desconocidos.length,
    tpir: aciertos / intentos,
    intentos,
  };
}

for (const tamano of [3, 30] as const) {
  test(`FPIR sobre caras reales, galería de ${tamano}: un desconocido no empareja con nadie`, () => {
    const r = medir(tamano);
    console.log(
      `LFW, galería ${tamano} · ${r.intentos} logins del dueño · ` +
        `${fixture.desconocidos.length} desconocidos → ` +
        `FPIR ${(r.fpir * 100).toFixed(3)} % (${r.aceptados} aceptados)  ` +
        `TPIR ${(r.tpir * 100).toFixed(2)} %  (base ${BASE_COSINE_THRESHOLD})`,
    );

    assert.ok(
      r.fpir <= FPIR_OBJETIVO,
      `FPIR ${(r.fpir * 100).toFixed(3)} % por encima del objetivo ` +
        `${(FPIR_OBJETIVO * 100).toFixed(3)} %: ${r.aceptados} desconocidos de ` +
        `${fixture.desconocidos.length} entraron como si fueran alguien de la galería. ` +
        "Es exactamente el fallo que provocó el incidente; no bajes el umbral sin " +
        "volver a correr `npm run eval:threshold`.",
    );
    assert.ok(
      r.tpir >= TPIR_MINIMO[tamano],
      `TPIR ${(r.tpir * 100).toFixed(2)} % por debajo de ${TPIR_MINIMO[tamano] * 100} %: ` +
        "el umbral subió tanto que ya rechaza al dueño.",
    );
  });
}

test("la calibración anterior habría dejado entrar a todos los desconocidos", () => {
  // No se puede volver a instanciar el motor con otras constantes, así que se
  // reproduce a mano lo único que hacía falta: el score máximo contra la
  // galería. Si ese score supera el umbral que tenía producción
  // (`thresholdAtEnroll` = 0.5773, leído del vault), el desconocido entra.
  const UMBRAL_DE_PRODUCCION = 0.5772533624634173;
  const l2 = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const galeria = fixture.identidades.flatMap((i) => i.enrollo.map(l2));
  const scores = fixture.desconocidos.map((probe) => {
    const p = l2(probe);
    let best = -1;
    for (const v of galeria) {
      let sum = 0;
      for (let i = 0; i < p.length; i += 1) sum += p[i] * v[i];
      if (sum > best) best = sum;
    }
    return best;
  });
  const entraban = scores.filter((s) => s >= UMBRAL_DE_PRODUCCION).length;
  const peor = Math.min(...scores);
  console.log(
    `con el umbral de producción (${UMBRAL_DE_PRODUCCION.toFixed(4)}) entraban ` +
      `${entraban}/${scores.length} desconocidos; el que MENOS puntuaba sacaba ${peor.toFixed(4)}`,
  );
  assert.equal(entraban, scores.length);
  // Y no por poco: hasta el desconocido peor puntuado saca más de 0.75.
  assert.ok(peor > 0.75, `el peor desconocido sacaba ${peor}`);
});

test("el fixture contiene las 30 identidades esperadas", () => {
  assert.equal(fixture.identidades.length, 30);
  for (const id of fixture.identidades) {
    assert.ok(id.nombre.length > 0);
    assert.ok(id.enrollo.length > 0);
    assert.ok(id.probes.length > 0);
  }
});

test("cada identidad tiene exactamente 5 enrollos y 2 probes", () => {
  for (const id of fixture.identidades) {
    assert.equal(id.enrollo.length, 5, `${id.nombre} debe tener 5 enrollos`);
    assert.equal(id.probes.length, 2, `${id.nombre} debe tener 2 probes`);
  }
});

test("los desconocidos son 400 personas distintas", () => {
  assert.equal(fixture.desconocidos.length, 400);
});

test("todos los descriptores son vectores de 128 dimensiones", () => {
  for (const id of fixture.identidades) {
    for (const vec of id.enrollo) assert.equal(vec.length, 128);
    for (const vec of id.probes) assert.equal(vec.length, 128);
  }
  for (const vec of fixture.desconocidos) assert.equal(vec.length, 128);
});

test("los descriptores no están normalizados en el fixture", () => {
  const l2norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  const primer = fixture.identidades[0].enrollo[0];
  const norm = l2norm(primer);
  assert.ok(Math.abs(norm - 1) > 0.01, "los descriptores crudos no deberían estar ya normalizados");
});

test("galería de 3 identidades tiene mejor TPIR que galería de 30", () => {
  const r3 = medir(3);
  const r30 = medir(30);
  console.log(`TPIR: galería 3 = ${(r3.tpir * 100).toFixed(2)}%, galería 30 = ${(r30.tpir * 100).toFixed(2)}%`);
  assert.ok(r3.tpir >= r30.tpir, "galería pequeña debería tener mejor o igual TPIR");
});

test("BASE_COSINE_THRESHOLD está por encima del umbral de producción", () => {
  const UMBRAL_DE_PRODUCCION = 0.5772533624634173;
  assert.ok(BASE_COSINE_THRESHOLD > UMBRAL_DE_PRODUCCION);
  assert.ok(BASE_COSINE_THRESHOLD > 0.9, "el umbral base debería ser bastante alto");
});

test("el fixture origen es LFW", () => {
  assert.match(fixture.origen, /LFW/i);
});

test("cada identidad del fixture tiene nombre único", () => {
  const nombres = fixture.identidades.map((i) => i.nombre);
  const unicos = new Set(nombres);
  assert.equal(unicos.size, nombres.length, "todos los nombres deben ser únicos");
});
