import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENROLL_CAPTCHA_SCORE,
  HUMAN_CAPTCHA_SCORE,
  SpanTracker,
  foldSpeech,
  humanConfidence,
  wordHeard,
  wordsHeard,
} from "../human";

function liveHuman() {
  return {
    yawSpan: 0.4,
    blinkSpan: 0.35,
    residual: 1.8,
    depthRelief: 0.09,
    seenBlink: true,
    mouthSpan: 0.25,
    frames: 40,
    glanced: true,
  };
}

test("una cara viva con giros y parpadeo no pide captcha", () => {
  const report = humanConfidence(liveHuman());
  assert.ok(report.score >= HUMAN_CAPTCHA_SCORE);
  assert.equal(report.captcha, false);
});

test("un vídeo plano (ojos muertos y residual bajo) dispara captcha", () => {
  const report = humanConfidence({
    yawSpan: 0.02,
    blinkSpan: 0.02,
    residual: 0.2,
    depthRelief: 0.005,
    seenBlink: false,
    mouthSpan: 0.01,
    frames: 30,
    glanced: true,
  });
  assert.ok(report.score < HUMAN_CAPTCHA_SCORE);
  assert.equal(report.captcha, true);
  assert.ok(report.reasons.length >= 2);
});

test("en un glance de solo frente el yaw bajo no es sospechoso", () => {
  const report = humanConfidence({
    ...liveHuman(),
    yawSpan: 0.02,
    glanced: false,
  });
  assert.equal(report.captcha, false);
});

test("el umbral de enrollo es más bajo que el de login", () => {
  assert.ok(ENROLL_CAPTCHA_SCORE < HUMAN_CAPTCHA_SCORE);
});

test("foldSpeech quita acentos y mayúsculas", () => {
  assert.equal(foldSpeech("¡Rimbombante!"), "rimbombante");
  assert.equal(foldSpeech("OTORRINOLARINGÓLOGO"), "otorrinolaringologo");
});

test("wordHeard acepta el tronco de palabras muy largas", () => {
  assert.equal(wordHeard("el otorrinolaringo algo", "otorrinolaringólogo"), true);
  assert.equal(wordHeard("hola mundo", "rimbombante"), false);
});

test("wordsHeard marca cada palabra del reto", () => {
  const heard = wordsHeard(
    "dije rimbombante y luego popocatepetl",
    ["rimbombante", "murciélago", "popocatépetl"],
  );
  assert.deepEqual(heard, [true, false, true]);
});

test("SpanTracker recorre max-min de la ventana", () => {
  const span = new SpanTracker();
  span.feed(0.1);
  span.feed(0.4);
  span.feed(0.2);
  span.feed(0.35);
  assert.ok(Math.abs(span.span - 0.3) < 1e-9);
});
