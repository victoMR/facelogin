import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, MAX_LOGIN_DESCRIPTORS } from "../api";

test("ApiError hereda de Error", () => {
  const error = new ApiError("Test error", 400);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ApiError");
});

test("ApiError guarda el mensaje y status", () => {
  const error = new ApiError("Not found", 404);
  assert.equal(error.message, "Not found");
  assert.equal(error.status, 404);
});

test("ApiError puede llevar un código de negocio", () => {
  const error = new ApiError("Confirma con la passkey", 403, "PASSKEY_REQUIRED");
  assert.equal(error.code, "PASSKEY_REQUIRED");
});

test("ApiError status es accesible como readonly", () => {
  const error = new ApiError("Unauthorized", 401);
  assert.equal(error.status, 401);
});

test("MAX_LOGIN_DESCRIPTORS es 3", () => {
  assert.equal(MAX_LOGIN_DESCRIPTORS, 3);
});

test("ApiError maneja status 500", () => {
  const error = new ApiError("Server error", 500);
  assert.equal(error.status, 500);
});

test("ApiError maneja status 429", () => {
  const error = new ApiError("Rate limited", 429);
  assert.equal(error.status, 429);
});

test("ApiError puede ser capturado como Error", () => {
  try {
    throw new ApiError("Test", 400);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ApiError);
  }
});

test("ApiError tiene stack trace", () => {
  const error = new ApiError("Test", 400);
  assert.ok(error.stack);
  assert.ok(error.stack?.includes("ApiError"));
});

test("ApiError mensaje puede estar vacío", () => {
  const error = new ApiError("", 400);
  assert.equal(error.message, "");
});

test("ApiError status puede ser cualquier número", () => {
  const error = new ApiError("Custom", 999);
  assert.equal(error.status, 999);
});
