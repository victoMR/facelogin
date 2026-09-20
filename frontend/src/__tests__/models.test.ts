import assert from "node:assert/strict";
import { test } from "node:test";
import { modelLoadStats, MODEL_URL, resetModelLoadStats } from "../models";

test("MODEL_URL es /models/", () => {
  assert.equal(MODEL_URL, "/models/");
});

test("modelLoadStats devuelve objeto con campos esperados", () => {
  const stats = modelLoadStats();
  assert.ok("fromCache" in stats);
  assert.ok("fromNetwork" in stats);
  assert.ok("bytes" in stats);
  assert.ok("ms" in stats);
});

test("modelLoadStats campos son números", () => {
  const stats = modelLoadStats();
  assert.equal(typeof stats.fromCache, "number");
  assert.equal(typeof stats.fromNetwork, "number");
  assert.equal(typeof stats.bytes, "number");
  assert.equal(typeof stats.ms, "number");
});

test("resetModelLoadStats pone todo a cero", () => {
  resetModelLoadStats();
  const stats = modelLoadStats();
  assert.equal(stats.fromCache, 0);
  assert.equal(stats.fromNetwork, 0);
  assert.equal(stats.bytes, 0);
  assert.equal(stats.ms, 0);
});

test("modelLoadStats devuelve copia, no referencia", () => {
  const stats1 = modelLoadStats();
  const stats2 = modelLoadStats();
  assert.notEqual(stats1, stats2);
});

test("resetModelLoadStats puede llamarse múltiples veces", () => {
  resetModelLoadStats();
  resetModelLoadStats();
  const stats = modelLoadStats();
  assert.equal(stats.fromCache, 0);
});

test("modelLoadStats fromCache no es negativo", () => {
  const stats = modelLoadStats();
  assert.ok(stats.fromCache >= 0);
});

test("modelLoadStats fromNetwork no es negativo", () => {
  const stats = modelLoadStats();
  assert.ok(stats.fromNetwork >= 0);
});

test("modelLoadStats bytes no es negativo", () => {
  const stats = modelLoadStats();
  assert.ok(stats.bytes >= 0);
});

test("modelLoadStats ms no es negativo", () => {
  const stats = modelLoadStats();
  assert.ok(stats.ms >= 0);
});
