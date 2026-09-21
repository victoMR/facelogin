/**
 * Actividad reciente para el panel admin: enrolamientos, logins y canjes OIDC.
 * Anillo en disco; no es un SIEM — solo visibilidad operativa.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STORE_VERSION = 1 as const;
const MAX_EVENTS = 200;

export type ActivityKind =
  | "enroll"
  | "login_ok"
  | "login_fail"
  | "oidc_token"
  | "client_created"
  | "client_revoked"
  | "gallery_cleared";

export type ActivityEvent = {
  at: string;
  kind: ActivityKind;
  detail: string;
  identity?: string;
  clientId?: string;
};

type StoreFile = {
  version: typeof STORE_VERSION;
  events: ActivityEvent[];
};

function empty(): StoreFile {
  return { version: STORE_VERSION, events: [] };
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export class ActivityLog {
  private cache: StoreFile | null = null;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private load(): StoreFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = empty();
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      if (raw?.version !== STORE_VERSION || !Array.isArray(raw.events)) throw new Error("formato");
      this.cache = raw;
      return this.cache;
    } catch {
      this.cache = empty();
      return this.cache;
    }
  }

  private save(file: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    this.cache = file;
  }

  record(event: Omit<ActivityEvent, "at"> & { at?: string }): void {
    const file = this.load();
    file.events.push({
      at: event.at ?? new Date().toISOString(),
      kind: event.kind,
      detail: event.detail.slice(0, 240),
      identity: event.identity?.slice(0, 64),
      clientId: event.clientId?.slice(0, 128),
    });
    if (file.events.length > MAX_EVENTS) {
      file.events = file.events.slice(file.events.length - MAX_EVENTS);
    }
    this.save(file);
  }

  recent(limit = 40): ActivityEvent[] {
    const events = this.load().events;
    return events.slice(Math.max(0, events.length - limit)).reverse();
  }

  summary(now = new Date()): {
    todayLogins: number;
    weekLogins: number;
    todayFails: number;
    lastAccess: string | null;
  } {
    const events = this.load().events;
    const today = dayKey(now.toISOString());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let todayLogins = 0;
    let weekLogins = 0;
    let todayFails = 0;
    let lastAccess: string | null = null;

    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const isLogin = event.kind === "login_ok" || event.kind === "oidc_token";
      if (isLogin && !lastAccess) lastAccess = event.at;
      if (event.kind === "login_ok" || event.kind === "oidc_token") {
        if (dayKey(event.at) === today) todayLogins += 1;
        if (new Date(event.at) >= weekAgo) weekLogins += 1;
      }
      if (event.kind === "login_fail" && dayKey(event.at) === today) todayFails += 1;
    }

    return { todayLogins, weekLogins, todayFails, lastAccess };
  }

  lastSeenByIdentity(): Map<string, string> {
    const map = new Map<string, string>();
    for (const event of this.load().events) {
      if (!event.identity) continue;
      if (event.kind !== "login_ok" && event.kind !== "oidc_token") continue;
      map.set(event.identity, event.at);
    }
    return map;
  }
}
