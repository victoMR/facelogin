import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlinkTracker,
  BLINK_ARM_FRAMES,
  challengeLabel,
  enrollChallenges,
  eyeSignal,
  eyesOpenForSample,
  GLASSES_CONDITIONS,
  loginChallenges,
  trustedChallenges,
  OPEN_EYE_RATIO,
  OPEN_EYE_RATIO_GLASSES,
  poseMet,
  rawYaw,
  screenYaw,
  SINGLE_CONDITION,
} from "../liveness";

function warm(tracker: BlinkTracker, raw = 0.3, n = BLINK_ARM_FRAMES): void {
  for (let i = 0; i < Math.max(n, 6); i += 1) tracker.noteOpen(raw);
  for (let i = 0; i < n; i += 1) tracker.feed(raw);
}

// Mock landmarks mínimo para pruebas
function mockLandmarks(leftEye: any[], rightEye: any[], nose: any[]): any {
  return {
    getLeftEye: () => leftEye,
    getRightEye: () => rightEye,
    getNose: () => nose,
    positions: Array(68).fill({ x: 0, y: 0 }),
  };
}

test("enrollChallenges es la guía de puntos, no una lista larga", () => {
  assert.deepEqual(enrollChallenges, ["center", "left", "right"]);
});

test("enrollChallenges incluye center, left, right", () => {
  assert.ok(enrollChallenges.includes("center"));
  assert.ok(enrollChallenges.includes("left"));
  assert.ok(enrollChallenges.includes("right"));
});

test("loginChallenges pide seguir el punto, no un blink aparte", () => {
  assert.deepEqual(loginChallenges, ["center", "left", "right"]);
});

test("trustedChallenges es solo un vistazo de frente", () => {
  assert.deepEqual(trustedChallenges, ["center"]);
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

test("BlinkTracker detecta cierre cuando raw cae de verdad", () => {
  const tracker = new BlinkTracker();
  warm(tracker);
  tracker.feed(0.05);
  assert.equal(tracker.phase, "closed");
});

test("BlinkTracker no trata el ruido de una foto como parpadeo", () => {
  const tracker = new BlinkTracker();
  warm(tracker);
  assert.equal(tracker.feed(0.285), "open");
  assert.equal(tracker.phase, "open");
  tracker.feed(0.3);
  tracker.feed(0.292);
  assert.notEqual(tracker.feed(0.3), "blink");
});

test("BlinkTracker pide cierre sostenido y reapertura", () => {
  const tracker = new BlinkTracker();
  warm(tracker, 0.32);
  tracker.feed(0.08);
  tracker.feed(0.07);
  assert.equal(tracker.phase, "closed");
  tracker.feed(0.12);
  tracker.feed(0.28);
  assert.equal(tracker.feed(0.32), "blink");
});

test("BlinkTracker ignora el valle al volver de un giro", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 6; i += 1) tracker.noteOpen(0.3);
  tracker.feed(0.16);
  tracker.feed(0.2);
  tracker.feed(0.26);
  tracker.feed(0.3);
  tracker.feed(0.3);
  assert.equal(tracker.won, false);
  assert.equal(tracker.phase, "open");
  assert.notEqual(tracker.feed(0.3), "blink");
});

test("BlinkTracker.reset olvida un ciclo a medias", () => {
  const tracker = new BlinkTracker();
  warm(tracker);
  tracker.feed(0.05);
  assert.equal(tracker.phase, "closed");
  tracker.reset();
  assert.equal(tracker.phase, "open");
  assert.equal(tracker.won, false);
  assert.equal(tracker.closedFrames, 0);
});

test("BlinkTracker detecta el parpadeo con EAR comprimido de lentes", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 10; i += 1) tracker.noteOpen(0.17, 0.16, 0.18);
  for (let i = 0; i < BLINK_ARM_FRAMES; i += 1) tracker.feed(0.17, 0.16, 0.18);
  assert.equal(tracker.compressed, true);
  tracker.feed(0.13, 0.12, 0.14);
  tracker.feed(0.125, 0.12, 0.13);
  assert.equal(tracker.phase, "closed");
  const reopened = tracker.feed(0.17, 0.16, 0.18);
  assert.ok(reopened === "blink" || tracker.won);
  tracker.ratio = 0.8;
  tracker.phase = "open";
  assert.equal(eyesOpenForSample(tracker), true);
});

test("BlinkTracker no olvida el abierto si el cierre dura un segundo", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 12; i += 1) tracker.noteOpen(0.3);
  warm(tracker);
  tracker.feed(0.08);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(tracker.feed(0.07), "closed");
  }
  assert.equal(tracker.phase, "closed");
  tracker.feed(0.28);
  assert.equal(tracker.feed(0.3), "blink");
});

test("BlinkTracker.clearCycle conserva la baseline de ojos abiertos", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 8; i += 1) tracker.noteOpen(0.28);
  tracker.clearCycle();
  assert.ok(tracker.peak >= 0.2);
  tracker.feed(0.28);
  tracker.feed(0.28);
  tracker.feed(0.28);
  tracker.feed(0.28);
  tracker.feed(0.28);
  tracker.feed(0.08);
  assert.equal(tracker.phase, "closed");
});

test("BlinkTracker no toma jitter de foto con EAR bajo por parpadeo", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < Math.max(10, BLINK_ARM_FRAMES); i += 1) tracker.noteOpen(0.17, 0.16, 0.18);
  for (let i = 0; i < BLINK_ARM_FRAMES; i += 1) tracker.feed(0.17, 0.16, 0.18);
  assert.equal(tracker.feed(0.162, 0.155, 0.17), "open");
  assert.equal(tracker.feed(0.168, 0.16, 0.175), "open");
  assert.notEqual(tracker.feed(0.17, 0.16, 0.18), "blink");
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

test("OPEN_EYE_RATIO es 0.84", () => {
  assert.equal(OPEN_EYE_RATIO, 0.84);
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
  tracker.ratio = 0.8;
  assert.equal(eyesOpenForSample(tracker), false);
  tracker.ratio = 0.84;
  assert.equal(eyesOpenForSample(tracker), true);
});

test("eyesOpenForSample con lentes acepta OPEN_EYE_RATIO_GLASSES", () => {
  const tracker = new BlinkTracker();
  tracker.phase = "open";
  tracker.compressed = true;
  tracker.ratio = OPEN_EYE_RATIO_GLASSES - 0.02;
  assert.equal(eyesOpenForSample(tracker), false);
  tracker.ratio = OPEN_EYE_RATIO_GLASSES;
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

test("BlinkTracker ve un cierre de blendshape (ojos 0.9 → 0.15)", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 8; i += 1) tracker.noteOpen(0.92, 0.93, 0.91);
  warm(tracker, 0.92);
  tracker.feed(0.18, 0.16, 0.2);
  tracker.feed(0.12, 0.1, 0.14);
  assert.equal(tracker.phase, "closed");
  tracker.feed(0.88, 0.9, 0.86);
  assert.equal(tracker.feed(0.93, 0.94, 0.92), "blink");
});

test("BlinkTracker.feed no baja el pico si los ojos siguen cerrados", () => {
  const tracker = new BlinkTracker();
  for (let i = 0; i < 8; i += 1) tracker.noteOpen(0.3);
  const peak = tracker.peak;
  warm(tracker, 0.3);
  for (let i = 0; i < 20; i += 1) tracker.feed(0.08);
  assert.ok(tracker.peak >= peak - 0.02);
  assert.equal(tracker.phase, "closed");
});
