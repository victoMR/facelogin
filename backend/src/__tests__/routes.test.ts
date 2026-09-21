import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { issueDeviceNonce, publicKeyId } from "../devices.js";
import { createRouter, rateLimit, resetRateLimits } from "../routes.js";
import { VaultStore } from "../store.js";

const DIM = 128;
const KEY = deriveMasterKey("test-master-key");

function basis(index: number): number[] {
  const vector = new Array<number>(DIM).fill(0);
  vector[index] = 1;
  return vector;
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

function cluster(anchor: number, c: number, count: number): number[][] {
  return Array.from({ length: count }, (_, i) => {
    const vector = new Array<number>(DIM).fill(0);
    vector[anchor] = Math.sqrt(c);
    vector[anchor + 1 + i] = Math.sqrt(1 - c);
    return l2Normalize(vector);
  });
}

function newEngine(): FaceEngine {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-routes-")), "vault.json");
  const store = new VaultStore(path);
  return new FaceEngine(store, KEY, "test-seed", "test-secret");
}

test("rateLimit permite hasta max intentos en la ventana", () => {
  resetRateLimits();
  assert.equal(rateLimit("test", "1.2.3.4", 3, 60_000), true);
  assert.equal(rateLimit("test", "1.2.3.4", 3, 60_000), true);
  assert.equal(rateLimit("test", "1.2.3.4", 3, 60_000), true);
  assert.equal(rateLimit("test", "1.2.3.4", 3, 60_000), false);
});

test("rateLimit tiene cubetas separadas por scope e IP", () => {
  resetRateLimits();
  rateLimit("enroll", "1.2.3.4", 2, 60_000);
  rateLimit("enroll", "1.2.3.4", 2, 60_000);
  assert.equal(rateLimit("enroll", "1.2.3.4", 2, 60_000), false);
  // Mismo scope, distinta IP: contador nuevo.
  assert.equal(rateLimit("enroll", "5.6.7.8", 2, 60_000), true);
  // Distinto scope, misma IP: contador nuevo.
  assert.equal(rateLimit("identify", "1.2.3.4", 2, 60_000), true);
});

test("rateLimit reinicia el contador después de la ventana", async () => {
  resetRateLimits();
  const originalNow = Date.now;
  let fakeNow = 1000;
  Date.now = () => fakeNow;
  try {
    assert.equal(rateLimit("test", "1.1.1.1", 1, 100), true);
    assert.equal(rateLimit("test", "1.1.1.1", 1, 100), false);
    fakeNow += 150;
    assert.equal(rateLimit("test", "1.1.1.1", 1, 100), true);
  } finally {
    Date.now = originalNow;
  }
});

test("rateLimit purga entradas vencidas cada SWEEP_INTERVAL_MS", async () => {
  resetRateLimits();
  const originalNow = Date.now;
  let fakeNow = 1000;
  Date.now = () => fakeNow;
  try {
    rateLimit("test", "1.1.1.1", 1, 1_000);
    fakeNow += 65_000;
    // El sweep ocurre en la siguiente llamada tras SWEEP_INTERVAL_MS.
    rateLimit("test", "2.2.2.2", 1, 1_000);
    // La entrada vieja ya debería estar borrada.
    assert.equal(rateLimit("test", "1.1.1.1", 1, 1_000), true);
  } finally {
    Date.now = originalNow;
  }
});

test("resetRateLimits limpia todas las cubetas", () => {
  resetRateLimits();
  rateLimit("test", "1.2.3.4", 1, 60_000);
  assert.equal(rateLimit("test", "1.2.3.4", 1, 60_000), false);
  resetRateLimits();
  assert.equal(rateLimit("test", "1.2.3.4", 1, 60_000), true);
});

test("createRouter devuelve un router de Express", () => {
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  assert.ok(router);
});

test("GET /health devuelve ok: true", async () => {
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  const req = { method: "GET", url: "/health" } as any;
  const res = {
    json: (body: any) => {
      assert.deepEqual(body, { ok: true, mode: "face-only" });
    },
  } as any;
  const next = () => {};
  const handler = router.stack.find((layer: any) => layer.route?.path === "/health")?.route?.stack[0]?.handle;
  if (handler) handler(req, res, next);
});

test("POST /enroll rechaza sin displayName", async () => {
  resetRateLimits();
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  let status = 200;
  let body: any = null;
  const req = { method: "POST", url: "/enroll", ip: "test", body: { samples: [] } } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
    },
  } as any;
  const next = () => {};
  const handler = router.stack.find((layer: any) => layer.route?.path === "/enroll")?.route?.stack[0]?.handle;
  if (handler) handler(req, res, next);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test("POST /enroll rechaza descriptores de dimensión incorrecta", async () => {
  resetRateLimits();
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  let status = 200;
  let body: any = null;
  const req = {
    method: "POST",
    url: "/enroll",
    ip: "test",
    body: { displayName: "Test", samples: [[1, 2, 3]] },
  } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
    },
  } as any;
  const next = () => {};
  const handler = router.stack.find((layer: any) => layer.route?.path === "/enroll")?.route?.stack[0]?.handle;
  if (handler) handler(req, res, next);
  assert.equal(status, 400);
});

