export type EncryptedBlob = {
  iv: string;
  data: string;
  tag: string;
};

/**
 * Sub-cluster de una identidad: una *condición* de captura (con lentes, sin
 * lentes, …) con su propio centroide y sus propias métricas de coherencia.
 *
 * Cada condición se guarda por separado a propósito. Promediar "con lentes" y
 * "sin lentes" en un único centroide lo deja en tierra de nadie: lejos de las
 * dos nubes en vez de cerca de una. El match compara contra el sub-cluster más
 * cercano, no contra la media de todos.
 */
export type FaceCondition = {
  /** Etiqueta declarada por el usuario. No se infiere de la imagen. */
  label: string;
  encryptedCentroid: EncryptedBlob;
  encryptedSamples: EncryptedBlob[];
  /** Coseno medio par a par *dentro* de esta condición. */
  intraMean: number;
  /** Desviación del coseno par a par dentro de esta condición. */
  intraStd: number;
};

export type FaceTemplate = {
  id: string;
  displayName: string;
  createdAt: string;
  /** Sub-clusters por condición. Siempre hay al menos uno. */
  conditions: FaceCondition[];
  lshKeys: string[];
  /**
   * Coherencia de la *peor* condición y dispersión de la peor condición.
   * Se conservan a nivel de plantilla solo como resumen para la API y para
   * plantillas antiguas; el umbral se calcula con las métricas de la condición
   * que gana el match, no con estas.
   */
  intraMean: number;
  intraStd: number;
  /**
   * Coseno mínimo entre centroides de condiciones distintas (null con una sola
   * condición). Mide cuánto espacio ocupa la identidad: dos nubes separadas
   * cubren más direcciones y por tanto son más fáciles de acertar por azar.
   */
  interConditionCosine: number | null;
  /**
   * Umbral vigente en el instante del enrollo. Es informativo: `identify`
   * siempre recalcula el umbral con el tamaño de galería actual.
   */
  thresholdAtEnroll: number;
  /**
   * Forma anterior a los sub-clusters (vaults ya escritos en disco). El motor
   * las convierte a una condición única al leerlas; no se escriben nunca más.
   */
  encryptedCentroid?: EncryptedBlob;
  encryptedSamples?: EncryptedBlob[];
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
  /** Condición (sub-cluster) que ganó el match, o null si no hubo match. */
  condition: string | null;
};
