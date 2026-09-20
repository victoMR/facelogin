import { randomBytes, randomInt } from "node:crypto";
import bank from "./word-bank.json" with { type: "json" };

/**
 * Banco grande de palabras fáciles en español.
 * Tres al azar; con más de mil no se repite el mismo trío.
 */
export const WORD_BANK: readonly string[] = bank;

export const VOICE_WORD_COUNT = 3;
const VOICE_TTL_MS = 90_000;

type VoiceChallenge = {
  words: string[];
  expiresAt: number;
  used: boolean;
};

const challenges = new Map<string, VoiceChallenge>();

function sweep(): void {
  const now = Date.now();
  for (const [id, item] of challenges) {
    if (item.expiresAt < now || item.used) challenges.delete(id);
  }
}

export function pickWords(count = VOICE_WORD_COUNT, bank: readonly string[] = WORD_BANK): string[] {
  const pool = [...bank];
  const words: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    words.push(pool.splice(randomInt(pool.length), 1)[0]);
  }
  return words;
}

export function issueVoiceChallenge(): { id: string; words: string[]; expiresAt: number } {
  sweep();
  const id = randomBytes(16).toString("base64url");
  const words = pickWords();
  const expiresAt = Date.now() + VOICE_TTL_MS;
  challenges.set(id, { words, expiresAt, used: false });
  return { id, words, expiresAt };
}

export function foldSpeech(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-zñü\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordHeard(transcript: string, word: string): boolean {
  const hay = foldSpeech(transcript).replace(/\s/g, "");
  const needle = foldSpeech(word).replace(/\s/g, "");
  if (!needle) return false;
  if (hay.includes(needle)) return true;
  if (needle.length >= 10) {
    const stem = needle.slice(0, Math.max(8, Math.floor(needle.length * 0.55)));
    return hay.includes(stem);
  }
  return false;
}

export function transcriptMatches(transcript: string, words: string[]): boolean {
  return words.every((word) => wordHeard(transcript, word));
}

export function consumeVoiceChallenge(id: string, transcript: string): boolean {
  sweep();
  const item = challenges.get(id);
  if (!item || item.used || item.expiresAt < Date.now()) return false;
  if (!transcriptMatches(transcript, item.words)) return false;
  item.used = true;
  challenges.delete(id);
  return true;
}

export function resetVoiceChallenges(): void {
  challenges.clear();
}
