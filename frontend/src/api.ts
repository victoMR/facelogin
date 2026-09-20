/** Un sub-cluster del enrollo: una condición de captura con su propia coherencia. */
export type EnrollCondition = {
  label: string;
  samples: number;
  intraMean: number;
  intraStd: number;
};

export type EnrollResult = {
  id: string;
  displayName: string;
  samples: number;
  conditions: EnrollCondition[];
  /** Coseno entre condiciones: cuánto separan los lentes a la misma cara. */
  interConditionCosine: number | null;
  /** Informativo: umbral vigente en el instante del enrollo, no el que aplica al entrar. */
  thresholdAtEnroll: number;
  intraMean: number;
  intraStd: number;
};

export type IdentifyResult = {
  token: string;
  identity: { id: string; displayName: string };
  score: number;
  threshold: number;
  candidates: number;
  latencyMs: number;
  reason: string;
  /** Sub-cluster que ganó el match ("con-lentes", "sin-lentes", "default"). */
  condition: string | null;
  trustedDevice?: boolean;
  newDevice?: boolean;
  deviceLabel?: string | null;
};

export type DeviceInfo = { id: string; publicKey: string; label: string };
export type DeviceProof = DeviceInfo & { signature: string; nonce: string };

/**
 * Error de la API con su código HTTP.
 *
 * El código sirve para **distinguir un rechazo de un fallo**: un 401 de
 * `/api/identify` significa "no coincide" y la interfaz puede sugerir mejorar la
 * toma; un 429 significa "espera" y un 500 significa que algo se rompió, y en
 * esos dos casos hablar de la luz sería absurdo.
 *
 * Lo que **no** viaja es ningún número del motor: el cuerpo del 401 es opaco a
 * propósito (sin `score` ni `threshold`) porque devolverlos convertiría el
 * endpoint en un oráculo con el que escalar un descriptor sintético hasta pasar
 * el umbral. El código de estado no dice nada de lo cerca que estuvo nadie.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? "Error de red", response.status, body.code);
  }
  return body;
}

export type VoiceChallenge = { id: string; words: string[]; expiresAt: number };
export type VoiceProof = { id: string; transcript: string };

export function voiceChallenge(): Promise<VoiceChallenge> {
  return request("/api/voice/challenge");
}

export type ConditionSamples = { label: string; samples: number[][] };

/**
 * Enrollo multi-condición. Cada condición viaja como su propio sub-cluster: el
 * servidor mide la coherencia por condición y guarda un centroide por cada una.
 * Promediarlas aquí en un solo vector dejaría el centroide en tierra de nadie.
 */
export function enroll(
  displayName: string,
  conditions: ConditionSamples[],
  shape?: number[],
  device?: DeviceInfo,
): Promise<EnrollResult> {
  return request("/api/enroll", {
    method: "POST",
    body: JSON.stringify({ displayName, conditions, shape, device }),
  });
}

/**
 * Se mandan varios descriptores del mismo intento y el servidor se queda con el
 * mejor. Antes se enviaba solo el último, que es el frame del parpadeo: el peor
 * de la sesión. El servidor cobra `multiProbePenalty` por el máximo de N, así
 * que mandar más no es gratis; `MAX_LOGIN_DESCRIPTORS` es el tope útil medido.
 */
export const MAX_LOGIN_DESCRIPTORS = 3;

export type PasskeyAssertion = {
  ticket: string;
  assertion: {
    id: string;
    rawId: string;
    type: "public-key";
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
  };
};

export function identify(
  descriptors: number[][],
  shape?: number[],
  device?: DeviceProof,
  passkey?: PasskeyAssertion,
): Promise<IdentifyResult> {
  return request("/api/identify", {
    method: "POST",
    body: JSON.stringify({
      descriptors: descriptors.slice(0, MAX_LOGIN_DESCRIPTORS),
      shape,
      device,
      passkey,
    }),
  });
}

export function passkeyRegisterOptions(
  token: string,
): Promise<{ ticket: string; options: Record<string, unknown> }> {
  return request("/api/webauthn/register/options", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function passkeyRegister(
  token: string,
  body: { ticket: string; credential: unknown },
): Promise<{ ok: boolean; id: string }> {
  return request("/api/webauthn/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export function passkeyAuthenticateOptions(): Promise<{ ticket: string; options: Record<string, unknown> }> {
  return request("/api/webauthn/authenticate/options");
}

export function trustDevice(
  token: string,
  device: DeviceProof,
  passkey?: PasskeyAssertion,
): Promise<{ id: string; label: string; trusted: boolean }> {
  return request("/api/device/trust", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device, passkey }),
  });
}

export function listDevices(
  token: string,
): Promise<{ devices: { id: string; label: string; trustedAt: string; lastSeenAt: string }[] }> {
  return request("/api/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function listIdentities(): Promise<{ count: number }> {
  return request("/api/identities");
}

export function clearIdentities(): Promise<{ ok: boolean; removed: number }> {
  return request("/api/identities", { method: "DELETE" });
}

export function me(token: string): Promise<{ id: string; displayName: string }> {
  return request("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/* --------------------------------------------------------------------- OIDC */

/** Lo poco que la interfaz necesita saber de la petición: quién y para qué. */
export type OidcRequestInfo = { clientName: string; scopes: string[] };

/**
 * El `/authorize` del backend guarda los parámetros del cliente y manda aquí
 * solo un identificador opaco. Ni el `client_id`, ni la `redirect_uri`, ni el
 * `nonce` pasean por la barra de direcciones de quien entra.
 */
export function oidcRequest(requestId: string): Promise<OidcRequestInfo> {
  return request(`/api/oidc/request/${encodeURIComponent(requestId)}`);
}

/**
 * Canjea la sesión facial recién abierta por un código de autorización. Lo que
 * cruza es el JWT de sesión, nunca un descriptor: el servicio cliente no ve —ni
 * verá— la plantilla biométrica.
 */
export function oidcApprove(requestId: string, token: string): Promise<{ redirect: string }> {
  return request("/api/oidc/approve", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId }),
  });
}

/** Cancelar también es una respuesta: el cliente recibe `access_denied`. */
export function oidcDeny(requestId: string): Promise<{ redirect: string }> {
  return request("/api/oidc/deny", {
    method: "POST",
    body: JSON.stringify({ requestId }),
  });
}
