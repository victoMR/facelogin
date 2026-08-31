/**
 * Estado efímero del flujo: peticiones de autorización pendientes, códigos de
 * autorización y lista de revocación.
 *
 * Todo vive en memoria a propósito. Un código dura ~60 s y no sobrevive a un
 * reinicio: perderlo solo obliga a repetir el login. Persistirlo añadiría un
 * lugar más donde queda escrito qué identidad entró a qué servicio y a qué hora,
 * que es exactamente el rastro que este diseño intenta no dejar.
 */
import { randomBytes } from "node:crypto";

export type PendingRequest = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  /** Antigüedad máxima admitida para la autenticación, en segundos. */
  maxAgeSec: number;
  expiresAt: number;
};

export type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  nonce: string | null;
  codeChallenge: string;
  identityId: string;
  displayName: string;
  authTime: number;
  expiresAt: number;
  used: boolean;
  /** `jti` de los access tokens emitidos con este código, para revocarlos si se reutiliza. */
  issuedJtis: string[];
};

const SWEEP_INTERVAL_MS = 30_000;

function randomId(): string {
  return randomBytes(32).toString("base64url");
}

export class OidcStore {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** jti revocado → instante en el que ya se puede olvidar. */
  private readonly revoked = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private readonly requestTtlMs: number,
    private readonly codeTtlMs: number,
    /**
     * Cuánto se conserva un código YA usado. Sin esta ventana, el segundo canje
     * sería indistinguible de un código inventado y no habría a quién revocar.
     */
    private readonly replayWindowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  createRequest(input: Omit<PendingRequest, "id" | "expiresAt">): PendingRequest {
    this.sweep();
    const request: PendingRequest = {
      ...input,
      id: randomId(),
      expiresAt: this.now() + this.requestTtlMs,
    };
    this.requests.set(request.id, request);
    return request;
  }

  readRequest(id: string): PendingRequest | null {
    const request = this.requests.get(id);
    if (!request) return null;
    if (request.expiresAt <= this.now()) {
      this.requests.delete(id);
      return null;
    }
    return request;
  }

  dropRequest(id: string): void {
    this.requests.delete(id);
  }

  /** Convierte una petición pendiente en un código. La petición se consume. */
  issueCode(
    request: PendingRequest,
    identity: { identityId: string; displayName: string; authTime: number },
  ): AuthorizationCode {
    this.requests.delete(request.id);
    const code: AuthorizationCode = {
      code: randomId(),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
      identityId: identity.identityId,
      displayName: identity.displayName,
      authTime: identity.authTime,
      expiresAt: this.now() + this.codeTtlMs,
      used: false,
      issuedJtis: [],
    };
    this.codes.set(code.code, code);
    return code;
  }

  /**
   * Un solo uso. El segundo canje no solo falla: revoca los tokens que salieron
   * del primero, porque un código repetido significa que alguien más lo tiene.
   */
  consumeCode(code: string): { ok: true; record: AuthorizationCode } | { ok: false; reason: string } {
    this.sweep();
    const record = this.codes.get(code);
    if (!record) return { ok: false, reason: "código desconocido" };
    if (record.used) {
      for (const jti of record.issuedJtis) this.revoke(jti);
      record.issuedJtis = [];
      return { ok: false, reason: "código ya utilizado (los tokens emitidos con él quedan revocados)" };
    }
    if (record.expiresAt <= this.now()) {
      this.codes.delete(code);
      return { ok: false, reason: "código expirado" };
    }
    record.used = true;
    // Se conserva marcado como usado durante la ventana de replay.
    record.expiresAt = this.now() + this.replayWindowMs;
    return { ok: true, record };
  }

  noteIssuedToken(code: string, jti: string): void {
    this.codes.get(code)?.issuedJtis.push(jti);
  }

  revoke(jti: string, ttlMs = 3_600_000): void {
    this.revoked.set(jti, this.now() + ttlMs);
  }

  isRevoked(jti: string): boolean {
    const until = this.revoked.get(jti);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [id, request] of this.requests) if (request.expiresAt <= now) this.requests.delete(id);
    for (const [id, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(id);
    for (const [jti, until] of this.revoked) if (until <= now) this.revoked.delete(jti);
  }
}
