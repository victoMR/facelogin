/**
 * Pruebas del proveedor OIDC.
 *
 * Todo se levanta en proceso contra un vault temporal y un par de claves de usar
 * y tirar: ni el `vault.json` ni el `.env` reales se tocan.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { createApp } from "../app.js";
import { deriveMasterKey } from "../crypto.js";
import { FaceEngine } from "../engine.js";
import { parseClients, type OidcClient } from "../oidc/clients.js";
import { generatePrivateKeyMaterial, loadKeyRing } from "../oidc/keys.js";
import { OidcProvider, type ProviderOptions } from "../oidc/provider.js";
import { resetRateLimits } from "../routes.js";
import { signSession } from "../session.js";
import { VaultStore } from "../store.js";
import { issueVoiceChallenge } from "../words.js";
import { makePersona, rng } from "./synthetic.js";

function withVoice<T extends Record<string, unknown>>(body: T) {
  const challenge = issueVoiceChallenge();
  return {
    ...body,
    voice: { id: challenge.id, transcript: challenge.words.join(" ") },
  };
}

/** Generar RSA-2048 cuesta; una sola vez para todo el archivo. */
let keyMaterial = "";
before(() => {
  keyMaterial = generatePrivateKeyMaterial();
});

const CLIENTS: unknown[] = [
  {
    client_id: "panel",
    name: "Panel interno",
    redirect_uris: ["https://app.com/callback", "http://localhost:4000/callback"],
    client_secret: "secreto-de-pruebas-suficientemente-largo",
    scopes: ["openid", "profile"],
  },
  {
    client_id: "otra-app",
    name: "Otra app",
    redirect_uris: ["https://otra.example/cb"],
    scopes: ["openid", "profile"],
  },
];

const SALT = randomBytes(32).toString("base64");

type Harness = {
  base: string;
  provider: OidcProvider;
  identityId: string;
  descriptor: number[];
  close: () => Promise<void>;
};

/**
 * Puerto libre reservado antes de construir el proveedor: el `issuer` tiene que
 * ser el origen real desde el primer instante, porque es lo que acaba en `iss` y
 * en las URL del discovery.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function harness(overrides: Partial<ProviderOptions> = {}, clients: unknown[] = CLIENTS): Promise<Harness> {
  resetRateLimits();
  const vaultPath = join(mkdtempSync(join(tmpdir(), "facelogin-oidc-")), "vault.json");
  const store = new VaultStore(vaultPath);
  const engine = new FaceEngine(store, deriveMasterKey("master-de-pruebas"), "semilla-test", "hmac-test");

  const persona = makePersona(rng(1337), {
    crossCosine: 0.9,
    withinCosine: 0.95,
    perCondition: 6,
    conditionCount: 1,
  });
  const samples = persona.samplesByCondition[0];
  const template = engine.enroll("Ana Prueba", samples);

  const parsed: OidcClient[] = parseClients(clients);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const provider = new OidcProvider({
    issuer: base,
    appOrigin: "http://localhost:5173",
    keyRing: await loadKeyRing(keyMaterial),
    clients: parsed,
    pairwiseSalt: SALT,
    ...overrides,
  });

  const app = createApp({
    engine,
    sessionSecret: "sesion-de-pruebas",
    allowedOrigins: ["http://localhost:5173"],
    appOrigin: "http://localhost:5173",
    provider,
  });
  const server: Server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    base,
    provider,
    identityId: template.id,
    descriptor: samples[0],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Lee el cuerpo UNA vez y solo entonces comprueba el estado, para que el texto
 * pueda usarse como mensaje del fallo sin dejar el stream consumido.
 */
async function expectJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

function verifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

