import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  clearChallenges,
  computeChallengeHmac,
  getChallengeCount,
  issueChallenge,
  validateChallengeResponse,
} from "../challenge.js";

describe("challenge", () => {
  let consoleErrorOriginal: typeof console.error;
  let errorCalls: string[][] = [];

  beforeEach(() => {
    clearChallenges();
    errorCalls = [];
    consoleErrorOriginal = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)));
    };
  });

  afterEach(() => {
    clearChallenges();
    console.error = consoleErrorOriginal;
  });

  describe("issueChallenge", () => {
    it("emite challenge con nonce válido", () => {
      const result = issueChallenge("192.168.1.1");

      assert.ok("nonce" in result);
      if ("nonce" in result) {
        assert.ok(result.nonce);
        assert.equal(typeof result.nonce, "string");
        assert.ok(result.nonce.length > 20);
      }
    });

    it("incrementa contador de challenges", () => {
      assert.equal(getChallengeCount(), 0);

      issueChallenge("10.0.0.1");
      assert.equal(getChallengeCount(), 1);

      issueChallenge("10.0.0.1");
      assert.equal(getChallengeCount(), 2);
    });

    it("rate-limita emisión de challenges por IP", () => {
      const ip = "192.168.1.100";

      for (let i = 0; i < 10; i++) {
        const result = issueChallenge(ip);
        assert.ok("nonce" in result);
      }

      const rateLimited = issueChallenge(ip);
      assert.ok("error" in rateLimited);
      if ("error" in rateLimited) {
        assert.ok(rateLimited.error.includes("Demasiadas"));
      }
    });

    it("permite challenges de IPs distintas", () => {
      for (let i = 0; i < 10; i++) {
        const result = issueChallenge(`192.168.1.${i}`);
        assert.ok("nonce" in result);
      }

      assert.equal(getChallengeCount(), 10);
    });
  });

  describe("validateChallengeResponse", () => {
    it("valida challenge correcto", () => {
      const ip = "127.0.0.1";
      const secret = "test-secret-key";
      const payload = JSON.stringify([0.1, 0.2, 0.3]);

      const issued = issueChallenge(ip);
      if (!("nonce" in issued)) throw new Error("Challenge not issued");

      const nonce = issued.nonce;
      const hmac = computeChallengeHmac(nonce, payload, secret);

      const valid = validateChallengeResponse(nonce, hmac, payload, secret, ip);
      assert.equal(valid, true);
    });

    it("rechaza challenge no existente", () => {
      const secret = "test-secret-key";
      const payload = JSON.stringify([0.1, 0.2, 0.3]);
      const fakeNonce = "nonexistent-nonce";
      const hmac = computeChallengeHmac(fakeNonce, payload, secret);

      const valid = validateChallengeResponse(
        fakeNonce,
        hmac,
        payload,
        secret,
        "1.2.3.4",
      );

      assert.equal(valid, false);
      assert.ok(errorCalls.length > 0);
      assert.ok(errorCalls[0][1].includes("Challenge not found"));
    });

    it("rechaza HMAC incorrecto", () => {
      const ip = "10.0.0.50";
      const secret = "test-secret-key";
      const payload = JSON.stringify([0.1, 0.2, 0.3]);

      const issued = issueChallenge(ip);
      if (!("nonce" in issued)) throw new Error("Challenge not issued");

      const nonce = issued.nonce;
      const wrongHmac = "invalid-hmac-signature";

      const valid = validateChallengeResponse(
        nonce,
        wrongHmac,
        payload,
        secret,
        ip,
      );

      assert.equal(valid, false);
      assert.ok(errorCalls.length > 0);
      assert.ok(errorCalls[0][1].includes("Invalid HMAC signature"));
    });

    it("rechaza reuso de challenge (replay attack)", () => {
      const ip = "8.8.8.8";
      const secret = "test-secret-key";
      const payload = JSON.stringify([0.5, 0.6, 0.7]);

      const issued = issueChallenge(ip);
      if (!("nonce" in issued)) throw new Error("Challenge not issued");

      const nonce = issued.nonce;
      const hmac = computeChallengeHmac(nonce, payload, secret);

      const firstAttempt = validateChallengeResponse(
        nonce,
        hmac,
        payload,
        secret,
        ip,
      );
      assert.equal(firstAttempt, true);

      const secondAttempt = validateChallengeResponse(
        nonce,
        hmac,
        payload,
        secret,
        ip,
      );
      assert.equal(secondAttempt, false);
      assert.ok(errorCalls.some((call) => call[1].includes("Challenge reuse attempt")));
    });

    it("payload diferente invalida HMAC", () => {
      const ip = "192.168.2.1";
      const secret = "test-secret-key";
      const payload1 = JSON.stringify([1, 2, 3]);
      const payload2 = JSON.stringify([4, 5, 6]);

      const issued = issueChallenge(ip);
      if (!("nonce" in issued)) throw new Error("Challenge not issued");

      const nonce = issued.nonce;
      const hmac = computeChallengeHmac(nonce, payload1, secret);

      const valid = validateChallengeResponse(
        nonce,
        hmac,
        payload2,
        secret,
        ip,
      );

      assert.equal(valid, false);
    });
  });

  describe("computeChallengeHmac", () => {
    it("genera HMAC consistente", () => {
      const nonce = "test-nonce-123";
      const payload = "test-payload";
      const secret = "secret-key";

      const hmac1 = computeChallengeHmac(nonce, payload, secret);
      const hmac2 = computeChallengeHmac(nonce, payload, secret);

      assert.equal(hmac1, hmac2);
      assert.ok(hmac1);
    });

    it("genera HMAC diferente para payloads distintos", () => {
      const nonce = "nonce";
      const secret = "secret";

      const hmac1 = computeChallengeHmac(nonce, "payload1", secret);
      const hmac2 = computeChallengeHmac(nonce, "payload2", secret);

      assert.notEqual(hmac1, hmac2);
    });
  });

  describe("clearChallenges", () => {
    it("limpia todos los challenges y rate limits", () => {
      issueChallenge("1.1.1.1");
      issueChallenge("2.2.2.2");
      assert.ok(getChallengeCount() > 0);

      clearChallenges();
      assert.equal(getChallengeCount(), 0);

      const result = issueChallenge("1.1.1.1");
      assert.ok("nonce" in result);
    });
  });

  describe("security logging", () => {
    it("loggea eventos con estructura consistente", () => {
      const secret = "secret";
      const payload = "test";

      validateChallengeResponse("fake-nonce", "fake-hmac", payload, secret, "1.2.3.4");

      assert.ok(errorCalls.length > 0);
      const logged = errorCalls[0][1];
      const event = JSON.parse(logged);

      assert.ok("timestamp" in event);
      assert.ok("type" in event);
      assert.ok("severity" in event);
      assert.ok("details" in event);
      assert.equal(event.type, "challenge_violation");
    });
  });
});
