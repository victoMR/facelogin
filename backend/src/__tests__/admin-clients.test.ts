import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { ActivityLog } from "../activity.js";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { ManagedClientRegistry } from "../oidc/managed-clients.js";
import { createRouter, resetRateLimits } from "../routes.js";
import { VaultStore } from "../store.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function engineAt(dir: string): FaceEngine {
  return new FaceEngine(new VaultStore(join(dir, "vault.json")), deriveMasterKey("admin-test-key"), "seed", "hmac");
}

test("ManagedClientRegistry crea y lista clientes sin secret en la vista pública", () => {
  const dir = tempDir("facelogin-clients-");
  const registry = new ManagedClientRegistry(join(dir, "oidc-clients.json"), []);
  const created = registry.create({
    name: "Tetris",
    redirect_uris: ["https://tetris-ten-beta.vercel.app/auth/facelogin/callback"],
  });
  assert.ok(created.client_secret);
  assert.ok(created.client_secret.length >= 16);
  assert.equal(created.client.name, "Tetris");
  assert.equal(created.client.source, "admin");
  assert.equal(created.client.confidential, true);
  assert.ok(registry.get(created.client.client_id)?.client_secret);

  const listed = registry.listPublic();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].client_id, created.client.client_id);
  assert.ok(!("client_secret" in listed[0]));
});

test("ManagedClientRegistry persiste y revoca solo clientes admin", () => {
  const dir = tempDir("facelogin-clients-persist-");
  const path = join(dir, "oidc-clients.json");
  const first = new ManagedClientRegistry(path, [
    {
      client_id: "env-app",
      name: "Env",
      redirect_uris: ["https://example.com/cb"],
      scopes: ["openid", "profile"],
      allow_insecure_redirect: false,
      confidential: true,
      client_secret: "secreto-env-suficientemente-largo",
    },
  ]);
  const created = first.create({
    name: "Demo",
    redirect_uris: ["https://demo.example/callback"],
  });

  const reloaded = new ManagedClientRegistry(path, first.all().filter((c) => c.client_id === "env-app"));
  assert.ok(reloaded.get(created.client.client_id));
  assert.equal(reloaded.listPublic().length, 2);

  assert.throws(() => reloaded.revoke("env-app"), /entorno/);
  assert.equal(reloaded.revoke(created.client.client_id), true);
  assert.equal(reloaded.get(created.client.client_id), undefined);
});

test("ActivityLog resume entradas de hoy", () => {
  const dir = tempDir("facelogin-activity-");
  const log = new ActivityLog(join(dir, "activity.json"));
  log.record({ kind: "login_ok", detail: "ok", identity: "Ana" });
  log.record({ kind: "login_fail", detail: "fail" });
  const summary = log.summary();
  assert.equal(summary.todayLogins, 1);
  assert.equal(summary.todayFails, 1);
  assert.ok(summary.lastAccess);
  assert.equal(log.lastSeenByIdentity().get("Ana"), summary.lastAccess);
});

test("POST /admin/clients exige token y crea app", async () => {
  resetRateLimits();
  const previous = process.env.FACELOGIN_ADMIN_TOKEN;
  process.env.FACELOGIN_ADMIN_TOKEN = "token-admin-test";
  const dir = tempDir("facelogin-admin-api-");
  const clients = new ManagedClientRegistry(join(dir, "clients.json"), []);
  const activity = new ActivityLog(join(dir, "activity.json"));
  const router = createRouter({
    engine: engineAt(dir),
    sessionSecret: "session",
    clients,
    activity,
    issuer: "http://localhost:8787",
  });

  const app = express();
  app.use(express.json());
  app.use(router);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        const { port } = server.address() as { port: number };
        const denied = await fetch(`http://127.0.0.1:${port}/admin/clients`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Tetris",
            redirect_uris: ["https://tetris-ten-beta.vercel.app/auth/facelogin/callback"],
          }),
        });
        assert.equal(denied.status, 401);

        const ok = await fetch(`http://127.0.0.1:${port}/admin/clients`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token-admin-test",
          },
          body: JSON.stringify({
            name: "Tetris",
            redirect_uris: ["https://tetris-ten-beta.vercel.app/auth/facelogin/callback"],
          }),
        });
        const body = await ok.json();
        assert.equal(ok.status, 201);
        assert.ok(body.client_secret);
        assert.equal(body.client.name, "Tetris");

        const metrics = await fetch(`http://127.0.0.1:${port}/admin/metrics`, {
          headers: { Authorization: "Bearer token-admin-test" },
        });
        const data = await metrics.json();
        assert.equal(metrics.status, 200);
        assert.equal(data.oidcClients, 1);
        assert.equal(data.apps[0].client_id, body.client.client_id);
        assert.ok(data.activity.some((event: { kind: string }) => event.kind === "client_created"));
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  if (previous === undefined) delete process.env.FACELOGIN_ADMIN_TOKEN;
  else process.env.FACELOGIN_ADMIN_TOKEN = previous;
});