function authorizeUrl(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${base}/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** GET /authorize sin seguir la redirección. Devuelve la respuesta cruda. */
function getAuthorize(base: string, params: Record<string, string | undefined>): Promise<Response> {
  return fetch(authorizeUrl(base, params), { redirect: "manual" });
}

/** Recorre /authorize + login facial + /api/oidc/approve y devuelve la URL de vuelta. */
async function runAuthorization(
  h: Harness,
  params: Record<string, string | undefined>,
  options: { useIdentify?: boolean } = {},
): Promise<{ redirect: URL }> {
  const authorize = await getAuthorize(h.base, params);
  assert.equal(authorize.status, 302);
  const toApp = new URL(authorize.headers.get("location") as string);
  const requestId = toApp.searchParams.get("oidc");
  assert.ok(requestId, "falta el identificador de la petición en la vuelta a la interfaz");

  // La interfaz puede preguntar quién pide el login antes de encender la cámara.
  const described = await fetch(`${h.base}/api/oidc/request/${encodeURIComponent(requestId)}`);
  assert.equal(described.status, 200);

  let sessionToken: string;
  if (options.useIdentify) {
    const identified = await fetch(`${h.base}/api/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withVoice({ descriptor: h.descriptor })),
    });
    sessionToken = (await expectJson<{ token: string }>(identified, 200)).token;
  } else {
    sessionToken = await signSession("sesion-de-pruebas", { sub: h.identityId, name: "Ana Prueba" });
  }

  const approved = await fetch(`${h.base}/api/oidc/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ requestId }),
  });
  const { redirect } = await expectJson<{ redirect: string }>(approved, 200);
  return { redirect: new URL(redirect) };
}

function tokenBody(fields: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return body;
}

function basic(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

async function localJwks(base: string) {
  const response = await fetch(`${base}/.well-known/jwks.json`);
  return createLocalJWKSet((await response.json()) as { keys: JWK[] });
}

const BASE_PARAMS = {
  client_id: "panel",
  redirect_uri: "https://app.com/callback",
  response_type: "code",
  scope: "openid profile",
};

// ---------------------------------------------------------------- descubrimiento

test("el discovery anuncia code + PKCE S256 + sub pairwise y RS256", async () => {
  const h = await harness();
  try {
    const document = (await (await fetch(`${h.base}/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(document.issuer, h.base);
    assert.equal(document.authorization_endpoint, `${h.base}/authorize`);
    assert.equal(document.token_endpoint, `${h.base}/token`);
    assert.equal(document.jwks_uri, `${h.base}/.well-known/jwks.json`);
    assert.deepEqual(document.response_types_supported, ["code"]);
    assert.deepEqual(document.subject_types_supported, ["pairwise"]);
    assert.deepEqual(document.id_token_signing_alg_values_supported, ["RS256"]);
    // `plain` no aparece: si apareciera, un cliente podría negociarlo.
    assert.deepEqual(document.code_challenge_methods_supported, ["S256"]);
  } finally {
    await h.close();
  }
});

test("el JWKS publica la clave pública con kid y NO expone material privado", async () => {
  const h = await harness();
  try {
    const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
    assert.equal(jwks.keys.length, 1);
    const [key] = jwks.keys;
    assert.equal(key.kty, "RSA");
    assert.equal(key.alg, "RS256");
    assert.equal(key.use, "sig");
    assert.ok(key.kid && key.kid.length > 0, "el kid es lo que permite rotar sin romper clientes");
    assert.ok(key.n && key.e);
    for (const secret of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
      assert.equal(secret in key, false, `el JWKS expone el campo privado ${secret}`);
    }
    // Y en el JSON crudo tampoco, por si algún día se serializa a mano.
    const raw = await (await fetch(`${h.base}/.well-known/jwks.json`)).text();
    assert.equal(/"[dpq]"\s*:/.test(raw), false);
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------- flujo feliz

test("flujo completo: /authorize → cara → /token, y el id_token verifica contra el JWKS", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(
      h,
      {
        ...BASE_PARAMS,
        state: "estado-opaco-del-cliente",
        nonce: "nonce-unico-123",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      { useIdentify: true },
    );

    assert.equal(redirect.origin + redirect.pathname, "https://app.com/callback");
    const code = redirect.searchParams.get("code");
    assert.ok(code);

    const response = await fetch(`${h.base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
      },
      body: tokenBody({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.com/callback",
        code_verifier: verifier,
      }),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const tokens = await expectJson<{
      id_token: string;
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(response, 200);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.scope, "openid profile");

    // Verificación tal cual la haría el cliente: JWKS público, alg fijado.
    assert.equal(decodeProtectedHeader(tokens.id_token).alg, "RS256");
    assert.ok(decodeProtectedHeader(tokens.id_token).kid);
    const { payload } = await jwtVerify(tokens.id_token, await localJwks(h.base), {
      issuer: h.base,
      audience: "panel",
      algorithms: ["RS256"],
    });
    assert.equal(payload.nonce, "nonce-unico-123");
    assert.ok(typeof payload.sub === "string" && payload.sub.length > 0);
    assert.notEqual(payload.sub, h.identityId, "el sub NUNCA es el id interno de la identidad");
    assert.ok(typeof payload.auth_time === "number");
    assert.ok(typeof payload.iat === "number" && typeof payload.exp === "number");
    assert.ok((payload.exp as number) > (payload.iat as number));
    assert.deepEqual(payload.amr, ["face"]);
    assert.equal(payload.name, "Ana Prueba");

    // Y el access_token sirve en /userinfo, con los claims del scope concedido.
    const userinfo = await fetch(`${h.base}/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(userinfo.status, 200);
    assert.deepEqual(await userinfo.json(), { sub: payload.sub, name: "Ana Prueba" });
  } finally {
    await h.close();
  }
});

test("state y nonce viajan intactos: el state vuelve en la redirección y el nonce llega al id_token", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const state = 'estado con espacios/&=?#raro"';
    const nonce = "nonce-que-el-cliente-guardó";
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    assert.equal(redirect.searchParams.get("state"), state);

    const tokens = (await (
      await fetch(`${h.base}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
        },
        body: tokenBody({
          grant_type: "authorization_code",
          code: redirect.searchParams.get("code") as string,
          redirect_uri: "https://app.com/callback",
          code_verifier: verifier,
        }),
      })
    ).json()) as { id_token: string };
    const { payload } = await jwtVerify(tokens.id_token, await localJwks(h.base), {
      issuer: h.base,
      audience: "panel",
    });
    assert.equal(payload.nonce, nonce);
  } finally {
    await h.close();
  }
});

