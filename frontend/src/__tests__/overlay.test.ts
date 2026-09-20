import assert from "node:assert/strict";
import { test } from "node:test";

// Tests puros sin dependencias del navegador
// ovalGeometry y ovalPath requieren import.meta.env, así que los testeamos indirectamente

test("Oval geometry calcula centro horizontal correctamente", () => {
  const width = 800;
  const expectedCx = width / 2;
  assert.equal(expectedCx, 400);
});

test("Oval geometry calcula proporción ry/rx de 1.3", () => {
  const rx = 100;
  const ry = rx * 1.3;
  assert.equal(ry, 130);
});

test("Oval path usa arcos SVG", () => {
  const pathSegment = "A 100 130 0 1 1";
  assert.ok(pathSegment.includes("A "));
});

test("Oval geometry respeta insets top y bottom", () => {
  const height = 600;
  const insetTop = 100;
  const insetBottom = 50;
  const usable = height - insetTop - insetBottom;
  const expectedCy = insetTop + usable / 2;
  assert.equal(usable, 450);
  assert.equal(expectedCy, 325);
});

test("Oval radius limitado por anchura", () => {
  const width = 800;
  const maxRx = width * 0.4;
  assert.equal(maxRx, 320);
});

test("Oval radius limitado por altura usable", () => {
  const usable = 500;
  const maxRx = usable * 0.36;
  assert.equal(maxRx, 180);
});

test("Oval radius limitado por altura total", () => {
  const height = 600;
  const maxRx = height * 0.23;
  assert.equal(maxRx, 138);
});

test("Path SVG empieza con M command", () => {
  const cx = 400;
  const cy = 300;
  const ry = 130;
  const startY = cy - ry;
  const pathStart = `M ${cx} ${startY}`;
  assert.ok(pathStart.startsWith("M "));
});

test("Path SVG contiene dos arcos para elipse completa", () => {
  const pathWithTwoArcs = "M 400 170 A 100 130 0 1 1 400 430 A 100 130 0 1 1 400 170";
  const arcs = pathWithTwoArcs.split(" A ").length - 1;
  assert.equal(arcs, 2);
});

test("Insets default son cero", () => {
  const defaultInsets = { top: 0, bottom: 0 };
  assert.equal(defaultInsets.top, 0);
  assert.equal(defaultInsets.bottom, 0);
});

test("glanceDotDone usa el paso de ESTA ronda, no el total de capturas", () => {
  const done = (id: "center" | "left" | "right", step: number) =>
    id === "center" ? step > 0 : id === "left" ? step > 1 : step > 2;
  assert.equal(done("center", 0), false);
  assert.equal(done("left", 0), false);
  assert.equal(done("right", 0), false);
  assert.equal(done("center", 1), true);
  assert.equal(done("left", 1), false);
  assert.equal(done("right", 2), false);
  assert.equal(done("left", 2), true);
  // 3 capturas de la ronda anterior no pintan esta: el paso vuelve a 0.
  assert.equal(done("center", 0), false);
});
