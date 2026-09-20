import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHAPE_DIM,
  buildMesh,
  depthRelief,
  irisOffset,
  meanShape,
  meshYaw,
  mouthArticulation,
  opennessFromBlink,
  shapeSignature,
  type MeshPoint,
} from "../mesh";

function points(): MeshPoint[] {
  const list = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  list[1] = { x: 0.5, y: 0.56, z: -0.09 };
  list[4] = { x: 0.5, y: 0.6, z: -0.05 };
  list[6] = { x: 0.5, y: 0.48, z: -0.04 };
  list[10] = { x: 0.5, y: 0.32, z: 0.01 };
  list[33] = { x: 0.36, y: 0.44, z: -0.02 };
  list[133] = { x: 0.42, y: 0.44, z: -0.03 };
  list[263] = { x: 0.64, y: 0.44, z: -0.02 };
  list[362] = { x: 0.58, y: 0.44, z: -0.03 };
  list[61] = { x: 0.4, y: 0.68, z: -0.02 };
  list[291] = { x: 0.6, y: 0.68, z: -0.02 };
  list[13] = { x: 0.5, y: 0.64, z: -0.03 };
  list[14] = { x: 0.5, y: 0.72, z: -0.03 };
  list[152] = { x: 0.5, y: 0.88, z: 0.02 };
  list[234] = { x: 0.22, y: 0.55, z: 0.04 };
  list[454] = { x: 0.78, y: 0.55, z: 0.04 };
  list[127] = { x: 0.18, y: 0.5, z: 0.05 };
  list[356] = { x: 0.82, y: 0.5, z: 0.05 };
  list[168] = { x: 0.5, y: 0.42, z: -0.03 };
  list[199] = { x: 0.5, y: 0.8, z: 0.01 };
  list[98] = { x: 0.46, y: 0.58, z: -0.04 };
  list[327] = { x: 0.54, y: 0.58, z: -0.04 };
  list[468] = { x: 0.39, y: 0.44, z: -0.03 };
  list[473] = { x: 0.61, y: 0.44, z: -0.03 };
  return list;
}

test("opennessFromBlink es 1 menos el blendshape", () => {
  const open = opennessFromBlink(0.05, 0.04);
  const closed = opennessFromBlink(0.82, 0.79);
  assert.ok(open.raw > 0.9);
  assert.ok(closed.raw < 0.25);
});

test("shapeSignature tiene 64 dimensiones y norma usable", () => {
  const shape = shapeSignature(points());
  assert.equal(shape.length, SHAPE_DIM);
  assert.ok(Math.hypot(...shape) > 0.5);
});

test("meanShape promedia y normaliza", () => {
  const a = shapeSignature(points());
  const b = a.map((value, i) => value + (i === 0 ? 0.01 : 0));
  const mean = meanShape([a, b]);
  assert.equal(mean.length, SHAPE_DIM);
  const norm = Math.hypot(...mean);
  assert.ok(Math.abs(norm - 1) < 1e-6);
});

test("meshYaw es ~0 de frente y cambia al desplazar la nariz", () => {
  const front = meshYaw(points());
  const turned = points();
  turned[1] = { ...turned[1], x: 0.58 };
  const yaw = meshYaw(turned);
  assert.ok(Math.abs(front) < 0.08);
  assert.ok(Math.abs(yaw) > Math.abs(front));
});

test("depthRelief es positivo si la nariz está más cerca", () => {
  assert.ok(depthRelief(points()) > 0);
});

test("irisOffset es bajo cuando el iris está centrado", () => {
  assert.ok(irisOffset(points()) < 0.2);
});

test("mouthArticulation sube al abrir la mandíbula", () => {
  const shut = mouthArticulation([]);
  const open = mouthArticulation([
    { categoryName: "jawOpen", score: 0.8 },
    { categoryName: "mouthFunnel", score: 0.5 },
    { categoryName: "mouthPucker", score: 0.3 },
  ]);
  assert.equal(shut, 0);
  assert.ok(open > 0.45);
});

test("buildMesh incluye la boca", () => {
  const mesh = buildMesh(points(), [{ categoryName: "jawOpen", score: 0.6 }], null, 640, 480);
  assert.ok(mesh.mouth > 0.2);
});

test("buildMesh lee blendshapes de parpadeo", () => {
  const mesh = buildMesh(
    points(),
    [
      { categoryName: "eyeBlinkLeft", score: 0.81 },
      { categoryName: "eyeBlinkRight", score: 0.77 },
    ],
    null,
    960,
    540,
  );
  assert.ok(mesh.blinkLeft > 0.7);
  assert.ok(mesh.box.width > 10);
  assert.equal(mesh.pixels.length, 478);
});
