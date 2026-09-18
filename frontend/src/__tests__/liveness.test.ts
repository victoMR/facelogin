import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlinkTracker,
  challengeLabel,
  enrollChallenges,
  eyeSignal,
  eyesOpenForSample,
  GLASSES_CONDITIONS,
  loginChallenges,
  OPEN_EYE_RATIO,
  poseMet,
  rawYaw,
  screenYaw,
  SINGLE_CONDITION,
} from "../liveness";

// Mock landmarks mínimo para pruebas
function mockLandmarks(leftEye: any[], rightEye: any[], nose: any[]): any {
  return {
    getLeftEye: () => leftEye,
    getRightEye: () => rightEye,
    getNose: () => nose,
    positions: Array(68).fill({ x: 0, y: 0 }),
  };
}

test("enrollChallenges contiene 5 retos", () => {
  assert.equal(enrollChallenges.length, 5);
});

test("enrollChallenges incluye center, blink, left, right", () => {
  assert.ok(enrollChallenges.includes("center"));
  assert.ok(enrollChallenges.includes("blink"));
  assert.ok(enrollChallenges.includes("left"));
  assert.ok(enrollChallenges.includes("right"));
});

test("loginChallenges contiene 2 retos", () => {
  assert.equal(loginChallenges.length, 2);
});

test("loginChallenges es center y blink", () => {
  assert.deepEqual(loginChallenges, ["center", "blink"]);
});

test("challengeLabel devuelve string no vacío para cada reto", () => {
  assert.ok(challengeLabel("center").length > 0);
  assert.ok(challengeLabel("blink").length > 0);
  assert.ok(challengeLabel("left").length > 0);
  assert.ok(challengeLabel("right").length > 0);
});

test("eyeSignal devuelve objeto con raw, left, right", () => {
  const landmarks = mockLandmarks(
    Array(6).fill({ x: 100, y: 100 }),
    Array(6).fill({ x: 150, y: 100 }),
    Array(4).fill({ x: 125, y: 120 }),
  );
  landmarks.positions[8] = { x: 125, y: 200 };
  landmarks.positions[27] = { x: 125, y: 80 };
  const signal = eyeSignal(landmarks);
  assert.ok(typeof signal.raw === "number");
  assert.ok(typeof signal.left === "number");
  assert.ok(typeof signal.right === "number");
});

test("rawYaw devuelve número", () => {
  const landmarks = mockLandmarks(
    [{ x: 100, y: 100 }],
    [{ x: 150, y: 100 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 125, y: 110 }],
  );
  const yaw = rawYaw(landmarks);
  assert.equal(typeof yaw, "number");
});

test("screenYaw es negativo de rawYaw", () => {
  const landmarks = mockLandmarks(
    [{ x: 100, y: 100 }],
    [{ x: 150, y: 100 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 130, y: 110 }],
  );
  const raw = rawYaw(landmarks);
  const screen = screenYaw(landmarks);
  assert.equal(Math.abs(screen + raw) < 1e-9, true);
});

test("BlinkTracker inicia con phase open", () => {
  const tracker = new BlinkTracker();
  assert.equal(tracker.phase, "open");
});

test("BlinkTracker.feed devuelve estado", () => {
  const tracker = new BlinkTracker();
  const result = tracker.feed(0.3);
  assert.ok(["open", "closed", "blink"].includes(result));
});

test("BlinkTracker detecta cierre cuando raw cae", () => {
  const tracker = new BlinkTracker();
  tracker.feed(0.3);
  tracker.feed(0.3);
  tracker.feed(0.05);
  assert.equal(tracker.phase, "closed");
});

test("BlinkTracker value se suaviza con EMA", () => {
  const tracker = new BlinkTracker();
  tracker.feed(0.3);
  const v1 = tracker.value;
  tracker.feed(0.5);
  const v2 = tracker.value;
  // El valor no salta al nuevo inmediatamente
  assert.ok(v2 > v1);
  assert.ok(v2 < 0.5);
});

test("poseMet devuelve boolean", () => {
  const landmarks = mockLandmarks(
    [{ x: 100, y: 100 }],
    [{ x: 150, y: 100 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 125, y: 110 }],
  );
  assert.equal(typeof poseMet("center", landmarks), "boolean");
  assert.equal(typeof poseMet("left", landmarks), "boolean");
  assert.equal(typeof poseMet("right", landmarks), "boolean");
});

test("OPEN_EYE_RATIO es 0.92", () => {
  assert.equal(OPEN_EYE_RATIO, 0.92);
});

test("eyesOpenForSample requiere phase open", () => {
  const tracker = new BlinkTracker();
  tracker.phase = "closed";
  tracker.ratio = 0.95;
  assert.equal(eyesOpenForSample(tracker), false);
});

test("eyesOpenForSample requiere ratio >= OPEN_EYE_RATIO", () => {
  const tracker = new BlinkTracker();
  tracker.phase = "open";
  tracker.ratio = 0.9;
  assert.equal(eyesOpenForSample(tracker), false);
  tracker.ratio = 0.92;
  assert.equal(eyesOpenForSample(tracker), true);
});

test("SINGLE_CONDITION tiene una condición", () => {
  assert.equal(SINGLE_CONDITION.length, 1);
  assert.equal(SINGLE_CONDITION[0].id, "default");
});

test("GLASSES_CONDITIONS tiene dos condiciones", () => {
  assert.equal(GLASSES_CONDITIONS.length, 2);
  assert.ok(GLASSES_CONDITIONS.some((c) => c.id === "con-lentes"));
  assert.ok(GLASSES_CONDITIONS.some((c) => c.id === "sin-lentes"));
});

test("GLASSES_CONDITIONS con-lentes viene primero", () => {
  assert.equal(GLASSES_CONDITIONS[0].id, "con-lentes");
  assert.equal(GLASSES_CONDITIONS[1].id, "sin-lentes");
});
