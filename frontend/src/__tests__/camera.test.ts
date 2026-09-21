import assert from "node:assert/strict";
import { test } from "node:test";
import { constraintsFor, streamResolution } from "../camera";
import type { DeviceProfile } from "../perf";

const profile = {
  capture: { width: 640, height: 480 },
} as DeviceProfile;

test("constraintsFor pide solo vídeo por defecto", () => {
  const list = constraintsFor(profile);
  assert.equal(list.length, 3);
  assert.equal(list.every((item) => item.audio === false), true);
});

test("constraintsFor pide micrófono junto con la cámara cuando audio=true", () => {
  const list = constraintsFor(profile, { audio: true });
  assert.equal(list.every((item) => item.audio === true), true);
  assert.equal(Boolean(list[0]?.video), true);
});

// Estos tests son solo para funciones puras que no dependen del navegador

test("streamResolution devuelve guión para stream null", () => {
  const result = streamResolution(null);
  assert.equal(result, "—");
});


test("streamResolution devuelve guión para stream sin tracks", () => {
  const mockStream = { getVideoTracks: () => [] } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "—");
});

test("streamResolution devuelve guión para track sin settings", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({}) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "—");
});

test("streamResolution formatea ancho y alto", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720 }) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "1280×720");
});

test("streamResolution incluye frameRate si está presente", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "1280×720 @ 30 fps");
});

test("streamResolution redondea frameRate", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720, frameRate: 29.97 }) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "1280×720 @ 30 fps");
});

test("streamResolution maneja solo width presente", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 1280 }) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "—");
});

test("streamResolution maneja solo height presente", () => {
  const mockStream = {
    getVideoTracks: () => [{ getSettings: () => ({ height: 720 }) }],
  } as any;
  const result = streamResolution(mockStream);
  assert.equal(result, "—");
});
