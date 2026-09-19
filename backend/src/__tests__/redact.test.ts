import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MatchDecision } from "../types.js";
import {
  hasSensitiveKeys,
  redactEnrollResponse,
  redactFailedIdentifyResponse,
  redactMatchDecisionForLog,
  sanitizeErrorMessage,
} from "../redact.js";

describe("redact", () => {
  describe("redactFailedIdentifyResponse", () => {
    it("retorna respuesta genérica sin métricas", () => {
      const response = redactFailedIdentifyResponse();

      assert.deepEqual(response, {
        error: "No hay coincidencia facial suficiente.",
      });
      assert.ok(!("score" in response));
      assert.ok(!("threshold" in response));
      assert.ok(!("candidates" in response));
    });

    it("no revela información útil para atacante", () => {
      const response = redactFailedIdentifyResponse();

      const serialized = JSON.stringify(response);
      assert.ok(!serialized.includes("descriptor"));
      assert.ok(!serialized.includes("vector"));
      assert.ok(!serialized.includes("template"));
    });
  });

  describe("redactMatchDecisionForLog", () => {
    it("incluye métricas pero no descriptores", () => {
      const decision: MatchDecision = {
        matched: true,
        identityId: "user-123",
        displayName: "Test User",
        score: 0.92,
        threshold: 0.85,
        candidates: 5,
        latencyMs: 12.5,
        reason: "lsh",
        condition: "default",
      };

      const log = redactMatchDecisionForLog(decision, "192.168.1.1");

      assert.equal(log.matched, true);
      assert.equal(log.identityId, "user-123");
      assert.equal(log.score, 0.92);
      assert.equal(log.threshold, 0.85);
      assert.equal(log.ip, "192.168.1.1");
      assert.ok(log.timestamp);
      assert.ok(!Number.isNaN(Date.parse(log.timestamp)));
    });

    it("no incluye campos sensibles", () => {
      const decision: MatchDecision = {
        matched: false,
        identityId: null,
        displayName: null,
        score: 0.5,
        threshold: 0.85,
        candidates: 10,
        latencyMs: 8.2,
        reason: "below-threshold",
        condition: null,
      };

      const log = redactMatchDecisionForLog(decision, "10.0.0.1");
      const serialized = JSON.stringify(log);

      assert.ok(!serialized.includes("descriptor"));
      assert.ok(!serialized.includes("vector"));
      assert.ok(!serialized.includes("encryptedCentroid"));
      assert.ok(!serialized.includes("masterKey"));
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("mantiene mensajes seguros sin cambios", () => {
      const safeMessages = [
        "Usuario no encontrado",
        "Error de conexión",
        "Timeout en la operación",
        "Descriptor facial inválido.",
      ];

      for (const msg of safeMessages) {
        assert.equal(sanitizeErrorMessage(msg), msg);
      }
    });

    it("redacta arrays de números que parecen descriptores", () => {
      const dangerous = "Error: descriptor [0.123, 0.456, 0.789] inválido";
      const sanitized = sanitizeErrorMessage(dangerous);

      assert.equal(sanitized, "Error de procesamiento interno.");
      assert.ok(!sanitized.includes("0.123"));
    });

    it("redacta tokens y secrets", () => {
      const dangerous = "Error: token abc123xyz456789012345 inválido";
      const sanitized = sanitizeErrorMessage(dangerous);

      assert.ok(sanitized.includes("[REDACTED]"));
      assert.ok(!sanitized.includes("abc123xyz456789012345"));
    });

    it("redacta claves largas", () => {
      const dangerous =
        "Error: key dGVzdC1zZWNyZXQta2V5LXRoYXQtaXMtbG9uZw== comprometida";
      const sanitized = sanitizeErrorMessage(dangerous);

      assert.ok(sanitized.includes("[REDACTED]"));
      assert.ok(!sanitized.includes("dGVzdC1zZWNyZXQta2V5"));
    });
  });

  describe("redactEnrollResponse", () => {
    it("mantiene metadatos seguros y omite blobs cifrados", () => {
      const template = {
        id: "user-456",
        displayName: "Alice",
        conditions: [
          {
            label: "default",
            encryptedSamples: [{}, {}, {}, {}] as unknown[],
            intraMean: 0.89,
            intraStd: 0.04,
          },
        ],
        interConditionCosine: null,
        thresholdAtEnroll: 0.82,
        intraMean: 0.89,
        intraStd: 0.04,
      };

      const redacted = redactEnrollResponse(template);

      assert.equal(redacted.id, "user-456");
      assert.equal(redacted.displayName, "Alice");
      assert.equal(redacted.samples, 4);
      assert.equal(redacted.conditions[0].samples, 4);
      assert.equal(redacted.conditions[0].intraMean, 0.89);

      const serialized = JSON.stringify(redacted);
      assert.ok(!serialized.includes("encryptedSamples"));
      assert.ok(!serialized.includes("encryptedCentroid"));
    });

    it("redondea métricas a 4 decimales", () => {
      const template = {
        id: "user-789",
        displayName: "Bob",
        conditions: [
          {
            label: "con-lentes",
            encryptedSamples: [{}, {}, {}] as unknown[],
            intraMean: 0.876543,
            intraStd: 0.0456789,
          },
        ],
        interConditionCosine: 0.7123456,
        thresholdAtEnroll: 0.8234567,
        intraMean: 0.876543,
        intraStd: 0.0456789,
      };

      const redacted = redactEnrollResponse(template);

      assert.equal(redacted.conditions[0].intraMean, 0.8765);
      assert.equal(redacted.conditions[0].intraStd, 0.0457);
      assert.equal(redacted.interConditionCosine, 0.7123);
      assert.equal(redacted.thresholdAtEnroll, 0.8235);
    });
  });

  describe("hasSensitiveKeys", () => {
    it("detecta claves sensibles", () => {
      const sensitive = {
        id: "123",
        encryptedCentroid: { iv: "...", data: "...", tag: "..." },
      };

      assert.equal(hasSensitiveKeys(sensitive), true);
    });

    it("detecta descriptores", () => {
      const sensitive = {
        user: "alice",
        descriptor: [0.1, 0.2, 0.3],
      };

      assert.equal(hasSensitiveKeys(sensitive), true);
    });

    it("permite objetos seguros", () => {
      const safe = {
        id: "123",
        displayName: "Alice",
        score: 0.9,
        threshold: 0.85,
      };

      assert.equal(hasSensitiveKeys(safe), false);
    });

    it("maneja null y undefined", () => {
      assert.equal(hasSensitiveKeys(null), false);
      assert.equal(hasSensitiveKeys(undefined), false);
      assert.equal(hasSensitiveKeys("string"), false);
      assert.equal(hasSensitiveKeys(123), false);
    });

    it("detecta múltiples claves sensibles", () => {
      const sensitive = {
        masterKey: "secret",
        password: "pass123",
        token: "abc",
      };

      assert.equal(hasSensitiveKeys(sensitive), true);
    });
  });

  describe("no filtra datos del cliente", () => {
    it("redacted responses no contienen vectores", () => {
      const failResponse = redactFailedIdentifyResponse();
      const serialized = JSON.stringify(failResponse);

      assert.ok(!/\[[\d\s,.-]+\]/.test(serialized));
    });

    it("logs no contienen plantillas cifradas", () => {
      const decision: MatchDecision = {
        matched: true,
        identityId: "user-1",
        displayName: "Test",
        score: 0.95,
        threshold: 0.85,
        candidates: 3,
        latencyMs: 10,
        reason: "lsh",
        condition: "default",
      };

      const log = redactMatchDecisionForLog(decision, "127.0.0.1");
      const serialized = JSON.stringify(log);

      assert.ok(!serialized.includes("encrypted"));
      assert.ok(!serialized.includes("iv"));
      assert.ok(!serialized.includes("tag"));
    });
  });
});
