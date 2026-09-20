import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveMasterKey } from "../crypto.js";
import {
  consumeDeviceNonce,
  issueDeviceNonce,
  publicKeyId,
  readDevice,
  resetDeviceNonces,
  verifyDeviceSignature,
} from "../devices.js";
import { FaceEngine } from "../engine.js";
import { l2Normalize } from "../matcher.js";
import { VaultStore } from "../store.js";

const KEY = deriveMasterKey("clave-de-prueba");

function cluster(): number[][] {
  return Array.from({ length: 5 }, (_, i) => {
    const vector = new Array<number>(128).fill(0);
    vector[0] = Math.sqrt(0.97);
    vector[1 + i] = Math.sqrt(0.03);
    return l2Normalize(vector);
  });
}

async function pair() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const publicKey = Buffer.from(spki).toString("base64");
  return { keys, publicKey, id: publicKeyId(publicKey) };
}

async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(nonce),
  );
  return Buffer.from(signature).toString("base64");
}

function engine() {
  const path = join(mkdtempSync(join(tmpdir(), "facelogin-dev-")), "vault.json");
  return new FaceEngine(new VaultStore(path), KEY, "semilla", "secreto");
}

test("el id de la clave es el SHA-256 de la pública, no del user-agent", async () => {
  const { publicKey, id } = await pair();
  assert.equal(id, publicKeyId(publicKey));
  assert.notEqual(id, publicKey);
});

test("una firma válida del nonce se acepta y una falsa no", async () => {
  resetDeviceNonces();
  const { keys, publicKey } = await pair();
  const nonce = issueDeviceNonce();
  const good = await signNonce(keys.privateKey, nonce);
  assert.equal(verifyDeviceSignature(publicKey, nonce, good), true);
  assert.equal(verifyDeviceSignature(publicKey, nonce, "AAAA"), false);
});

test("el nonce del aparato es de un solo uso", () => {
  resetDeviceNonces();
  const nonce = issueDeviceNonce();
  assert.equal(consumeDeviceNonce(nonce), true);
  assert.equal(consumeDeviceNonce(nonce), false);
});

test("readDevice rechaza un id que no coincide con la pública", async () => {
  const { publicKey } = await pair();
  assert.equal(readDevice({ id: "otro", publicKey }), null);
});

test("enroll guarda la pública del aparato y el login la reconoce", async () => {
  resetDeviceNonces();
  const { keys, publicKey, id } = await pair();
  const face = engine();
  const template = face.enroll("Ana", cluster(), undefined, { id, publicKey, label: "Mac · Chrome" });
  assert.equal(template.devices?.[0]?.id, id);
  assert.equal(template.devices?.[0]?.publicKey, publicKey);

  const nonce = issueDeviceNonce();
  const signature = await signNonce(keys.privateKey, nonce);
  const known = face.listDevices(template.id).some((device) => device.id === id);
  assert.equal(known, true);
  assert.equal(verifyDeviceSignature(publicKey, nonce, signature), true);
});

test("confiar añade un aparato nuevo a una identidad ya enrolada", async () => {
  const { publicKey, id } = await pair();
  const face = engine();
  const template = face.enroll("Ana", cluster());
  assert.equal(template.devices?.length ?? 0, 0);
  face.trustDevice(template.id, { id, publicKey, label: "iPhone" });
  assert.equal(face.listDevices(template.id)[0]?.label, "iPhone");
});
