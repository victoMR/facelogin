import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { deriveMasterKey } from "../crypto.js";
import {
  createHoneypot,
  generateCanaryToken,
  handleCanaryAccess,
  handleHoneypotTrigger,
  isCanaryToken,
  isHoneypot,
  HONEYPOT_ID_PREFIX,
  CANARY_TOKEN_PREFIX,
  type SecurityEvent,
} from "../honeypot.js";

describe("honeypot", () => {
  let consoleErrorOriginal: typeof console.error;
  let errorCalls: string[][] = [];

  beforeEach(() => {
    errorCalls = [];
    consoleErrorOriginal = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)));
    };
  });

  afterEach(() => {
    console.error = consoleErrorOriginal;
  });

  describe("createHoneypot", () => {
    it("crea plantilla honeypot con ID prefijado", () => {
      const masterKey = deriveMasterKey("test-secret");
      const honeypot = createHoneypot("Fake User", masterKey);

      assert.ok(honeypot.id.startsWith(HONEYPOT_ID_PREFIX));
      assert.equal(honeypot.displayName, "Fake User");
      assert.equal(honeypot.conditions.length, 1);
      assert.equal(honeypot.conditions[0].encryptedSamples.length, 8);
      assert.deepEqual(honeypot.lshKeys, []);
    });

    it("genera vectores sintéticos normalizados", () => {
      const masterKey = deriveMasterKey("test-secret");
      const honeypot = createHoneypot("Decoy", masterKey);

      assert.ok(honeypot.conditions[0].encryptedCentroid);
      assert.ok(honeypot.conditions[0].encryptedCentroid.iv);
      assert.ok(honeypot.conditions[0].encryptedCentroid.data);
      assert.ok(honeypot.conditions[0].encryptedCentroid.tag);
    });

    it("no indexa en LSH (lshKeys vacío)", () => {
      const masterKey = deriveMasterKey("test-secret");
      const honeypot = createHoneypot("Trap", masterKey);

      assert.deepEqual(honeypot.lshKeys, []);
    });
  });

  describe("isHoneypot", () => {
    it("detecta IDs de honeypot", () => {
      const honeypotId = `${HONEYPOT_ID_PREFIX}12345-67890`;
      const normalId = "550e8400-e29b-41d4-a716-446655440000";

      assert.equal(isHoneypot(honeypotId), true);
      assert.equal(isHoneypot(normalId), false);
    });
  });

  describe("canary tokens", () => {
    it("genera token canary con prefijo", () => {
      const token = generateCanaryToken();

      assert.ok(token.startsWith(CANARY_TOKEN_PREFIX));
      assert.ok(token.length > CANARY_TOKEN_PREFIX.length);
    });

    it("detecta tokens canary", () => {
      const canaryToken = `${CANARY_TOKEN_PREFIX}abc-def-ghi`;
      const normalToken = "Bearer xyz123";

      assert.equal(isCanaryToken(canaryToken), true);
      assert.equal(isCanaryToken(normalToken), false);
    });
  });

  describe("handleHoneypotTrigger", () => {
    it("loggea evento crítico de seguridad", () => {
      const honeypotId = `${HONEYPOT_ID_PREFIX}trap1`;
      const ip = "192.168.1.100";

      const result = handleHoneypotTrigger(honeypotId, ip);

      assert.equal(result.shouldBlock, true);
      assert.equal(result.response, "generic_failure");
      assert.ok(errorCalls.length > 0);
      assert.ok(errorCalls[0][1].includes("honeypot_match"));

      const loggedEvent = JSON.parse(errorCalls[0][1]) as SecurityEvent;
      assert.equal(loggedEvent.type, "honeypot_match");
      assert.equal(loggedEvent.severity, "critical");
      assert.equal(loggedEvent.details.ip, ip);
      assert.equal(loggedEvent.details.honeypotId, honeypotId);
    });

    it("no revela que es honeypot en respuesta", () => {
      const result = handleHoneypotTrigger("honeypot_x", "1.2.3.4");

      assert.equal(result.response, "generic_failure");
      assert.ok(!result.response.includes("honeypot"));
      assert.ok(!result.response.includes("trap"));
      assert.ok(!result.response.includes("canary"));
    });
  });

  describe("handleCanaryAccess", () => {
    it("loggea evento crítico cuando se usa canary token", () => {
      const token = `${CANARY_TOKEN_PREFIX}fake-token`;
      const ip = "10.0.0.5";

      const result = handleCanaryAccess(token, ip);

      assert.equal(result.shouldBlock, true);
      assert.equal(result.response, "generic_failure");
      assert.ok(errorCalls.length > 0);
      assert.ok(errorCalls[0][1].includes("canary_access"));

      const loggedEvent = JSON.parse(errorCalls[0][1]) as SecurityEvent;
      assert.equal(loggedEvent.type, "canary_access");
      assert.equal(loggedEvent.severity, "critical");
      assert.equal(loggedEvent.details.ip, ip);
      assert.equal(loggedEvent.details.canaryToken, token);
    });
  });

  describe("security event structure", () => {
    it("eventos tienen estructura consistente", () => {
      handleHoneypotTrigger("honeypot_test", "127.0.0.1");

      const loggedEvent = JSON.parse(errorCalls[0][1]) as SecurityEvent;

      assert.ok("timestamp" in loggedEvent);
      assert.ok("type" in loggedEvent);
      assert.ok("severity" in loggedEvent);
      assert.ok("details" in loggedEvent);
      assert.equal(typeof loggedEvent.timestamp, "string");
      assert.ok(!Number.isNaN(Date.parse(loggedEvent.timestamp)));
    });

    it("NO incluye datos sensibles en logs", () => {
      handleHoneypotTrigger("honeypot_secure", "8.8.8.8");

      const logged = errorCalls[0][1];

      assert.ok(!logged.includes("descriptor"));
      assert.ok(!logged.includes("vector"));
      assert.ok(!logged.includes("template"));
      assert.ok(!logged.includes("encryptedCentroid"));
      assert.ok(!logged.includes("masterKey"));
    });
  });
});
