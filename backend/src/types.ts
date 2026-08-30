export type EncryptedBlob = {
  iv: string;
  data: string;
  tag: string;
};

export type FaceTemplate = {
  id: string;
  displayName: string;
  createdAt: string;
  encryptedCentroid: EncryptedBlob;
  encryptedSamples: EncryptedBlob[];
  lshKeys: string[];
  intraMean: number;
  intraStd: number;
  threshold: number;
};

export type VaultFile = {
  version: 1;
  templates: FaceTemplate[];
  buckets: Record<string, string[]>;
};

export type MatchDecision = {
  matched: boolean;
  identityId: string | null;
  displayName: string | null;
  score: number;
  threshold: number;
  candidates: number;
  latencyMs: number;
  reason: string;
};
