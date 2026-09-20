import { randomUUID } from "node:crypto";
import { decryptVector, encryptVector } from "./crypto.js";
import { buildPlanes, lshKeys, lshProbeKeys } from "./lsh.js";
import {
  adaptiveThreshold,
  clampThreshold,
  cosine,
  enrollmentQualityByCondition,
  interConditionCosine,
  intraStats,
  l2Normalize,
  meanVector,
  multiProbePenalty,
  storedSamplesPenalty,
  type ConditionSamples,
} from "./matcher.js";
import { VaultStore } from "./store.js";
import { deviceKnown, readDevice, type TrustedDevice } from "./devices.js";
import type { StoredPasskey } from "./passkeys.js";
import type { FaceCondition, FaceTemplate, MatchDecision } from "./types.js";

const DIM = 128;
export const SHAPE_DIM = 64;
/** Coseno mínimo de la malla 3D. Por debajo, otra geometría aunque FaceNet se parezca. */
export const SHAPE_MIN = 0.7;
export const DEFAULT_CONDITION = "default";
export const DUPLICATE_FACE_MESSAGE =
  "Esta cara ya está registrada. Entra con tu rostro en vez de crear otra cuenta.";

type Candidate = {
  template: FaceTemplate;
  condition: FaceCondition;
  score: number;
  threshold: number;
  margin: number;
};

/** Entrada de enrollo: muestras sueltas (una condición) o condiciones etiquetadas. */
export type EnrollInput = number[][] | ConditionSamples[];

function isConditionInput(input: EnrollInput): input is ConditionSamples[] {
  return input.length > 0 && !Array.isArray(input[0]);
}

export class FaceEngine {
  private planes: number[][][] | null = null;

  constructor(
    private readonly store: VaultStore,
    private readonly masterKey: Buffer,
    private readonly lshSeed: string,
    private readonly hmacSecret: string,
  ) {}

  enroll(
    displayName: string,
    input: EnrollInput,
    shape?: number[],
    device?: { id: string; publicKey: string; label?: string },
  ): FaceTemplate {
    const raw: ConditionSamples[] = isConditionInput(input)
      ? input
      : [{ label: DEFAULT_CONDITION, samples: input }];
    const normalized: ConditionSamples[] = raw.map((condition) => ({
      label: condition.label.trim() || DEFAULT_CONDITION,
      samples: condition.samples.map((sample) => this.normalize(sample)),
    }));

    // La coherencia se mide POR condición. Medirla sobre la mezcla rechazaría
    // cualquier enrollo multi-condición legítimo: con lentes y sin lentes son
    // dos nubes, y su media conjunta baja por diseño.
    const quality = enrollmentQualityByCondition(normalized);
    if (!quality.ok) {
      throw Object.assign(new Error(quality.reason), { status: 422 });
    }

    // Antes de persistir: ¿esta cara ya tiene identidad?
    // Se comparan los centroides (no las 40 variantes) contra la galería
    // descifrada, con el mismo umbral del login. Un hash suelto no serviría:
    // dos tomas de la misma cara no son bit a bit iguales.
    const centroids = normalized.map((condition) => meanVector(condition.samples));
    const existing = this.findExistingIdentity(centroids);
    if (existing) {
      throw Object.assign(new Error(DUPLICATE_FACE_MESSAGE), { status: 409 });
    }

    const conditions: FaceCondition[] = normalized.map((condition) => {
      const { mean, std } = intraStats(condition.samples);
      return {
        label: condition.label,
        encryptedCentroid: encryptVector(meanVector(condition.samples), this.masterKey),
        encryptedSamples: condition.samples.map((sample) => encryptVector(sample, this.masterKey)),
        intraMean: mean,
        intraStd: std,
      };
    });

    const keys = this.indexKeys(centroids, normalized.flatMap((condition) => condition.samples));
    const gallerySize = this.store.all().length + 1;
    const interCosine = interConditionCosine(centroids);
    // Resumen a nivel de plantilla: se toma la PEOR condición, no el promedio.
    const worstMean = Math.min(...conditions.map((condition) => condition.intraMean));
    const worstStd = Math.max(...conditions.map((condition) => condition.intraStd));

    const template: FaceTemplate = {
      id: randomUUID(),
      displayName: displayName.trim(),
      createdAt: new Date().toISOString(),
      conditions,
      lshKeys: keys,
      intraMean: worstMean,
      intraStd: worstStd,
      interConditionCosine: interCosine,
      // Incluye la penalización por muestras almacenadas para que el umbral
      // guardado sea el que de verdad se aplicará en el login.
      thresholdAtEnroll: clampThreshold(
        adaptiveThreshold(worstMean, worstStd, gallerySize, interCosine) +
          storedSamplesPenalty(Math.max(...conditions.map((c) => c.encryptedSamples.length))),
      ),
      encryptedShape: this.encryptShape(shape),
      devices: firstDevice(device),
    };
    return this.store.upsert(template, keys);
  }

