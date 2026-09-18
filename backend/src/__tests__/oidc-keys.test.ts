import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKeyMaterial, jwksOf, loadKeyRing } from "../oidc/keys.js";

test("generatePrivateKeyMaterial genera una clave base64 no vacía", () => {
  const material = generatePrivateKeyMaterial();
  assert.ok(typeof material === "string");
  assert.ok(material.length > 100);
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(material));
});

test("generatePrivateKeyMaterial genera claves distintas en cada llamada", () => {
  const key1 = generatePrivateKeyMaterial();
  const key2 = generatePrivateKeyMaterial();
  assert.notEqual(key1, key2);
});

test("loadKeyRing carga una sola clave", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(material);
  assert.ok(ring.active);
  assert.equal(ring.published.length, 1);
  assert.equal(ring.published[0], ring.active);
});

test("loadKeyRing carga múltiples claves separadas por comas", async () => {
  const key1 = generatePrivateKeyMaterial();
  const key2 = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(`${key1}, ${key2}`);
  assert.equal(ring.published.length, 2);
  assert.equal(ring.active, ring.published[0]);
});

test("loadKeyRing la primera clave es la activa", async () => {
  const key1 = generatePrivateKeyMaterial();
  const key2 = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(`${key1},${key2}`);
  assert.equal(ring.active.kid, ring.published[0].kid);
});

test("loadKeyRing rechaza material vacío", async () => {
  await assert.rejects(async () => {
    await loadKeyRing("");
  }, /vacío/);
});

test("loadKeyRing ignora espacios y entradas vacías", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(`  ${material}  ,  ,  `);
  assert.equal(ring.published.length, 1);
});

test("jwksOf devuelve un objeto con keys", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(material);
  const jwks = jwksOf(ring);
  assert.ok(jwks.keys);
  assert.ok(Array.isArray(jwks.keys));
  assert.equal(jwks.keys.length, 1);
});

test("jwksOf incluye kid, alg y use en cada clave", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(material);
  const jwks = jwksOf(ring);
  const key = jwks.keys[0];
  assert.ok(key.kid);
  assert.equal(key.alg, "RS256");
  assert.equal(key.use, "sig");
});

test("jwksOf NO filtra material privado (d, p, q)", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(material);
  const jwks = jwksOf(ring);
  const key = jwks.keys[0] as any;
  assert.equal(key.d, undefined);
  assert.equal(key.p, undefined);
  assert.equal(key.q, undefined);
});

test("SigningKey incluye privateKey y publicKey", async () => {
  const material = generatePrivateKeyMaterial();
  const ring = await loadKeyRing(material);
  assert.ok(ring.active.privateKey);
  assert.ok(ring.active.publicKey);
});

test("kid es un thumbprint estable por clave", async () => {
  const material = generatePrivateKeyMaterial();
  const ring1 = await loadKeyRing(material);
  const ring2 = await loadKeyRing(material);
  assert.equal(ring1.active.kid, ring2.active.kid);
});
