import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aimY,
  clampView,
  remapBox,
  targetScale,
  targetView,
  Viewfinder,
  viewModeFor,
  viewWindow,
  ZOOM_MAX_EYES,
  ZOOM_MAX_WIDE,
  ZOOM_MIN,
} from "../viewfinder";

const OVAL = { stageW: 400, stageH: 800, oval: { cx: 200, cy: 380, rx: 160, ry: 208 } };

const FAR = { x: 400, y: 200, width: 120, height: 160 };
const NEAR = { x: 280, y: 80, width: 400, height: 480 };

test("viewModeFor acerca en el parpadeo y abre en los giros", () => {
  assert.equal(viewModeFor("blink"), "eyes");
  assert.equal(viewModeFor("center"), "face");
  assert.equal(viewModeFor("left"), "wide");
  assert.equal(viewModeFor("right"), "wide");
});

test("targetScale acerca una cara lejana y no pide menos que 1", () => {
  const zoom = targetScale(FAR, 960, 540, "eyes");
  assert.ok(zoom > 1.5);
  assert.ok(zoom <= ZOOM_MAX_EYES);
  assert.equal(targetScale(NEAR, 960, 540, "face"), ZOOM_MIN);
});

test("targetView no acerca si la cara ya llena el óvalo", () => {
  const view = targetView(NEAR, 960, 540, "face", OVAL);
  assert.equal(view.scale, ZOOM_MIN);
});

test("targetView acerca una cara chica hasta el óvalo, no más", () => {
  const view = targetView(FAR, 960, 540, "face", OVAL);
  assert.ok(view.scale > 1.05);
  assert.ok(view.scale <= ZOOM_MAX_WIDE + 0.5);
});

test("a 1× no hay margen de paneo", () => {
  const locked = clampView(100, 270, ZOOM_MIN, 960, 540);
  assert.equal(locked.cx, 480);
});

test("targetScale en perfil no llega al zoom de los ojos", () => {
  const eyes = targetScale(FAR, 960, 540, "eyes");
  const wide = targetScale(FAR, 960, 540, "wide");
  assert.ok(wide < eyes);
  assert.ok(wide <= ZOOM_MAX_WIDE);
});

test("clampView no deja el recorte fuera del frame", () => {
  const held = clampView(10, 10, 2, 960, 540);
  const win = viewWindow(held.cx, held.cy, held.scale, 960, 540);
  assert.ok(win.sx >= -1e-6);
  assert.ok(win.sy >= -1e-6);
  assert.ok(win.sx + win.sw <= 960 + 1e-6);
  assert.ok(win.sy + win.sh <= 540 + 1e-6);
});

test("remapBox devuelve la caja al frame completo", () => {
  const window = { sx: 200, sy: 100, sw: 480, sh: 270 };
  const box = { x: 100, y: 50, width: 200, height: 240 };
  const full = remapBox(box, window, 960, 540);
  assert.ok(Math.abs(full.x - (200 + 100 * 0.5)) < 1e-9);
  assert.ok(Math.abs(full.width - 100) < 1e-9);
});

test("aimY sube el centro en modo ojos", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.ok(aimY(box, "eyes") < aimY(box, "face"));
});

test("Viewfinder.follow acerca una cara chica y no oscila al remapear", () => {
  const view = new Viewfinder();
  for (let i = 0; i < 20; i += 1) view.follow(FAR, 960, 540, "eyes");
  assert.ok(view.scale > 1.4);
  const before = view.scale;
  const window = view.window(960, 540);
  const viewed = {
    x: ((FAR.x - window.sx) / window.sw) * 960,
    y: ((FAR.y - window.sy) / window.sh) * 540,
    width: (FAR.width / window.sw) * 960,
    height: (FAR.height / window.sh) * 540,
  };
  const mapped = remapBox(viewed, window, 960, 540);
  view.follow(mapped, 960, 540, "eyes");
  assert.ok(Math.abs(view.scale - before) < 0.15);
});

test("Viewfinder sin cara vuelve hacia 1×", () => {
  const view = new Viewfinder();
  for (let i = 0; i < 16; i += 1) view.follow(FAR, 960, 540, "eyes");
  assert.ok(view.scale > 1.3);
  for (let i = 0; i < 40; i += 1) view.follow(null, 960, 540, "eyes");
  assert.ok(view.scale < 1.15);
});

test("Viewfinder.reset olvida el encuadre", () => {
  const view = new Viewfinder();
  view.follow(FAR, 960, 540, "eyes");
  view.reset();
  assert.equal(view.scale, 1);
});