  trustDevice(
    identityId: string,
    input: { id: string; publicKey: string; label?: string },
  ): TrustedDevice {
    const template = this.store.all().find((item) => item.id === identityId);
    if (!template) throw Object.assign(new Error("Sesión inválida."), { status: 401 });
    const device = readDevice(input);
    if (!device) throw Object.assign(new Error("Clave del aparato inválida."), { status: 400 });
    const rest = (template.devices ?? []).filter((item) => item.id !== device.id);
    const known = deviceKnown(template.devices, device.id);
    const saved = known
      ? { ...known, label: device.label, lastSeenAt: device.lastSeenAt }
      : device;
    this.store.upsert({ ...template, devices: [...rest, saved] }, template.lshKeys);
    return saved;
  }

  touchDevice(identityId: string, deviceId: string): void {
    const template = this.store.all().find((item) => item.id === identityId);
    if (!template) return;
    const devices = (template.devices ?? []).map((device) =>
      device.id === deviceId ? { ...device, lastSeenAt: new Date().toISOString() } : device,
    );
    this.store.upsert({ ...template, devices }, template.lshKeys);
  }

  listDevices(identityId: string): TrustedDevice[] {
    return this.store.all().find((item) => item.id === identityId)?.devices ?? [];
  }

  listDisplayNames(): string[] {
    return this.store.all().map((template) => template.displayName);
  }

  /** Quita todas las identidades. La caché del proceso también se vacía. */
  clearGallery(): number {
    const count = this.store.all().length;
    this.store.clear();
    return count;
  }

  listPasskeys(identityId: string): StoredPasskey[] {
    return this.store.all().find((item) => item.id === identityId)?.passkeys ?? [];
  }

  findPasskey(credentialId: string): { identityId: string; passkey: StoredPasskey } | null {
    for (const template of this.store.all()) {
      const passkey = (template.passkeys ?? []).find((item) => item.id === credentialId);
      if (passkey) return { identityId: template.id, passkey };
    }
    return null;
  }

  addPasskey(identityId: string, passkey: StoredPasskey): void {
    const template = this.store.all().find((item) => item.id === identityId);
    if (!template) throw Object.assign(new Error("Sesión inválida."), { status: 401 });
    const rest = (template.passkeys ?? []).filter((item) => item.id !== passkey.id);
    this.store.upsert({ ...template, passkeys: [...rest, passkey] }, template.lshKeys);
  }

  updatePasskeyCounter(identityId: string, credentialId: string, counter: number): void {
    const template = this.store.all().find((item) => item.id === identityId);
    if (!template) return;
    const passkeys = (template.passkeys ?? []).map((item) =>
      item.id === credentialId ? { ...item, counter } : item,
    );
    this.store.upsert({ ...template, passkeys }, template.lshKeys);
  }

