import assert from "node:assert/strict";
import test from "node:test";
import { OidcStore } from "../oidc/store.js";

function newStore(codeTtl = 60_000, requestTtl = 600_000, replayWindow = 600_000): OidcStore {
  return new OidcStore(requestTtl, codeTtl, replayWindow);
}

test("createRequest genera un id opaco", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test-client",
    clientName: "Test Client",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: "state123",
    nonce: "nonce456",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  assert.ok(request.id);
  assert.ok(request.id.length > 10);
});

test("readRequest devuelve el request creado", () => {
  const store = newStore();
  const created = store.createRequest({
    clientId: "test-client",
    clientName: "Test Client",
    redirectUri: "https://example.com/cb",
    scopes: ["openid", "profile"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const read = store.readRequest(created.id);
  assert.ok(read);
  assert.equal(read.clientId, "test-client");
  assert.deepEqual(read.scopes, ["openid", "profile"]);
});

test("readRequest devuelve null para id inexistente", () => {
  const store = newStore();
  const read = store.readRequest("non-existent-id");
  assert.equal(read, null);
});

test("readRequest devuelve null para request expirado", () => {
  let now = 1000;
  const store = new OidcStore(100, 60_000, 600_000, () => now);
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  now += 200;
  const read = store.readRequest(request.id);
  assert.equal(read, null);
});

test("dropRequest elimina un request", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  store.dropRequest(request.id);
  const read = store.readRequest(request.id);
  assert.equal(read, null);
});

test("issueCode genera un código de autorización", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: "state",
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const code = store.issueCode(request, {
    identityId: "user-123",
    displayName: "Test User",
    authTime: 1000,
  });
  assert.ok(code.code);
  assert.equal(code.clientId, "test");
  assert.equal(code.identityId, "user-123");
});

test("issueCode consume el request", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  store.issueCode(request, { identityId: "user-123", displayName: "Test", authTime: 1000 });
  const read = store.readRequest(request.id);
  assert.equal(read, null);
});

test("consumeCode devuelve ok y el record en el primer uso", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const issued = store.issueCode(request, {
    identityId: "user-123",
    displayName: "Test",
    authTime: 1000,
  });
  const result = store.consumeCode(issued.code);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.identityId, "user-123");
  }
});

test("consumeCode marca el código como usado", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const issued = store.issueCode(request, {
    identityId: "user-123",
    displayName: "Test",
    authTime: 1000,
  });
  store.consumeCode(issued.code);
  const result = store.consumeCode(issued.code);
  assert.equal(result.ok, false);
});

test("consumeCode revoca tokens al detectar replay", () => {
  const store = newStore();
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const issued = store.issueCode(request, {
    identityId: "user-123",
    displayName: "Test",
    authTime: 1000,
  });
  store.consumeCode(issued.code);
  store.noteIssuedToken(issued.code, "jti-123");
  store.consumeCode(issued.code);
  assert.equal(store.isRevoked("jti-123"), true);
});

test("isRevoked devuelve false para jti no revocado", () => {
  const store = newStore();
  assert.equal(store.isRevoked("jti-unknown"), false);
});

test("revoke marca un jti como revocado", () => {
  const store = newStore();
  store.revoke("jti-123");
  assert.equal(store.isRevoked("jti-123"), true);
});

test("isRevoked devuelve false después del TTL de revocación", () => {
  let now = 1000;
  const store = new OidcStore(600_000, 60_000, 600_000, () => now);
  store.revoke("jti-123", 100);
  assert.equal(store.isRevoked("jti-123"), true);
  now += 150;
  assert.equal(store.isRevoked("jti-123"), false);
});

test("sweep limpia requests, codes y revoked expirados", () => {
  let now = 1000;
  const store = new OidcStore(100, 100, 100, () => now);
  const request = store.createRequest({
    clientId: "test",
    clientName: "Test",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  now += 200;
  // El sweep ocurre cada 30s, forzamos creando otro request.
  now += 60_000;
  store.createRequest({
    clientId: "test2",
    clientName: "Test2",
    redirectUri: "https://example.com/cb",
    scopes: ["openid"],
    state: null,
    nonce: "nonce",
    codeChallenge: "challenge",
    maxAgeSec: 300,
  });
  const read = store.readRequest(request.id);
  assert.equal(read, null);
});
