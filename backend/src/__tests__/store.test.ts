import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VaultCorruptError, VaultStore } from "../store.js";
import type { FaceTemplate, VaultFile } from "../types.js";

function tempVaultPath(): string {
  return join(mkdtempSync(join(tmpdir(), "facelogin-store-")), "vault.json");
}

function fakeTemplate(id: string): FaceTemplate {
  return {
    id,
    displayName: `Identidad ${id}`,
    createdAt: new Date().toISOString(),
    conditions: [
      {
        label: "default",
        encryptedCentroid: { iv: "aXY=", data: "ZGF0YQ==", tag: "dGFn" },
        encryptedSamples: [{ iv: "aXY=", data: "ZGF0YQ==", tag: "dGFn" }],
        intraMean: 0.9,
        intraStd: 0.02,
      },
    ],
    lshKeys: [`k1-${id}`, `k2-${id}`],
    intraMean: 0.9,
    intraStd: 0.02,
    interConditionCosine: null,
    thresholdAtEnroll: 0.58,
  };
}

test("un vault ausente arranca vacío (ENOENT es legítimo)", () => {
  const store = new VaultStore(tempVaultPath());
  assert.deepEqual(store.all(), []);
});

test("un JSON corrupto lanza error y NO devuelve un vault vacío", () => {
  const path = tempVaultPath();
  writeFileSync(path, '{"version":1,"templates":[');
  const store = new VaultStore(path);
  assert.throws(() => store.all(), VaultCorruptError);
});

test("una versión desconocida lanza error", () => {
  const path = tempVaultPath();
  writeFileSync(path, JSON.stringify({ version: 99, templates: [], buckets: {} }));
  const store = new VaultStore(path);
  assert.throws(() => store.all(), VaultCorruptError);
});

test("una estructura sin templates o sin buckets lanza error", () => {
  const sinTemplates = tempVaultPath();
  writeFileSync(sinTemplates, JSON.stringify({ version: 1, buckets: {} }));
  assert.throws(() => new VaultStore(sinTemplates).all(), VaultCorruptError);

  const sinBuckets = tempVaultPath();
  writeFileSync(sinBuckets, JSON.stringify({ version: 1, templates: [] }));
  assert.throws(() => new VaultStore(sinBuckets).all(), VaultCorruptError);
});

test("un vault corrupto NO se sobrescribe al enrolar: las identidades no se pierden", () => {
  const path = tempVaultPath();
  const corrupto = '{"version":1,"templates":[{"id":"a-medio-escribir"';
  writeFileSync(path, corrupto);
  const store = new VaultStore(path);
  assert.throws(() => store.upsert(fakeTemplate("nuevo"), ["k1-nuevo"]), VaultCorruptError);
  assert.equal(readFileSync(path, "utf8"), corrupto);
});

test("save es atómico: escribe en .tmp, renombra y no deja residuo", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["k1-uno"]);
  assert.equal(existsSync(`${path}.tmp`), false);
  const written = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  assert.equal(written.templates.length, 1);
  assert.deepEqual(written.buckets["k1-uno"], ["uno"]);
});

test("si la escritura temporal falla, el vault previo queda intacto", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["k1-uno"]);
  const original = readFileSync(path, "utf8");

  const circular = { version: 1, templates: [], buckets: {} } as unknown as Record<string, unknown>;
  circular.self = circular;
  assert.throws(() => store.save(circular as unknown as VaultFile));
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("la caché evita releer disco y se invalida en cada save", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["k1-uno"]);

  // Escritura externa: la caché sigue mandando dentro del proceso.
  writeFileSync(path, JSON.stringify({ version: 1, templates: [], buckets: {} }));
  assert.equal(store.all().length, 1);

  store.upsert(fakeTemplate("dos"), ["k1-dos"]);
  assert.equal(store.all().length, 2);
  const written = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  assert.equal(written.templates.length, 2);
});

test("clear vacía disco y caché", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["k1-uno"]);
  assert.equal(store.all().length, 1);
  store.clear();
  assert.equal(store.all().length, 0);
  const written = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  assert.deepEqual(written.templates, []);
});

test("candidates devuelve solo las identidades de las cubetas consultadas", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["k1-uno", "compartida"]);
  store.upsert(fakeTemplate("dos"), ["k1-dos", "compartida"]);

  assert.deepEqual(store.candidates(["k1-uno"]).map((t) => t.id), ["uno"]);
  assert.deepEqual(store.candidates(["compartida"]).map((t) => t.id).sort(), ["dos", "uno"]);
  assert.deepEqual(store.candidates(["inexistente"]), []);
});

test("reenrolar la misma id no deja cubetas huérfanas", () => {
  const path = tempVaultPath();
  const store = new VaultStore(path);
  store.upsert(fakeTemplate("uno"), ["vieja"]);
  store.upsert(fakeTemplate("uno"), ["nueva"]);
  assert.equal(store.all().length, 1);
  assert.deepEqual(store.candidates(["vieja"]), []);
  assert.deepEqual(store.candidates(["nueva"]).map((t) => t.id), ["uno"]);
});
