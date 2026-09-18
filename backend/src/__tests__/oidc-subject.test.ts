import assert from "node:assert/strict";
import test from "node:test";
import { pairwiseSubject } from "../oidc/subject.js";

const SALT = Buffer.from("test-salt-for-pairwise").toString("base64");

test("pairwiseSubject genera un sub opaco", () => {
  const sub = pairwiseSubject(SALT, "client-a", "identity-123");
  assert.ok(typeof sub === "string");
  assert.ok(sub.length > 20);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(sub));
});

test("pairwiseSubject es estable para los mismos inputs", () => {
  const sub1 = pairwiseSubject(SALT, "client-a", "identity-123");
  const sub2 = pairwiseSubject(SALT, "client-a", "identity-123");
  assert.equal(sub1, sub2);
});

test("pairwiseSubject es distinto por cliente", () => {
  const sub1 = pairwiseSubject(SALT, "client-a", "identity-123");
  const sub2 = pairwiseSubject(SALT, "client-b", "identity-123");
  assert.notEqual(sub1, sub2);
});

test("pairwiseSubject es distinto por identidad", () => {
  const sub1 = pairwiseSubject(SALT, "client-a", "identity-123");
  const sub2 = pairwiseSubject(SALT, "client-a", "identity-456");
  assert.notEqual(sub1, sub2);
});

test("pairwiseSubject es distinto por salt", () => {
  const salt2 = Buffer.from("other-salt").toString("base64");
  const sub1 = pairwiseSubject(SALT, "client-a", "identity-123");
  const sub2 = pairwiseSubject(salt2, "client-a", "identity-123");
  assert.notEqual(sub1, sub2);
});

test("pairwiseSubject maneja sector_identifier", () => {
  const sub1 = pairwiseSubject(SALT, "shared-sector", "identity-123");
  const sub2 = pairwiseSubject(SALT, "shared-sector", "identity-123");
  assert.equal(sub1, sub2);
});

test("pairwiseSubject previene colisiones de concatenación", () => {
  // "ab" + "c" vs "a" + "bc" deben producir subs distintos
  const sub1 = pairwiseSubject(SALT, "ab", "c");
  const sub2 = pairwiseSubject(SALT, "a", "bc");
  assert.notEqual(sub1, sub2);
});

test("pairwiseSubject maneja strings vacíos", () => {
  const sub1 = pairwiseSubject(SALT, "", "identity-123");
  const sub2 = pairwiseSubject(SALT, "client", "");
  assert.ok(sub1.length > 0);
  assert.ok(sub2.length > 0);
  assert.notEqual(sub1, sub2);
});

test("pairwiseSubject maneja caracteres especiales", () => {
  const sub = pairwiseSubject(SALT, "client/with:special@chars", "identity:456/test");
  assert.ok(sub.length > 0);
});

test("pairwiseSubject es base64url seguro", () => {
  const sub = pairwiseSubject(SALT, "client-a", "identity-123");
  assert.ok(!sub.includes("+"));
  assert.ok(!sub.includes("/"));
  assert.ok(!sub.includes("="));
});
