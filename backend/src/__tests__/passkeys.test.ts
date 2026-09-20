import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import {
  authenticationOptions,
  registrationOptions,
  resetPasskeyChallenges,
  verifyAuthentication,
  webAuthnFromOrigin,
} from "../passkeys.js";
import { VaultStore } from "../store.js";
import { l2Normalize } from "../matcher.js";

function cluster(anchor: number, c: number, count: number): number[][] {
  return Array.from({ length: count }, (_, i) => {
    const vector = new Array<number>(128).fill(0);
    vector[anchor] = Math.sqrt(c);
    vector[anchor + 1 + i] = Math.sqrt(1 - c);
    return l2Normalize(vector);
  });
}

test("WebAuthn exige verificación del usuario", async () => {
  resetPasskeyChallenges();
  const config = webAuthnFromOrigin("http://localhost:5173");
  const registration = await registrationOptions(config, { id: "ana", name: "Ana" }, []);
  assert.equal(registration.options.authenticatorSelection?.userVerification, "required");
  const authentication = await authenticationOptions(config);
  assert.equal(authentication.options.userVerification, "required");
});

test("webAuthnFromOrigin toma el host como rpID", () => {
  const config = webAuthnFromOrigin("https://login.example:8443/");
  assert.equal(config.rpID, "login.example");
  assert.equal(config.origin, "https://login.example:8443");
  assert.equal(config.rpName, "facelogin");
});

test("un ticket de autenticación se consume una sola vez", async () => {
  resetPasskeyChallenges();
  const config = webAuthnFromOrigin("http://localhost:5173");
  const { ticket } = await authenticationOptions(config);
  const bogus = {
    id: "cred",
    rawId: "cred",
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: "e30",
      authenticatorData: "e30",
      signature: "e30",
    },
  };
  const stored = {
    id: "cred",
    publicKey: "YQ",
    counter: 0,
    addedAt: new Date().toISOString(),
  };
  const first = await verifyAuthentication(config, ticket, bogus, stored);
  const second = await verifyAuthentication(config, ticket, bogus, stored);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
});

test("el motor guarda y localiza passkeys por credencial", () => {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-passkey-")), "vault.json");
  const engine = new FaceEngine(
    new VaultStore(path),
    deriveMasterKey("clave-de-prueba"),
    "semilla",
    "hmac",
  );
  const template = engine.enroll("Ana", cluster(0, 0.97, 5));
  engine.addPasskey(template.id, {
    id: "cred-1",
    publicKey: "YQ",
    counter: 0,
    addedAt: new Date().toISOString(),
  });
  assert.equal(engine.listPasskeys(template.id).length, 1);
  assert.equal(engine.findPasskey("cred-1")?.identityId, template.id);
  engine.updatePasskeyCounter(template.id, "cred-1", 4);
  assert.equal(engine.findPasskey("cred-1")?.passkey.counter, 4);
});
