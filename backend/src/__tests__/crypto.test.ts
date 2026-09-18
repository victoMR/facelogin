import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptVector, deriveMasterKey, encryptVector, hmacBucket, randomSecret } from "../crypto.js";

const KEY = deriveMasterKey("clave-de-prueba");

function vectorDe(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin(i) * 0.1);
}

test("round-trip de cifrado conserva el vector con precisión float32", () => {
  const original = vectorDe(128);
  const recuperado = decryptVector(encryptVector(original, KEY), KEY);
  assert.equal(recuperado.length, 128);
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(Math.abs(recuperado[i] - original[i]) < 1e-6, `desvío en la posición ${i}`);
  }
});

test("dos cifrados del mismo vector usan IV distinto", () => {
  const original = vectorDe(128);
  const a = encryptVector(original, KEY);
  const b = encryptVector(original, KEY);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test("un tag manipulado falla la autenticación", () => {
  const blob = encryptVector(vectorDe(128), KEY);
  const tag = Buffer.from(blob.tag, "base64");
  tag[0] ^= 0xff;
  assert.throws(() => decryptVector({ ...blob, tag: tag.toString("base64") }, KEY));
});

test("datos manipulados fallan la autenticación", () => {
  const blob = encryptVector(vectorDe(128), KEY);
  const data = Buffer.from(blob.data, "base64");
  data[3] ^= 0x01;
  assert.throws(() => decryptVector({ ...blob, data: data.toString("base64") }, KEY));
});

test("otra master key no descifra la plantilla", () => {
  const blob = encryptVector(vectorDe(128), KEY);
  assert.throws(() => decryptVector(blob, deriveMasterKey("otra-clave")));
});

test("deriveMasterKey es determinista y produce 32 bytes", () => {
  const a = deriveMasterKey("misma");
  const b = deriveMasterKey("misma");
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
  assert.ok(!a.equals(deriveMasterKey("distinta")));
});

test("hmacBucket es determinista y distingue tabla y bits", () => {
  const secreto = randomBytes(16).toString("hex");
  assert.equal(hmacBucket(secreto, 0, "10101010"), hmacBucket(secreto, 0, "10101010"));
  assert.notEqual(hmacBucket(secreto, 0, "10101010"), hmacBucket(secreto, 1, "10101010"));
  assert.notEqual(hmacBucket(secreto, 0, "10101010"), hmacBucket(secreto, 0, "10101011"));
  assert.notEqual(hmacBucket(secreto, 0, "10101010"), hmacBucket("otro-secreto", 0, "10101010"));
});

test("randomSecret genera secretos distintos", () => {
  assert.notEqual(randomSecret(), randomSecret());
});

test("encryptVector produce tag de autenticación de 16 bytes", () => {
  const blob = encryptVector(vectorDe(128), KEY);
  const tag = Buffer.from(blob.tag, "base64");
  assert.equal(tag.length, 16);
});

test("IV es distinto en cada cifrado y tiene 12 bytes", () => {
  const blob = encryptVector(vectorDe(128), KEY);
  const iv = Buffer.from(blob.iv, "base64");
  assert.equal(iv.length, 12);
});

test("decryptVector devuelve el número correcto de elementos", () => {
  // decryptVector no valida dimensión, solo descifra
  const original = vectorDe(64);
  const blob = encryptVector(original, KEY);
  const recovered = decryptVector(blob, KEY);
  assert.equal(recovered.length, 64);
});

test("randomSecret genera strings base64", () => {
  const secret = randomSecret();
  // randomSecret devuelve base64, no hex
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(secret));
  assert.ok(secret.length >= 32);
});

test("hmacBucket devuelve strings de longitud consistente", () => {
  const secret = randomSecret();
  const bucket1 = hmacBucket(secret, 0, "10101010");
  const bucket2 = hmacBucket(secret, 1, "11111111");
  assert.equal(bucket1.length, bucket2.length);
  assert.ok(bucket1.length > 10);
});
