import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import type { EncryptedBlob } from "./types.js";

const ALGO = "aes-256-gcm";

export function deriveMasterKey(secret: string): Buffer {
  return scryptSync(secret, "facelogin-template-v1", 32);
}

export function encryptVector(vector: number[], key: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(new Float32Array(vector).buffer);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptVector(blob: EncryptedBlob, key: Buffer): number[] {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return Array.from(new Float32Array(plain.buffer, plain.byteOffset, plain.byteLength / 4));
}

export function hmacBucket(secret: string, table: number, bits: string): string {
  return createHmac("sha256", secret).update(`lsh:${table}:${bits}`).digest("hex");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64");
}