  revokeDevice(identityId: string, deviceId: string): void {
    const template = this.store.all().find((item) => item.id === identityId);
    if (!template) throw Object.assign(new Error("Sesión inválida."), { status: 401 });
    this.store.upsert(
      { ...template, devices: (template.devices ?? []).filter((device) => device.id !== deviceId) },
      template.lshKeys,
    );
  }

  /**
   * Acepta uno o varios descriptores del mismo intento. El cliente manda las
   * mejores capturas de la sesión en vez de solo la última (que es la del
   * parpadeo, la de peor calidad). El servidor se queda con la mejor y paga la
   * penalización de `multiProbePenalty` para no regalar FAR a cambio.
   */
  identify(rawProbes: number[] | number[][], shape?: number[]): MatchDecision {
    const started = performance.now();
    const list = (Array.isArray(rawProbes[0]) ? rawProbes : [rawProbes]) as number[][];
    const probes = list.map((probe) => this.normalize(probe));
    const penalty = multiProbePenalty(probes.length);
    const gallery = this.store.all();
    const gallerySize = gallery.length;

    const planes = this.getPlanes();
    const probeKeys = new Set<string>();
    for (const probe of probes) {
      for (const key of lshProbeKeys(probe, planes, this.hmacSecret)) probeKeys.add(key);
    }

    let candidates = this.store.candidates([...probeKeys]);
    let reason = "lsh";
    const probeShape = this.readShape(shape);
    let best = this.bestCandidate(candidates, probes, gallerySize, penalty, probeShape);

    // El índice puede devolver una lista no vacía sin la identidad correcta dentro
    // (colisión de cubeta). Por eso el barrido completo también entra cuando el
    // mejor candidato no llega a su umbral, no solo cuando la lista queda vacía.
    if ((!best || best.margin < 0) && candidates.length < gallerySize) {
      candidates = gallery;
      reason = "fallback-full-scan";
      best = this.bestCandidate(candidates, probes, gallerySize, penalty, probeShape);
    }

    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    if (!best || best.margin < 0) {
      return {
        matched: false,
        identityId: null,
        displayName: null,
        score: best?.score ?? 0,
        threshold: best?.threshold ?? clampThreshold(adaptiveThreshold(1, 0, gallerySize) + penalty),
        candidates: candidates.length,
        latencyMs,
        reason: best ? "below-threshold" : "empty-gallery",
        condition: null,
      };
    }

    return {
      matched: true,
      identityId: best.template.id,
      displayName: best.template.displayName,
      score: best.score,
      threshold: best.threshold,
      candidates: candidates.length,
      latencyMs,
      reason,
      condition: best.condition.label,
    };
  }

  /** ¿Hay ya una plantilla que pasaría el umbral de login contra estos probes? */
  private findExistingIdentity(probes: number[][]): Candidate | null {
    const gallery = this.store.all();
    if (gallery.length === 0) return null;
    const best = this.bestCandidate(gallery, probes, gallery.length, 0, null);
    if (!best || best.margin < 0) return null;
    return best;
  }

  /**
   * Se elige por margen (`score - threshold`) y no por score bruto: los umbrales
   * son por persona y por condición, así que el score más alto no es
   * necesariamente el que pasa.
   */
  private bestCandidate(
    templates: FaceTemplate[],
    probes: number[][],
    gallerySize: number,
    penalty: number,
    probeShape: number[] | null,
  ): Candidate | null {
    let best: Candidate | null = null;
    for (const template of templates) {
      if (!this.shapeAgrees(template, probeShape)) continue;
      for (const condition of conditionsOf(template)) {
        const score = this.scoreAgainst(condition, probes);
        // El umbral sale de la condición que gana, no de la mezcla de todas.
        // A la penalización por multi-probe se suma la del otro lado del `max`:
        // esta condición se puntúa contra su centroide Y cada muestra guardada,
        // y el máximo de esas comparaciones también infla al impostor.
        // El acotado final es el que hace de `MAX_COSINE_THRESHOLD` un techo de
        // verdad: las penalizaciones se suman después del umbral adaptativo.
        const threshold = clampThreshold(
          adaptiveThreshold(
            condition.intraMean,
            condition.intraStd,
            gallerySize,
            template.interConditionCosine ?? null,
          ) +
            penalty +
            storedSamplesPenalty(condition.encryptedSamples.length),
        );
        const margin = score - threshold;
        if (!best || margin > best.margin) {
          best = { template, condition, score, threshold, margin };
        }
      }
    }
    return best;
  }

