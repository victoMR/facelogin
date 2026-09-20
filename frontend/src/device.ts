/**
 * Clave del aparato. Como authorized_keys de SSH: aquí vive la privada
 * (no extraíble); al servidor solo viaja la pública y una firma de un nonce.
 *
 * No usamos la huella del navegador. User-agent y plataforma son la etiqueta
 * ("Mac · Chrome"), no la prueba. Google hace lo mismo: el aparato se
 * reconoce por una clave, y si es nuevo te pide confirmarlo.
 */

const DB = "facelogin.device";
const STORE = "keys";
const KEY_ID = "local";
const TRUST_FLAG = "facelogin.deviceTrusted";

export type DeviceIdentity = {
  id: string;
  publicKey: string;
  label: string;
};

export function deviceLabel(): string {
  const ua = (
    navigator as Navigator & {
      userAgentData?: { platform?: string; brands?: { brand: string }[] };
    }
  ).userAgentData;
  if (ua?.platform) {
    const brand = ua.brands?.find((item) => item.brand && item.brand !== "Not=A?Brand")?.brand;
    return `${ua.platform}${brand ? ` · ${brand}` : ""}`;
  }
  const platform = navigator.platform || "Aparato";
  const browser = /Edg\//.test(navigator.userAgent)
    ? "Edge"
    : /Chrome\//.test(navigator.userAgent)
      ? "Chrome"
      : /Safari\//.test(navigator.userAgent)
        ? "Safari"
        : /Firefox\//.test(navigator.userAgent)
          ? "Firefox"
          : "navegador";
  return `${platform} · ${browser}`;
}

export function isDeviceTrustedLocally(): boolean {
  try {
    return localStorage.getItem(TRUST_FLAG) === "1";
  } catch {
    return false;
  }
}

export function markDeviceTrustedLocally(): void {
  try {
    localStorage.setItem(TRUST_FLAG, "1");
  } catch {
    /* cuota / modo privado */
  }
}

export function clearDeviceTrustLocally(): void {
  try {
    localStorage.removeItem(TRUST_FLAG);
  } catch {
    /* nada */
  }
}

export async function ensureDevice(): Promise<DeviceIdentity> {
  const existing = await loadKeys();
  if (existing) return toIdentity(existing.publicKey);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const publicKey = await crypto.subtle.exportKey("spki", pair.publicKey);
  await saveKeys(pair.privateKey, publicKey);
  return toIdentity(publicKey);
}

export async function signDeviceNonce(nonce: string): Promise<string> {
  const keys = await loadKeys();
  if (!keys) throw new Error("Este aparato todavía no tiene clave.");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(nonce),
  );
  return bytesToB64(new Uint8Array(signature));
}

export async function deviceProof(): Promise<DeviceIdentity & { signature: string; nonce: string }> {
  const device = await ensureDevice();
  const nonce = await fetchNonce();
  const signature = await signDeviceNonce(nonce);
  return { ...device, signature, nonce };
}

async function fetchNonce(): Promise<string> {
  const response = await fetch("/api/device/challenge");
  const body = (await response.json().catch(() => ({}))) as { nonce?: string; error?: string };
  if (!response.ok || !body.nonce) throw new Error(body.error ?? "No hay desafío del aparato.");
  return body.nonce;
}

async function toIdentity(publicKey: ArrayBuffer): Promise<DeviceIdentity> {
  const raw = bytesToB64(new Uint8Array(publicKey));
  const digest = await crypto.subtle.digest("SHA-256", publicKey);
  return {
    id: bytesToB64Url(new Uint8Array(digest)),
    publicKey: raw,
    label: deviceLabel(),
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveKeys(privateKey: CryptoKey, publicKey: ArrayBuffer): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ privateKey, publicKey }, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadKeys(): Promise<{ privateKey: CryptoKey; publicKey: ArrayBuffer } | null> {
  if (!("indexedDB" in globalThis) || !globalThis.crypto?.subtle) return null;
  try {
    const db = await openDb();
    const value = await new Promise<{ privateKey: CryptoKey; publicKey: ArrayBuffer } | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(KEY_ID);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