// -------------------------------------------------------------------------- PKCE

test("PKCE: un code_verifier incorrecto no canjea el código", async () => {
  const h = await harness();
  try {
    const { challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const otro = randomBytes(32).toString("base64url");
    const response = await fetch(`${h.base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
      },
      body: tokenBody({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code") as string,
        redirect_uri: "https://app.com/callback",
        code_verifier: otro,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
  } finally {
    await h.close();
  }
});

test("PKCE: code_challenge_method=plain se rechaza", async () => {
  const h = await harness();
  try {
    const response = await getAuthorize(h.base, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "plain",
    });
    assert.equal(response.status, 302);
    const back = new URL(response.headers.get("location") as string);
    assert.equal(back.origin + back.pathname, "https://app.com/callback");
    assert.equal(back.searchParams.get("error"), "invalid_request");
    assert.match(back.searchParams.get("error_description") as string, /S256/);
    assert.equal(back.searchParams.get("state"), "s");
    assert.equal(back.searchParams.has("code"), false);
  } finally {
    await h.close();
  }
});

test("PKCE: sin code_challenge no hay autorización, ni siquiera para un cliente confidencial", async () => {
  const h = await harness();
  try {
    const response = await getAuthorize(h.base, { ...BASE_PARAMS, state: "s", nonce: "n" });
    assert.equal(response.status, 302);
    const back = new URL(response.headers.get("location") as string);
    assert.equal(back.searchParams.get("error"), "invalid_request");
    assert.match(back.searchParams.get("error_description") as string, /PKCE/);
    assert.equal(back.searchParams.has("code"), false);
  } finally {
    await h.close();
  }
});

// ----------------------------------------------------------- código de un solo uso

test("el código es de un solo uso: el segundo canje falla e invalida los tokens ya emitidos", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = redirect.searchParams.get("code") as string;
    const exchange = () =>
      fetch(`${h.base}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
        },
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://app.com/callback",
          code_verifier: verifier,
        }),
      });

    const first = await exchange();
    assert.equal(first.status, 200);
    const { access_token } = (await first.json()) as { access_token: string };

    // Antes del replay el token funciona.
    assert.equal(
      (await fetch(`${h.base}/userinfo`, { headers: { Authorization: `Bearer ${access_token}` } })).status,
      200,
    );

    const second = await exchange();
    assert.equal(second.status, 400);
    assert.equal(((await second.json()) as { error: string }).error, "invalid_grant");

    // Reutilizar el código significa que alguien más lo tenía: lo ya emitido cae.
    const after = await fetch(`${h.base}/userinfo`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    assert.equal(after.status, 401);
    assert.equal(((await after.json()) as { error: string }).error, "invalid_token");
  } finally {
    await h.close();
  }
});

