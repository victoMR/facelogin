import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { adaptiveThreshold, clampThreshold, cosine, l2Normalize, storedSamplesPenalty } from "../matcher.js";
import { VaultStore } from "../store.js";

const DIM = 128;
const KEY = deriveMasterKey("clave-de-prueba");

function basis(index: number): number[] {
  const vector = new Array<number>(DIM).fill(0);
  vector[index] = 1;
  return vector;
}

function combine(parts: Array<[number, number]>): number[] {
  const vector = new Array<number>(DIM).fill(0);
  for (const [index, weight] of parts) vector[index] += weight;
  return vector;
}

function newEngine(): { engine: FaceEngine; store: VaultStore } {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-engine-")), "vault.json");
  const store = new VaultStore(path);
  return { engine: new FaceEngine(store, KEY, "semilla-de-prueba", "secreto-de-prueba"), store };
}

/** n muestras con coseno par a par exactamente `c`: intraMean = c, intraStd = 0. */
function cluster(anchor: number, c: number, count: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    l2Normalize(combine([
      [anchor, Math.sqrt(c)],
      [anchor + 1 + i, Math.sqrt(1 - c)],
    ])),
  );
}

/**
 * Lo mismo pero alrededor de una dirección arbitraria, dispersando en
 * dimensiones frescas a partir de `spreadFrom`. Hace falta desde que el alta
 * exige `intraMean ≥ 0.88`: ya no se pueden montar dos identidades con clusters
 * laxos en ejes ortogonales, porque esos enrollos ahora se rechazan.
 */
function clusterAround(center: number[], c: number, count: number, spreadFrom: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    l2Normalize(center.map((value, k) => value * Math.sqrt(c) + (k === spreadFrom + i ? Math.sqrt(1 - c) : 0))),
  );
}

test("un segundo enrollo de la misma cara se rechaza", () => {
  const { engine } = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  try {
    engine.enroll("Ana otra vez", cluster(0, 0.97, 5));
    assert.fail("debía rechazar el duplicado");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 409);
    assert.match(error.message, /ya está registrada/i);
  }
});

test("dos caras distintas sí pueden enrolarse", () => {
  const { engine, store } = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  engine.enroll("Luis", cluster(60, 0.97, 5));
  assert.equal(store.all().length, 2);
});

test("identify reconoce a la identidad enrolada y rechaza a una desconocida", () => {
  const { engine } = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));

  const genuino = l2Normalize(combine([[0, 0.95], [40, Math.sqrt(1 - 0.95 ** 2)]]));
  const propio = engine.identify(genuino);
  assert.equal(propio.matched, true);
  assert.equal(propio.displayName, "Ana");

  const extraño = engine.identify(basis(90));
  assert.equal(extraño.matched, false);
  assert.equal(extraño.identityId, null);
});

test("el mejor candidato se elige por margen, no por score bruto", () => {
  const { engine } = newEngine();
  // El montaje anterior usaba un cluster de coseno interno 0.63, que el alta ya
  // no acepta (`intraMean ≥ 0.88`). Ahora los dos enrollos son legítimos y la
  // diferencia de umbral sale de la cobertura: Apretada 0.99, Laxa 0.90. Los
  // dos centros están a coseno 0.86 entre sí para que un mismo probe pueda
  // puntuar alto contra ambos; con ejes ortogonales eso ya no es posible, porque
  // en la escala nueva los dos scores tendrían que sumar más de 1.
  const A = basis(0);
  const B = l2Normalize(combine([[0, 0.86], [50, Math.sqrt(1 - 0.86 ** 2)]]));
  engine.enroll("Apretada", clusterAround(A, 0.99, 5, 1));
  engine.enroll("Laxa", clusterAround(B, 0.9, 5, 10));

  const umbralApretada = clampThreshold(adaptiveThreshold(0.99, 0, 2) + storedSamplesPenalty(5));
  const umbralLaxa = clampThreshold(adaptiveThreshold(0.9, 0, 2) + storedSamplesPenalty(5));
  assert.ok(umbralLaxa > umbralApretada, "el montaje requiere umbrales distintos por persona");

  // Probe entre las dos: puntúa ~0.945 contra Apretada y ~0.955 contra Laxa.
  const probe = l2Normalize(
    combine([[0, 0.94595], [50, 0.29777], [51, Math.sqrt(1 - 0.94595 ** 2 - 0.29777 ** 2)]]),
  );
  const decision = engine.identify(probe);

  assert.equal(decision.matched, true);
  assert.equal(decision.displayName, "Apretada");
  assert.ok(decision.score > decision.threshold);

  // Elegir por score bruto habría devuelto Laxa y rechazado el login: su score
  // es mayor, pero no llega a SU umbral.
  const centroLaxa = l2Normalize(
    clusterAround(B, 0.9, 5, 10).reduce((acc, s) => acc.map((v, i) => v + s[i]), new Array<number>(DIM).fill(0)),
  );
  const contraLaxa = cosine(probe, centroLaxa);
  assert.ok(contraLaxa > decision.score, `Laxa debería tener el score bruto mayor: ${contraLaxa} vs ${decision.score}`);
  assert.ok(contraLaxa < umbralLaxa, `Laxa no debería pasar su umbral: ${contraLaxa} vs ${umbralLaxa}`);
});

