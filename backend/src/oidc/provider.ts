/**
 * Proveedor OpenID Connect: authorization code flow + PKCE (S256 obligatorio).
 *
 * La garantía central es lo que el cliente NO recibe. Nunca ve un descriptor, ni
 * el vault, ni la master key: recibe un `id_token` firmado que dice quién es el
 * usuario. Repartir la tabla cifrada y su clave entre N servicios convertiría
 * cualquier filtración en uno solo de ellos en el descifrado de todas las
 * plantillas de todos los usuarios — y una cara no se rota como una contraseña.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createRegistry, secretMatches, type ClientRegistry, type OidcClient } from "./clients.js";
import { jwksOf, type KeyRing } from "./keys.js";
import { OidcStore, type PendingRequest } from "./store.js";
import { pairwiseSubject } from "./subject.js";

export type ProviderOptions = {
  issuer: string;
  /** Origen de la interfaz donde vive el flujo facial. */
  appOrigin: string;
  keyRing: KeyRing;
  /** Lista estática o un registro vivo (p. ej. ManagedClientRegistry). */
  clients: OidcClient[] | ClientRegistry;
  pairwiseSalt: string;
  codeTtlMs?: number;
  requestTtlMs?: number;
  replayWindowMs?: number;
  accessTokenTtlSec?: number;
  idTokenTtlSec?: number;
  /** Antigüedad máxima por defecto de la autenticación facial, en segundos. */
  defaultMaxAgeSec?: number;
  now?: () => number;
};

/** Error que se le devuelve al cliente tal cual manda OAuth 2.0 / OIDC. */
export type OidcError = { error: string; error_description: string };

export type AuthorizeOutcome =
  /** Parámetros bien: se manda al usuario al flujo facial. */
  | { kind: "interact"; request: PendingRequest; location: string }
  /** `client_id` o `redirect_uri` no válidos: NO se redirige, se muestra el error. */
  | { kind: "fatal"; status: number; body: OidcError }
  /** El resto de errores sí vuelven al cliente por su redirect_uri. */
  | { kind: "redirect"; location: string };

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  id_token: string;
  scope: string;
};

const SUPPORTED_SCOPES = ["openid", "profile"];

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function firstValue(value: unknown): string | null {
  // Express mete arrays cuando un parámetro llega repetido. Un `state` duplicado
  // es la forma clásica de colar dos valores distintos y quedarse con el que
  // convenga: se rechaza en vez de elegir uno.
  if (typeof value === "string") return value;
  return null;
}

function redirectWithParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export class OidcProvider {
  readonly issuer: string;
  readonly appOrigin: string;
  private readonly registry: ClientRegistry;
  private readonly keyRing: KeyRing;
  private readonly store: OidcStore;
  private readonly pairwiseSalt: string;
  private readonly accessTokenTtlSec: number;
  private readonly idTokenTtlSec: number;
  private readonly defaultMaxAgeSec: number;
  private readonly now: () => number;
  /** Resolución por `kid` sobre el mismo JWKS que se publica: verificar como un cliente. */
  private readonly localJwks: ReturnType<typeof createLocalJWKSet>;

  constructor(options: ProviderOptions) {
    this.issuer = options.issuer.replace(/\/+$/, "");
    this.appOrigin = options.appOrigin.replace(/\/+$/, "");
    this.registry = Array.isArray(options.clients)
      ? createRegistry(options.clients)
      : options.clients;
    this.keyRing = options.keyRing;
    this.pairwiseSalt = options.pairwiseSalt;
    this.accessTokenTtlSec = options.accessTokenTtlSec ?? 900;
    this.idTokenTtlSec = options.idTokenTtlSec ?? 300;
    this.defaultMaxAgeSec = options.defaultMaxAgeSec ?? 300;
    this.now = options.now ?? Date.now;
    this.localJwks = createLocalJWKSet(jwksOf(this.keyRing));
    this.store = new OidcStore(
      options.requestTtlMs ?? 600_000,
      options.codeTtlMs ?? 60_000,
      options.replayWindowMs ?? 600_000,
      this.now,
    );
  }

  // ---------------------------------------------------------------- discovery

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: SUPPORTED_SCOPES,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      // Solo S256. `plain` deja el verifier a la vista de quien intercepte el
      // /authorize, que es justo lo que PKCE viene a evitar.
      code_challenge_methods_supported: ["S256"],
      claims_supported: ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "amr", "name"],
      request_parameter_supported: false,
      request_uri_parameter_supported: false,
      claims_parameter_supported: false,
    };
  }

  jwks(): unknown {
    return jwksOf(this.keyRing);
  }

  // ---------------------------------------------------------------- authorize

  authorize(query: Record<string, unknown>): AuthorizeOutcome {
    const clientId = firstValue(query.client_id);
    const redirectUri = firstValue(query.redirect_uri);

    // Estos dos se validan ANTES que nada y su fallo no se redirige: mandar un
    // error a una redirect_uri sin verificar es un redirector abierto.
    if (!clientId) {
      return this.fatal("invalid_request", "Falta client_id.");
    }
    const client = this.registry.get(clientId);
    if (!client) {
      return this.fatal("invalid_client", "client_id desconocido.");
    }
    if (!redirectUri) {
      return this.fatal("invalid_request", "Falta redirect_uri.");
    }
    // Igualdad EXACTA de cadena contra la allowlist. Nada de startsWith: con
    // prefijos, `https://app.com` deja pasar `https://app.com.attacker.net`.
    if (!client.redirect_uris.includes(redirectUri)) {
      return this.fatal(
        "invalid_request",
        "redirect_uri no está en la allowlist exacta de este cliente.",
      );
    }

    const state = firstValue(query.state);
    const fail = (error: string, description: string): AuthorizeOutcome => ({
      kind: "redirect",
      location: redirectWithParams(redirectUri, {
        error,
        error_description: description,
        ...(state ? { state } : {}),
      }),
    });

    for (const key of ["client_id", "redirect_uri", "state", "nonce", "scope", "response_type", "code_challenge", "code_challenge_method", "prompt", "max_age"]) {
      if (query[key] !== undefined && firstValue(query[key]) === null) {
        return fail("invalid_request", `El parámetro ${key} llega repetido.`);
      }
    }

    if (firstValue(query.response_type) !== "code") {
      return fail("unsupported_response_type", "Solo se admite response_type=code.");
    }

    const scopes = (firstValue(query.scope) ?? "").split(/\s+/).filter(Boolean);
    if (!scopes.includes("openid")) {
      return fail("invalid_scope", "El scope debe incluir openid.");
    }
    const unknownScope = scopes.find(
      (scope) => !SUPPORTED_SCOPES.includes(scope) || !client.scopes.includes(scope),
    );
    if (unknownScope) {
      return fail("invalid_scope", `Scope no concedido a este cliente: ${unknownScope}.`);
    }

    const codeChallenge = firstValue(query.code_challenge);
    const method = firstValue(query.code_challenge_method);
    if (!codeChallenge) {
      // PKCE es obligatorio también para clientes confidenciales: protege del
      // robo del código en el tramo del navegador, que el client_secret no cubre.
      return fail("invalid_request", "Falta code_challenge: PKCE es obligatorio.");
    }
    if (method !== "S256") {
      return fail(
        "invalid_request",
        "code_challenge_method debe ser S256. `plain` no se acepta.",
      );
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge)) {
      return fail("invalid_request", "code_challenge mal formado (base64url, 43–128 caracteres).");
    }

    const nonce = firstValue(query.nonce);
    if (!nonce) {
      // El estándar solo lo exige en el flujo implícito; aquí se exige siempre
      // porque es lo único que ata un id_token a la petición que lo pidió.
      return fail("invalid_request", "Falta nonce.");
    }

    const prompt = (firstValue(query.prompt) ?? "").split(/\s+/).filter(Boolean);
    if (prompt.includes("none")) {
      return fail("login_required", "Este proveedor siempre requiere interacción con la cámara.");
    }

    const rawMaxAge = firstValue(query.max_age);
    let maxAgeSec = this.defaultMaxAgeSec;
    if (rawMaxAge !== null) {
      const parsed = Number(rawMaxAge);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return fail("invalid_request", "max_age debe ser un entero de segundos.");
      }
      maxAgeSec = Math.min(parsed, this.defaultMaxAgeSec);
    }
    if (prompt.includes("login")) maxAgeSec = 0;

    const request = this.store.createRequest({
      clientId: client.client_id,
      clientName: client.name,
      redirectUri,
      scopes,
      state,
      nonce,
      codeChallenge,
      maxAgeSec,
    });

    // A la interfaz solo viaja un identificador opaco. Los parámetros del
    // cliente (y el nombre de quien entra) se quedan del lado servidor en vez de
    // pasearse por la barra de direcciones y el historial del navegador.
    return {
      kind: "interact",
      request,
      location: `${this.appOrigin}/?oidc=${encodeURIComponent(request.id)}`,
    };
  }

  private fatal(error: string, description: string): AuthorizeOutcome {
    return { kind: "fatal", status: error === "invalid_client" ? 401 : 400, body: { error, error_description: description } };
  }

  /** Datos que la interfaz puede enseñar antes de encender la cámara. */
  describeRequest(requestId: string): { clientName: string; scopes: string[] } | null {
    const request = this.store.readRequest(requestId);
    if (!request) return null;
    return { clientName: request.clientName, scopes: request.scopes };
  }

  /**
   * El usuario acaba de identificarse con la cara. Se emite el código y se
   * devuelve la URL de vuelta al cliente, con el `state` intacto.
   */
  approve(
    requestId: string,
    identity: { identityId: string; displayName: string; authTime: number; amr?: string[] },
  ): { ok: true; location: string } | { ok: false; reason: string } {
    const request = this.store.readRequest(requestId);
    if (!request) return { ok: false, reason: "La petición de autorización expiró o no existe." };

    const ageSec = Math.floor(this.now() / 1000) - identity.authTime;
    if (ageSec > request.maxAgeSec) {
      return {
        ok: false,
        reason: "La autenticación es demasiado antigua para este cliente. Vuelve a identificarte.",
      };
    }

    const code = this.store.issueCode(request, identity);
    return {
      ok: true,
      location: redirectWithParams(request.redirectUri, {
        code: code.code,
        ...(request.state ? { state: request.state } : {}),
      }),
    };
  }

  /**
   * El usuario dice que no. Cancelar es una respuesta legítima del estándar y
   * el cliente merece enterarse en vez de quedarse esperando en una pestaña.
   */
  deny(requestId: string): { ok: true; location: string } | { ok: false; reason: string } {
    const request = this.store.readRequest(requestId);
    if (!request) return { ok: false, reason: "La petición de autorización expiró o no existe." };
    this.store.dropRequest(requestId);
    return {
      ok: true,
      location: redirectWithParams(request.redirectUri, {
        error: "access_denied",
        error_description: "La persona canceló la verificación facial.",
        ...(request.state ? { state: request.state } : {}),
      }),
    };
  }

  // -------------------------------------------------------------------- token

  async token(
    body: Record<string, unknown>,
    basicAuth: { clientId: string; clientSecret: string } | null,
  ): Promise<{ ok: true; response: TokenResponse } | { ok: false; status: number; body: OidcError }> {
    const invalidGrant = (description: string) =>
      ({ ok: false as const, status: 400, body: { error: "invalid_grant", error_description: description } });

    if (firstValue(body.grant_type) !== "authorization_code") {
      return {
        ok: false,
        status: 400,
        body: { error: "unsupported_grant_type", error_description: "Solo authorization_code." },
      };
    }

    const bodyClientId = firstValue(body.client_id);
    const bodyClientSecret = firstValue(body.client_secret);
    if (basicAuth && bodyClientSecret) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "Elige un solo método de autenticación de cliente.",
        },
      };
    }

    const clientId = basicAuth?.clientId ?? bodyClientId;
    if (!clientId) {
      return {
        ok: false,
        status: 400,
        body: { error: "invalid_request", error_description: "Falta client_id." },
      };
    }
    const client = this.registry.get(clientId);
    // Cliente desconocido y secreto incorrecto devuelven lo mismo: no hace falta
    // decirle a quien prueba si el client_id existe.
    const unauthorized = {
      ok: false as const,
      status: 401,
      body: { error: "invalid_client", error_description: "Cliente no autenticado." },
    };
    if (!client) return unauthorized;

    if (client.confidential) {
      const provided = basicAuth?.clientSecret ?? bodyClientSecret;
      if (!provided || !secretMatches(client.client_secret as string, provided)) return unauthorized;
    } else if (basicAuth || bodyClientSecret) {
      return unauthorized;
    }

    const code = firstValue(body.code);
    if (!code) return invalidGrant("Falta code.");

    const consumed = this.store.consumeCode(code);
    if (!consumed.ok) return invalidGrant(consumed.reason);
    const record = consumed.record;

    if (record.clientId !== client.client_id) {
      // Código emitido para otro cliente: se revoca por si acaso.
      for (const jti of record.issuedJtis) this.store.revoke(jti);
      return invalidGrant("El código no pertenece a este cliente.");
    }

    const redirectUri = firstValue(body.redirect_uri);
    if (!redirectUri || redirectUri !== record.redirectUri) {
      return invalidGrant("redirect_uri no coincide con la usada en /authorize.");
    }

    const verifier = firstValue(body.code_verifier);
    if (!verifier) return invalidGrant("Falta code_verifier.");
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
      return invalidGrant("code_verifier mal formado (base64url, 43–128 caracteres).");
    }
    if (!constantTimeEquals(base64UrlSha256(verifier), record.codeChallenge)) {
      return invalidGrant("code_verifier no corresponde al code_challenge.");
    }

    const sub = pairwiseSubject(
      this.pairwiseSalt,
      client.sector_identifier ?? client.client_id,
      record.identityId,
    );
    const issuedAt = Math.floor(this.now() / 1000);
    const jti = randomBytes(16).toString("base64url");

    const idToken = await this.sign(
      {
        sub,
        aud: client.client_id,
        nonce: record.nonce ?? undefined,
        auth_time: record.authTime,
        amr: record.amr.length ? record.amr : ["face"],
        ...(record.scopes.includes("profile") ? { name: record.displayName } : {}),
      },
      issuedAt,
      this.idTokenTtlSec,
      "JWT",
    );

    const accessToken = await this.sign(
      {
        sub,
        // El access token va dirigido a ESTE servidor (userinfo), no al cliente.
        aud: this.issuer,
        client_id: client.client_id,
        scope: record.scopes.join(" "),
        jti,
        name: record.displayName,
      },
      issuedAt,
      this.accessTokenTtlSec,
      "at+jwt",
    );

    this.store.noteIssuedToken(record.code, jti);

    return {
      ok: true,
      response: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.accessTokenTtlSec,
        id_token: idToken,
        scope: record.scopes.join(" "),
      },
    };
  }

  private async sign(
    claims: JWTPayload,
    issuedAt: number,
    ttlSec: number,
    typ: string,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.keyRing.active.kid, typ })
      .setIssuer(this.issuer)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSec)
      .sign(this.keyRing.active.privateKey);
  }

  // ----------------------------------------------------------------- userinfo

  async userinfo(
    accessToken: string,
  ): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; status: number; body: OidcError }> {
    const invalid = {
      ok: false as const,
      status: 401,
      body: { error: "invalid_token", error_description: "Access token inválido, caducado o revocado." },
    };
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(accessToken, this.localJwks, {
        issuer: this.issuer,
        audience: this.issuer,
        algorithms: ["RS256"],
        typ: "at+jwt",
        currentDate: new Date(this.now()),
      });
      payload = verified.payload;
    } catch {
      return invalid;
    }

    if (typeof payload.jti !== "string" || this.store.isRevoked(payload.jti)) return invalid;

    const scopes = String(payload.scope ?? "").split(/\s+/).filter(Boolean);
    const claims: Record<string, unknown> = { sub: payload.sub };
    // Los claims se sirven según el scope CONCEDIDO, no según lo que pida quien
    // presenta el token.
    if (scopes.includes("profile") && typeof payload.name === "string") claims.name = payload.name;
    return { ok: true, claims };
  }
}
