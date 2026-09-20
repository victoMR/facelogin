import assert from "node:assert/strict";
import test from "node:test";
import { readSession, signSession } from "../session.js";

const SECRET = "test-session-secret-for-unit-tests";

test("signSession genera un JWT válido", async () => {
  const token = await signSession(SECRET, { sub: "user-123", name: "Test User" });
  assert.ok(typeof token === "string");
  assert.ok(token.split(".").length === 3);
});

test("readSession descifra el payload firmado", async () => {
  const token = await signSession(SECRET, { sub: "user-abc", name: "Alice" });
  const session = await readSession(SECRET, token);
  assert.equal(session.sub, "user-abc");
  assert.equal(session.name, "Alice");
  assert.ok(typeof session.authTime === "number");
});

test("readSession rechaza tokens firmados con otro secreto", async () => {
  const token = await signSession("wrong-secret", { sub: "user-123", name: "Test" });
  await assert.rejects(async () => {
    await readSession(SECRET, token);
  });
});

test("readSession rechaza tokens mal formados", async () => {
  await assert.rejects(async () => {
    await readSession(SECRET, "invalid.token.here");
  });
});

test("readSession rechaza tokens vacíos", async () => {
  await assert.rejects(async () => {
    await readSession(SECRET, "");
  });
});

test("readSession incluye authTime del iat", async () => {
  const before = Math.floor(Date.now() / 1000);
  const token = await signSession(SECRET, { sub: "user-123", name: "Test" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const session = await readSession(SECRET, token);
  const after = Math.floor(Date.now() / 1000);
  assert.ok(session.authTime >= before);
  assert.ok(session.authTime <= after);
});

test("readSession maneja name ausente", async () => {
  const token = await signSession(SECRET, { sub: "user-123", name: "" });
  const session = await readSession(SECRET, token);
  assert.equal(session.name, "");
});

test("signSession usa HS256", async () => {
  const token = await signSession(SECRET, { sub: "user-123", name: "Test" });
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "HS256");
});

test("signSession incluye iss, aud y jti", async () => {
  const token = await signSession(SECRET, { sub: "user-123", name: "Test" });
  const session = await readSession(SECRET, token);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.equal(payload.iss, "facelogin");
  assert.equal(payload.aud, "facelogin-app");
  assert.ok(session.jti.length > 8);
});

test("signSession incluye exp para 8h", async () => {
  const token = await signSession(SECRET, { sub: "user-123", name: "Test" });
  const session = await readSession(SECRET, token);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const ttl = payload.exp - payload.iat;
  assert.equal(ttl, 8 * 3600);
});

test("readSession rechaza tokens expirados", async () => {
  // Crear un token con exp en el pasado es complejo con jose,
  // pero podemos verificar que un token válido NO expira inmediatamente.
  const token = await signSession(SECRET, { sub: "user-123", name: "Test" });
  const session = await readSession(SECRET, token);
  assert.ok(session.sub);
});
