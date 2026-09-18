import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry, parseClients, secretMatches } from "../oidc/clients.js";

test("secretMatches devuelve true para secretos iguales", () => {
  assert.equal(secretMatches("my-secret", "my-secret"), true);
});

test("secretMatches devuelve false para secretos distintos", () => {
  assert.equal(secretMatches("my-secret", "wrong-secret"), false);
});

test("secretMatches devuelve false para longitudes distintas", () => {
  assert.equal(secretMatches("short", "much-longer-secret"), false);
});

test("secretMatches maneja strings vacíos", () => {
  assert.equal(secretMatches("", ""), true);
  assert.equal(secretMatches("", "secret"), false);
});

test("parseClients acepta un cliente válido", () => {
  const raw = [
    {
      client_id: "test-client",
      name: "Test Client",
      redirect_uris: ["https://example.com/callback"],
      scopes: ["openid", "profile"],
    },
  ];
  const clients = parseClients(raw);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].client_id, "test-client");
});

test("parseClients marca cliente con client_secret como confidential", () => {
  const raw = [
    {
      client_id: "conf-client",
      name: "Confidential",
      redirect_uris: ["https://example.com/cb"],
      client_secret: "very-secret-value",
      scopes: ["openid"],
    },
  ];
  const clients = parseClients(raw);
  assert.equal(clients[0].confidential, true);
});

test("parseClients marca cliente sin client_secret como público", () => {
  const raw = [
    {
      client_id: "public-client",
      name: "Public",
      redirect_uris: ["https://example.com/cb"],
      scopes: ["openid"],
    },
  ];
  const clients = parseClients(raw);
  assert.equal(clients[0].confidential, false);
});

test("parseClients rechaza client_id duplicado", () => {
  const raw = [
    {
      client_id: "dup",
      name: "First",
      redirect_uris: ["https://example.com/cb"],
      scopes: ["openid"],
    },
    {
      client_id: "dup",
      name: "Second",
      redirect_uris: ["https://example.com/cb2"],
      scopes: ["openid"],
    },
  ];
  assert.throws(() => parseClients(raw), /duplicado/);
});

test("parseClients rechaza cliente sin openid en scopes", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["https://example.com/cb"],
      scopes: ["profile"],
    },
  ];
  assert.throws(() => parseClients(raw), /openid/);
});

test("parseClients rechaza redirect_uri http sin loopback", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["http://example.com/cb"],
      scopes: ["openid"],
    },
  ];
  assert.throws(() => parseClients(raw), /TLS/);
});

test("parseClients acepta redirect_uri http en localhost", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["http://localhost:3000/callback"],
      scopes: ["openid"],
    },
  ];
  const clients = parseClients(raw);
  assert.equal(clients.length, 1);
});

test("parseClients acepta redirect_uri http con allow_insecure_redirect", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["http://192.168.1.100/cb"],
      scopes: ["openid"],
      allow_insecure_redirect: true,
    },
  ];
  const warnings: string[] = [];
  const clients = parseClients(raw, (msg) => warnings.push(msg));
  assert.equal(clients.length, 1);
  assert.ok(warnings.some((w) => w.includes("http sin TLS")));
});

test("parseClients rechaza redirect_uri con fragmento", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["https://example.com/cb#fragment"],
      scopes: ["openid"],
    },
  ];
  assert.throws(() => parseClients(raw), /fragmento/);
});

test("parseClients defaults scopes a openid+profile", () => {
  const raw = [
    {
      client_id: "test",
      name: "Test",
      redirect_uris: ["https://example.com/cb"],
    },
  ];
  const clients = parseClients(raw);
  assert.deepEqual(clients[0].scopes, ["openid", "profile"]);
});

test("createRegistry permite get por client_id", () => {
  const clients = [
    {
      client_id: "test-client",
      name: "Test",
      redirect_uris: ["https://example.com/cb"],
      scopes: ["openid"],
      confidential: false,
    },
  ];
  const registry = createRegistry(clients);
  const found = registry.get("test-client");
  assert.ok(found);
  assert.equal(found.name, "Test");
});

test("createRegistry devuelve undefined para client_id inexistente", () => {
  const registry = createRegistry([]);
  assert.equal(registry.get("unknown"), undefined);
});

test("createRegistry.all() devuelve copia de todos los clientes", () => {
  const clients = [
    {
      client_id: "a",
      name: "A",
      redirect_uris: ["https://a.com/cb"],
      scopes: ["openid"],
      confidential: false,
    },
    {
      client_id: "b",
      name: "B",
      redirect_uris: ["https://b.com/cb"],
      scopes: ["openid"],
      confidential: false,
    },
  ];
  const registry = createRegistry(clients);
  const all = registry.all();
  assert.equal(all.length, 2);
});
