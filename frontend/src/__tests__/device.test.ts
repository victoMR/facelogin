import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToB64Url, deviceLabel } from "../device";

test("bytesToB64Url es url-safe", () => {
  const encoded = bytesToB64Url(Uint8Array.from([0xfb, 0xff, 0xef]));
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.equal(encoded.includes("="), false);
});

test("deviceLabel no está vacío", () => {
  assert.ok(deviceLabel().length > 0);
});