  /**
   * Se indexan los centroides de cada condición y cada muestra: una pose (o una
   * condición entera) que se salga del centroide sigue teniendo cubeta propia.
   */
  private indexKeys(centroids: number[][], samples: number[][]): string[] {
    const planes = this.getPlanes();
    const keys = new Set<string>();
    for (const vector of [...centroids, ...samples]) {
      for (const key of lshKeys(vector, planes, this.hmacSecret)) keys.add(key);
    }
    return [...keys];
  }

  /** Máximo coseno entre cualquier probe y (centroide | muestra) de esta condición. */
  private scoreAgainst(condition: FaceCondition, probes: number[][]): number {
    const vectors = [
      decryptVector(condition.encryptedCentroid, this.masterKey),
      ...condition.encryptedSamples.map((blob) => decryptVector(blob, this.masterKey)),
    ];
    let best = -1;
    for (const probe of probes) {
      for (const vector of vectors) {
        const score = cosine(probe, vector);
        if (score > best) best = score;
      }
    }
    return best;
  }

  private normalize(vector: number[]): number[] {
    if (vector.length !== DIM) {
      throw Object.assign(new Error(`El descriptor debe tener ${DIM} dimensiones.`), { status: 400 });
    }
    return l2Normalize(vector);
  }

  private encryptShape(shape?: number[]): FaceTemplate["encryptedShape"] {
    const ready = this.readShape(shape);
    return ready ? encryptVector(ready, this.masterKey) : undefined;
  }

  private readShape(shape?: number[]): number[] | null {
    if (!shape || shape.length !== SHAPE_DIM || !shape.every((value) => Number.isFinite(value))) {
      return null;
    }
    return l2Normalize(shape);
  }

  /** Plantilla nueva con malla: el probe tiene que traerla. Las viejas siguen. */
  private shapeAgrees(template: FaceTemplate, probeShape: number[] | null): boolean {
    if (!template.encryptedShape) return true;
    if (!probeShape) return false;
    const stored = decryptVector(template.encryptedShape, this.masterKey);
    if (stored.length !== SHAPE_DIM) return true;
    return cosine(l2Normalize(stored), probeShape) >= SHAPE_MIN;
  }

  private getPlanes(): number[][][] {
    this.planes ??= buildPlanes(this.lshSeed, DIM);
    return this.planes;
  }
}

/**
 * Lee una plantilla en cualquiera de las dos formas: con `conditions` (actual) o
 * con `encryptedCentroid`/`encryptedSamples` sueltos (vaults escritos antes de
 * los sub-clusters). Un vault viejo sigue entrando sin migración manual.
 */
function firstDevice(input?: { id: string; publicKey: string; label?: string }): TrustedDevice[] {
  const device = input ? readDevice(input) : null;
  return device ? [device] : [];
}

export function conditionsOf(template: FaceTemplate): FaceCondition[] {
  if (template.conditions?.length) return template.conditions;
  if (!template.encryptedCentroid) return [];
  return [
    {
      label: DEFAULT_CONDITION,
      encryptedCentroid: template.encryptedCentroid,
      encryptedSamples: template.encryptedSamples ?? [],
      intraMean: template.intraMean,
      intraStd: template.intraStd,
    },
  ];
}