test("POST /identify rechaza sin descriptor", async () => {
  resetRateLimits();
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  let status = 200;
  let body: any = null;
  const req = { method: "POST", url: "/identify", ip: "test", body: {} } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
    },
  } as any;
  const next = () => {};
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) await handler(req, res, next);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test("POST /enroll exige la malla de 64 dimensiones", async () => {
  resetRateLimits();
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  let status = 200;
  const req = {
    method: "POST",
    url: "/enroll",
    ip: "test",
    body: { displayName: "Ana", samples: cluster(0, 0.97, 5) },
  } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: () => {},
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/enroll")?.route?.stack[0]?.handle;
  if (handler) handler(req, res, () => {});
  assert.equal(status, 400);
});

test("POST /identify rechaza galería vacía con 401", async () => {
  resetRateLimits();
  const engine = newEngine();
  const router = createRouter(engine, "session-secret");
  let status = 200;
  const req = { method: "POST", url: "/identify", ip: "test", body: { descriptor: basis(0) } } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: () => {},
  } as any;
  const next = () => {};
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) await handler(req, res, next);
  assert.equal(status, 401);
});

test("POST /identify no entrega JWT con solo la cara o un transcript", async () => {
  resetRateLimits();
  const engine = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const router = createRouter(engine, "session-secret");
  let status = 200;
  let body: any = null;
  const req = {
    method: "POST",
    url: "/identify",
    ip: "test",
    body: {
      descriptor: cluster(0, 0.97, 5)[0],
      voice: { id: "inventado", transcript: "rimbombante ajolote murciélago" },
    },
  } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
    },
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) await handler(req, res, () => {});
  assert.equal(status, 403);
  assert.equal(body.code, "PASSKEY_REQUIRED");
});

test("POST /identify con cara y firma de aparato nuevo abre sesión sin passkey", async () => {
  resetRateLimits();
  const engine = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const router = createRouter(engine, "session-secret");

  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const publicKey = Buffer.from(spki).toString("base64");
  const id = publicKeyId(publicKey);
  const nonce = issueDeviceNonce();
  const signature = Buffer.from(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(nonce),
    ),
  ).toString("base64");

  let status = 500;
  let body: any = null;
  const req = {
    method: "POST",
    url: "/identify",
    ip: "test",
    body: {
      descriptor: cluster(0, 0.97, 5)[0],
      device: { id, publicKey, label: "Phone", nonce, signature },
    },
  } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
      status = status === 500 ? 200 : status;
    },
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) await handler(req, res, () => {});
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.trustedDevice, true);
  assert.equal(engine.listDevices(body.identity.id).length, 1);
});

test("GET /identities solo publica el recuento", async () => {
  resetRateLimits();
  const engine = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const router = createRouter(engine, "session-secret");
  let body: any = null;
  const req = { method: "GET", url: "/identities", ip: "test" } as any;
  const res = {
    json: (data: any) => {
      body = data;
    },
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identities" && layer.route.methods.get)
    ?.route?.stack[0]?.handle;
  if (handler) handler(req, res, () => {});
  assert.deepEqual(body, { count: 1 });
  assert.equal("names" in body, false);
});

test("DELETE /identities no borra sin token de administración", async () => {
  resetRateLimits();
  const previous = process.env.FACELOGIN_ADMIN_TOKEN;
  delete process.env.FACELOGIN_ADMIN_TOKEN;
  const engine = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const router = createRouter(engine, "session-secret");
  let status = 200;
  const req = { method: "DELETE", url: "/identities", ip: "test", header: () => "" } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: () => {},
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identities" && layer.route.methods.delete)
    ?.route?.stack[0]?.handle;
  try {
    if (handler) await handler(req, res, () => {});
    assert.equal(status, 401);
    assert.equal(engine.countIdentities(), 1);
  } finally {
    if (previous === undefined) delete process.env.FACELOGIN_ADMIN_TOKEN;
    else process.env.FACELOGIN_ADMIN_TOKEN = previous;
  }
});

test("DELETE /identities vacía la galería con token de administración", async () => {
  resetRateLimits();
  const previous = process.env.FACELOGIN_ADMIN_TOKEN;
  process.env.FACELOGIN_ADMIN_TOKEN = "admin-de-prueba";
  const engine = newEngine();
  engine.enroll("Ana", cluster(0, 0.97, 5));
  const router = createRouter(engine, "session-secret");
  let status = 200;
  let body: any = null;
  const req = {
    method: "DELETE",
    url: "/identities",
    ip: "test",
    header: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer admin-de-prueba" : ""),
  } as any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (data: any) => {
      body = data;
    },
  } as any;
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identities" && layer.route.methods.delete)
    ?.route?.stack[0]?.handle;
  try {
    if (handler) await handler(req, res, () => {});
    assert.equal(status, 200);
    assert.equal(body.removed, 1);
    assert.equal(engine.countIdentities(), 0);
  } finally {
    if (previous === undefined) delete process.env.FACELOGIN_ADMIN_TOKEN;
    else process.env.FACELOGIN_ADMIN_TOKEN = previous;
  }
});