test("un código expirado no se canjea", async () => {
  const h = await harness({ codeTtlMs: 5 });
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const response = await fetch(`${h.base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
      },
      body: tokenBody({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code") as string,
        redirect_uri: "https://app.com/callback",
        code_verifier: verifier,
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; error_description: string };
    assert.equal(body.error, "invalid_grant");
    assert.match(body.error_description, /expirado/);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------- redirect_uri

test("una redirect_uri fuera de la allowlist se rechaza y NO se redirige a ella", async () => {
  const h = await harness();
  try {
    const response = await getAuthorize(h.base, {
      ...BASE_PARAMS,
      redirect_uri: "https://attacker.net/callback",
      state: "s",
      nonce: "n",
      code_challenge: verifierAndChallenge().challenge,
      code_challenge_method: "S256",
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null, "un error nunca se reenvía a una URI sin verificar");
  } finally {
    await h.close();
  }
});

test("una redirect_uri que solo coincide por prefijo se rechaza (https://app.com.attacker.net)", async () => {
  const h = await harness();
  try {
    for (const hostil of [
      "https://app.com.attacker.net/callback",
      "https://app.com@attacker.net/callback",
      "https://app.com/callback/../../evil",
      "https://app.com/callback?extra=1",
      "https://app.com/Callback",
    ]) {
      const response = await getAuthorize(h.base, {
        ...BASE_PARAMS,
        redirect_uri: hostil,
        state: "s",
        nonce: "n",
        code_challenge: verifierAndChallenge().challenge,
        code_challenge_method: "S256",
      });
      assert.equal(response.status, 400, `debería rechazarse: ${hostil}`);
      assert.equal(response.headers.get("location"), null);
    }
  } finally {
    await h.close();
  }
});

test("/token exige la misma redirect_uri que /authorize", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const response = await fetch(`${h.base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo"),
      },
      body: tokenBody({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code") as string,
        // También está en la allowlist del cliente, pero no es la de esta petición.
        redirect_uri: "http://localhost:4000/callback",
        code_verifier: verifier,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
  } finally {
    await h.close();
  }
});

test("un client_id desconocido no redirige a ningún lado", async () => {
  const h = await harness();
  try {
    const response = await getAuthorize(h.base, {
      ...BASE_PARAMS,
      client_id: "no-existe",
      state: "s",
      nonce: "n",
      code_challenge: verifierAndChallenge().challenge,
      code_challenge_method: "S256",
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ sub pairwise

test("sub pairwise: distinto en dos clientes, estable en el mismo cliente entre sesiones", async () => {
  const h = await harness();
  try {
    async function subFor(clientId: string, redirectUri: string, secret?: string): Promise<string> {
      const { verifier, challenge } = verifierAndChallenge();
      const { redirect } = await runAuthorization(h, {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile",
        state: "s",
        nonce: `n-${Math.random()}`,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const response = await fetch(`${h.base}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(secret ? { Authorization: basic(clientId, secret) } : {}),
        },
        body: tokenBody({
          grant_type: "authorization_code",
          code: redirect.searchParams.get("code") as string,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          ...(secret ? {} : { client_id: clientId }),
        }),
      });
      const { id_token } = await expectJson<{ id_token: string }>(response, 200);
      const { payload } = await jwtVerify(id_token, await localJwks(h.base), {
        issuer: h.base,
        audience: clientId,
      });
      return payload.sub as string;
    }

    const secret = "secreto-de-pruebas-suficientemente-largo";
    const panelPrimera = await subFor("panel", "https://app.com/callback", secret);
    const panelSegunda = await subFor("panel", "https://app.com/callback", secret);
    const otra = await subFor("otra-app", "https://otra.example/cb");

    assert.equal(panelPrimera, panelSegunda, "el sub debe servir como clave primaria en el cliente");
    assert.notEqual(
      panelPrimera,
      otra,
      "dos servicios que crucen sus bases no deben poder deducir que es la misma cara",
    );
    // Y ninguno de los dos es el id interno.
    assert.notEqual(panelPrimera, h.identityId);
    assert.notEqual(otra, h.identityId);
  } finally {
    await h.close();
  }
});

// -------------------------------------------------------- clientes y userinfo

test("un cliente confidencial sin secreto, o con el secreto equivocado, no canjea", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = redirect.searchParams.get("code") as string;
    const attempt = (headers: Record<string, string>) =>
      fetch(`${h.base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://app.com/callback",
          code_verifier: verifier,
          client_id: "panel",
        }),
      });

    assert.equal((await attempt({})).status, 401);
    assert.equal((await attempt({ Authorization: basic("panel", "secreto-equivocado-pero-largo") })).status, 401);
    // Y el código sigue vivo: fallar la autenticación de cliente no lo consume.
    assert.equal(
      (await attempt({ Authorization: basic("panel", "secreto-de-pruebas-suficientemente-largo") })).status,
      200,
    );
  } finally {
    await h.close();
  }
});

test("userinfo sirve solo los claims del scope concedido", async () => {
  const h = await harness();
  try {
    const { verifier, challenge } = verifierAndChallenge();
    const { redirect } = await runAuthorization(h, {
      client_id: "otra-app",
      redirect_uri: "https://otra.example/cb",
      response_type: "code",
      scope: "openid",
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const tokens = (await (
      await fetch(`${h.base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody({
          grant_type: "authorization_code",
          code: redirect.searchParams.get("code") as string,
          redirect_uri: "https://otra.example/cb",
          code_verifier: verifier,
          client_id: "otra-app",
        }),
      })
    ).json()) as { access_token: string; id_token: string };

    const claims = (await (
      await fetch(`${h.base}/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    ).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(claims), ["sub"], "sin scope profile no se manda el nombre");

    const { payload } = await jwtVerify(tokens.id_token, await localJwks(h.base), {
      issuer: h.base,
      audience: "otra-app",
    });
    assert.equal(payload.name, undefined);

    // Sin bearer, 401 con la cabecera que exige el estándar.
    const anon = await fetch(`${h.base}/userinfo`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get("www-authenticate") ?? "", /Bearer/);
  } finally {
    await h.close();
  }
});

test("cancelar devuelve access_denied al cliente, con el state, y quema la petición", async () => {
  const h = await harness();
  try {
    const authorize = await getAuthorize(h.base, {
      ...BASE_PARAMS,
      state: "s-cancelado",
      nonce: "n",
      code_challenge: verifierAndChallenge().challenge,
      code_challenge_method: "S256",
    });
    const requestId = new URL(authorize.headers.get("location") as string).searchParams.get(
      "oidc",
    ) as string;

    const denied = await expectJson<{ redirect: string }>(
      await fetch(`${h.base}/api/oidc/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      }),
      200,
    );
    const back = new URL(denied.redirect);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "s-cancelado");
    assert.equal(back.searchParams.has("code"), false);

    // Y la petición ya no existe: no se puede aprobar después de cancelarla.
    const token = await signSession("sesion-de-pruebas", { sub: h.identityId, name: "Ana Prueba" });
    const approved = await fetch(`${h.base}/api/oidc/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId }),
    });
    assert.equal(approved.status, 400);
  } finally {
    await h.close();
  }
});

test("una sesión vieja no sirve para un cliente OIDC: la autenticación tiene que ser reciente", async () => {
  const h = await harness();
  try {
    const authorize = await getAuthorize(h.base, {
      ...BASE_PARAMS,
      state: "s",
      nonce: "n",
      code_challenge: verifierAndChallenge().challenge,
      code_challenge_method: "S256",
    });
    const requestId = new URL(authorize.headers.get("location") as string).searchParams.get(
      "oidc",
    ) as string;

    // JWT de sesión válido (8 h) pero emitido hace más del max_age por defecto.
    const viejo = await new (await import("jose")).SignJWT({ sub: h.identityId, name: "Ana Prueba" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime("8h")
      .sign(new TextEncoder().encode("sesion-de-pruebas"));

    const approved = await fetch(`${h.base}/api/oidc/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${viejo}` },
      body: JSON.stringify({ requestId }),
    });
    assert.equal(approved.status, 400);
    assert.match(((await approved.json()) as { error: string }).error, /antigua/);
  } finally {
    await h.close();
  }
});

test("los endpoints públicos contestan el preflight CORS de cualquier origen", async () => {
  const h = await harness();
  try {
    for (const path of ["/token", "/userinfo", "/.well-known/jwks.json"]) {
      const preflight = await fetch(`${h.base}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://spa.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.ok(preflight.status < 300, `${path} devolvió ${preflight.status}`);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    }
    // La API propia sigue restringida a la interfaz de facelogin.
    const propia = await fetch(`${h.base}/api/identify`, {
      method: "OPTIONS",
      headers: { Origin: "https://spa.example", "Access-Control-Request-Method": "POST" },
    });
    assert.notEqual(propia.headers.get("access-control-allow-origin"), "*");
  } finally {
    await h.close();
  }
});

test("un scope no concedido al cliente se rechaza en /authorize", async () => {
  const h = await harness({}, [
    {
      client_id: "solo-openid",
      name: "Solo openid",
      redirect_uris: ["https://solo.example/cb"],
      scopes: ["openid"],
    },
  ]);
  try {
    const response = await getAuthorize(h.base, {
      client_id: "solo-openid",
      redirect_uri: "https://solo.example/cb",
      response_type: "code",
      scope: "openid profile",
      state: "s",
      nonce: "n",
      code_challenge: verifierAndChallenge().challenge,
      code_challenge_method: "S256",
    });
    assert.equal(response.status, 302);
    const back = new URL(response.headers.get("location") as string);
    assert.equal(back.searchParams.get("error"), "invalid_scope");
  } finally {
    await h.close();
  }
});

test("el registro rechaza callbacks http fuera de loopback sin permiso explícito", () => {
  assert.throws(
    () =>
      parseClients([
        {
          client_id: "x",
          name: "X",
          redirect_uris: ["http://intranet.example/cb"],
        },
      ]),
    /TLS/,
  );
  assert.doesNotThrow(() =>
    parseClients([
      {
        client_id: "x",
        name: "X",
        redirect_uris: ["http://intranet.example/cb"],
        allow_insecure_redirect: true,
      },
    ]),
  );
});

test("el enrollo y el login propios siguen intactos con el IdP encendido", async () => {
  const h = await harness();
  try {
    const health = await fetch(`${h.base}/api/health`);
    assert.deepEqual(await health.json(), { ok: true, mode: "face-only" });

    const identified = await fetch(`${h.base}/api/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withVoice({ descriptor: h.descriptor })),
    });
    assert.equal(identified.status, 200);
    const { token, identity } = (await identified.json()) as {
      token: string;
      identity: { id: string; displayName: string };
    };
    assert.equal(identity.id, h.identityId);

    const me = await fetch(`${h.base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(await me.json(), { id: h.identityId, displayName: "Ana Prueba" });

    // El 401 de identify sigue siendo opaco: ni score ni threshold.
    const rechazado = await fetch(`${h.base}/api/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ descriptor: Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)) }),
    });
    assert.equal(rechazado.status, 401);
    const body = (await rechazado.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
  } finally {
    await h.close();
  }
});
