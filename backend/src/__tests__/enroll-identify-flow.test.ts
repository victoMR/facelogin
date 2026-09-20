import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { VaultStore } from "../store.js";
import { makePersona, MEDIDO, rng } from "./synthetic.js";

const KEY = deriveMasterKey("clave-de-prueba-flow");

function newEngine(): { engine: FaceEngine; store: VaultStore } {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-flow-")), "vault.json");
  const store = new VaultStore(path);
  return { engine: new FaceEngine(store, KEY, "semilla-flow", "secreto-flow"), store };
}

test("regression: enroll → identify con descriptores sintéticos realistas debe funcionar", () => {
  const { engine } = newEngine();

  // Generar persona con muestras realistas (coseno 0.96 intra-condición, típico de LFW)
  const next = rng(12345);
  const persona = makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 6, // 6 muestras de enrollo
    conditionCount: 1,
  });

  const enrollSamples = persona.samplesByCondition[0].slice(0, 5);

  // Enrollar
  const template = engine.enroll("Usuario Test", enrollSamples);
  assert.ok(template.id);
  assert.equal(template.displayName, "Usuario Test");

  // Usar la 6ta muestra como probe de login (de la misma persona, no usada en enrollo)
  const loginProbe = persona.samplesByCondition[0][5];

  const decision = engine.identify([loginProbe]);

  // El match DEBE funcionar
  assert.equal(decision.matched, true, `Login falló: matched=${decision.matched}, reason=${decision.reason}`);
  assert.equal(decision.identityId, template.id);
  assert.equal(decision.displayName, "Usuario Test");
  assert.ok(decision.score >= decision.threshold, 
    `Score ${decision.score.toFixed(4)} por debajo del umbral ${decision.threshold.toFixed(4)}`);
});

test("enroll con multi-condición (con/sin lentes) permite identificar en ambas", () => {
  const { engine } = newEngine();

  const next = rng(54321);
  const persona = makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 6,
    conditionCount: 2, // Dos condiciones: con/sin lentes
  });

  const conLentes = persona.samplesByCondition[0].slice(0, 5);
  const sinLentes = persona.samplesByCondition[1].slice(0, 5);

  const template = engine.enroll("Usuario Multi", [
    { label: "con-lentes", samples: conLentes },
    { label: "sin-lentes", samples: sinLentes }
  ]);

  assert.equal(template.conditions.length, 2);

  // Identificar con descriptor de la primera condición (no usado en enrollo)
  const probe1 = persona.samplesByCondition[0][5];
  const decision1 = engine.identify([probe1]);
  assert.equal(decision1.matched, true, "Debe identificar con primera condición");
  assert.equal(decision1.identityId, template.id);

  // Identificar con descriptor de la segunda condición (no usado en enrollo)
  const probe2 = persona.samplesByCondition[1][5];
  const decision2 = engine.identify([probe2]);
  assert.equal(decision2.matched, true, "Debe identificar con segunda condición");
  assert.equal(decision2.identityId, template.id);
});

test("impostor no debe pasar la identificación", () => {
  const { engine } = newEngine();

  const next = rng(99999);
  const persona1 = makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 5,
    conditionCount: 1,
  });

  engine.enroll("Usuario Legítimo", persona1.samplesByCondition[0]);

  // Intentar identificar con un impostor (persona completamente diferente)
  const persona2 = makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 1,
    conditionCount: 1,
  });
  const impostor = persona2.samplesByCondition[0][0];
  const decision = engine.identify([impostor]);

  assert.equal(decision.matched, false, "Impostor NO debe pasar");
  assert.equal(decision.identityId, null);
});

test("múltiples usuarios enrolados: identify debe elegir el correcto", () => {
  const { engine } = newEngine();

  // Enrollar 3 usuarios diferentes
  const users = ["Ana", "Bob", "Carlos"];
  const next = rng(77777);
  const personas = users.map(() => makePersona(next, {
    crossCosine: MEDIDO.crossCosine,
    withinCosine: MEDIDO.withinCosine,
    perCondition: 6,
    conditionCount: 1,
  }));

  const templates = users.map((name, idx) => {
    const samples = personas[idx].samplesByCondition[0].slice(0, 5);
    return engine.enroll(name, samples);
  });

  // Identificar a cada uno con muestra no usada en enrollo
  for (let idx = 0; idx < users.length; idx++) {
    const probe = personas[idx].samplesByCondition[0][5];
    const decision = engine.identify([probe]);

    assert.equal(decision.matched, true, `${users[idx]} debe ser identificado`);
    assert.equal(decision.identityId, templates[idx].id);
    assert.equal(decision.displayName, users[idx]);
  }
});
