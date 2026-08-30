import { randomUUID } from "node:crypto";
import { decryptVector, encryptVector } from "./crypto.js";
import { buildPlanes, lshKeys } from "./lsh.js";
import {
  adaptiveThreshold,
  cosine,
  enrollmentQuality,
  intraStats,
  l2Normalize,
  meanVector,
} from "./matcher.js";
import { VaultStore } from "./store.js";
import type { FaceTemplate, MatchDecision } from "./types.js";

const DIM = 128;

export class FaceEngine {
  private planes: number[][][] | null = null;

  constructor(
    private readonly store: VaultStore,
    private readonly masterKey: Buffer,
    private readonly lshSeed: string,
    private readonly hmacSecret: string,
  ) {}

  enroll(displayName: string, rawSamples: number[][]): FaceTemplate {
    const samples = rawSamples.map((sample) => this.normalize(sample));
    const quality = enrollmentQuality(samples);
    if (!quality.ok) {
      throw Object.assign(new Error(quality.reason), { status: 422 });
    }

    const { mean, std } = intraStats(samples);
    const centroid = meanVector(samples);
    const keys = lshKeys(centroid, this.getPlanes(), this.hmacSecret);
    const gallerySize = this.store.all().length + 1;
    const template: FaceTemplate = {
      id: randomUUID(),
      displayName: displayName.trim(),
      createdAt: new Date().toISOString(),
      encryptedCentroid: encryptVector(centroid, this.masterKey),
      encryptedSamples: samples.map((sample) => encryptVector(sample, this.masterKey)),
      lshKeys: keys,
      intraMean: mean,
      intraStd: std,
      threshold: adaptiveThreshold(mean, std, gallerySize),
    };
    return this.store.upsert(template, keys);
  }

  identify(rawProbe: number[]): MatchDecision {
    const started = performance.now();
    const probe = this.normalize(rawProbe);
    const keys = lshKeys(probe, this.getPlanes(), this.hmacSecret);
    let candidates = this.store.candidates(keys);
    let reason = "lsh";

    if (candidates.length === 0) {
      candidates = this.store.all();
      reason = "fallback-full-scan";
    }

    const gallerySize = this.store.all().length;
    let best: { template: FaceTemplate; score: number; threshold: number } | null = null;

    for (const template of candidates) {
      const score = this.scoreAgainst(template, probe);
      const threshold = adaptiveThreshold(template.intraMean, template.intraStd, gallerySize);
      if (!best || score > best.score) {
        best = { template, score, threshold };
      }
    }

    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    if (!best || best.score < best.threshold) {
      return {
        matched: false,
        identityId: null,
        displayName: null,
        score: best?.score ?? 0,
        threshold: best?.threshold ?? adaptiveThreshold(1, 0, gallerySize),
        candidates: candidates.length,
        latencyMs,
        reason: best ? "below-threshold" : "empty-gallery",
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
    };
  }

  private scoreAgainst(template: FaceTemplate, probe: number[]): number {
    const centroid = decryptVector(template.encryptedCentroid, this.masterKey);
    const sampleScores = template.encryptedSamples.map((blob) =>
      cosine(probe, decryptVector(blob, this.masterKey)),
    );
    const maxSample = sampleScores.length ? Math.max(...sampleScores) : 0;
    return Math.max(cosine(probe, centroid), maxSample);
  }

  private normalize(vector: number[]): number[] {
    if (vector.length !== DIM) {
      throw Object.assign(new Error(`El descriptor debe tener ${DIM} dimensiones.`), { status: 400 });
    }
    return l2Normalize(vector);
  }

  private getPlanes(): number[][][] {
    this.planes ??= buildPlanes(this.lshSeed, DIM);
    return this.planes;
  }
}