test("el barrido completo entra aunque el índice devuelva candidatos que no pasan su umbral", () => {
  const { engine, store } = newEngine();
  engine.enroll("Señuelo", cluster(60, 0.9, 5));
  const ana = engine.enroll("Ana", cluster(0, 0.97, 5));

  // Colisión de cubeta: todas las cubetas apuntan solo al señuelo, así que el
  // índice devuelve una lista NO vacía sin Ana dentro.
  const vault = store.load();
  for (const key of Object.keys(vault.buckets)) vault.buckets[key] = [vault.templates[0].id];
  store.save(vault);

  const decision = engine.identify(l2Normalize(combine([[0, 0.95], [40, Math.sqrt(1 - 0.95 ** 2)]])));
  assert.equal(decision.matched, true);
  assert.equal(decision.identityId, ana.id);
  assert.equal(decision.reason, "fallback-full-scan");
});

test("enroll rechaza capturas que no forman cluster", () => {
  const { engine } = newEngine();
  assert.throws(
    () => engine.enroll("Ruido", [basis(0), basis(1), basis(2), basis(3)]),
    /misma persona/,
  );
});

test("enroll rechaza descriptores con dimensión equivocada", () => {
  const { engine } = newEngine();
  assert.throws(() => engine.enroll("Corta", [[1, 0], [1, 0], [1, 0], [1, 0]]), /128 dimensiones/);
});

test("enroll indexa centroide y muestras en el mismo conjunto de cubetas", () => {
  const { engine } = newEngine();
  // 0.8 de coseno interno ya no pasa el alta: el gate subió a 0.88 porque cinco
  // fotos de cinco personas distintas dan hasta 0.87.
  const template = engine.enroll("Ana", cluster(0, 0.95, 5));
  // 10 tablas por el centroide + las de cada muestra, sin duplicados.
  assert.ok(template.lshKeys.length > 10, `solo se indexó el centroide: ${template.lshKeys.length}`);
  assert.equal(new Set(template.lshKeys).size, template.lshKeys.length);
});

test("una galería vacía rechaza sin reventar", () => {
  const { engine } = newEngine();
  const decision = engine.identify(basis(0));
  assert.equal(decision.matched, false);
  assert.equal(decision.reason, "empty-gallery");
  assert.equal(decision.candidates, 0);
});

test("identify devuelve latencyMs positivo", () => {
  const { engine } = newEngine();
  engine.enroll("Test", cluster(0, 0.97, 5));
  const decision = engine.identify(basis(0));
  assert.ok(decision.latencyMs >= 0);
  assert.ok(typeof decision.latencyMs === "number");
});

test("enroll asigna un id único a cada template", () => {
  const { engine } = newEngine();
  const t1 = engine.enroll("Ana", cluster(0, 0.97, 5));
  const t2 = engine.enroll("Beto", cluster(10, 0.97, 5));
  assert.notEqual(t1.id, t2.id);
  assert.ok(t1.id.length > 0);
  assert.ok(t2.id.length > 0);
});

test("identify rechaza descriptores mal dimensionados", () => {
  const { engine } = newEngine();
  engine.enroll("Test", cluster(0, 0.97, 5));
  assert.throws(() => engine.identify([[1, 2, 3]]), /128 dimensiones/);
});

function shape(seed: number): number[] {
  return l2Normalize(Array.from({ length: 64 }, (_, i) => Math.sin(seed + i * 0.17)));
}

test("enroll guarda la firma 3D cifrada, no una foto", () => {
  const { engine } = newEngine();
  const template = engine.enroll("Ana", cluster(0, 0.97, 5), shape(1));
  assert.ok(template.encryptedShape);
  assert.ok(template.encryptedShape.iv);
  assert.ok(template.encryptedShape.data);
  assert.equal("photo" in template, false);
});

test("identify acepta la misma malla y rechaza otra geometría", () => {
  const { engine } = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5), shape(1));
  const probe = l2Normalize(combine([[0, 0.95], [40, Math.sqrt(1 - 0.95 ** 2)]]));
  assert.equal(engine.identify(probe, shape(1)).matched, true);
  assert.equal(engine.identify(probe, shape(9)).matched, false);
});

test("identify sin malla sigue funcionando en plantillas viejas", () => {
  const { engine } = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const probe = l2Normalize(combine([[0, 0.95], [40, Math.sqrt(1 - 0.95 ** 2)]]));
  assert.equal(engine.identify(probe).matched, true);
});
