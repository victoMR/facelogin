export type EnrollResult = {
  id: string;
  displayName: string;
  samples: number;
  threshold: number;
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
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Error de red");
  }
  return body;
}

export function enroll(displayName: string, samples: number[][]): Promise<EnrollResult> {
  return request("/api/enroll", {
    method: "POST",
    body: JSON.stringify({ displayName, samples }),
  });
}

export function identify(descriptor: number[]): Promise<IdentifyResult> {
  return request("/api/identify", {
    method: "POST",
    body: JSON.stringify({ descriptor }),
  });
}

export function me(token: string): Promise<{ id: string; displayName: string }> {
  return request("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}
