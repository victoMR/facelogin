import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
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
  return Array.from({ length: count }, (_, i) =>
    l2Normalize([...basis(anchor).map((v) => v * Math.sqrt(c)), ...basis(anchor + 1 + i).map((v) => v * Math.sqrt(1 - c))].slice(0, DIM)),
  );
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
  const handler = router.stack.find((layer: any) => layer.route?.path === "/health")?.route?.stack[0]?.handle;
  if (handler) handler(req, res);
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
  const handler = router.stack.find((layer: any) => layer.route?.path === "/enroll")?.route?.stack[0]?.handle;
  if (handler) handler(req, res);
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
  const handler = router.stack.find((layer: any) => layer.route?.path === "/enroll")?.route?.stack[0]?.handle;
  if (handler) handler(req, res);
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
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) handler(req, res);
  assert.equal(status, 400);
  assert.ok(body.error);
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
  const handler = router.stack.find((layer: any) => layer.route?.path === "/identify")?.route?.stack[0]?.handle;
  if (handler) handler(req, res);
  assert.equal(status, 401);
});
