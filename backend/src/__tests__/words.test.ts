import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORD_BANK,
  consumeVoiceChallenge,
  issueVoiceChallenge,
  pickWords,
  resetVoiceChallenges,
  transcriptMatches,
  wordHeard,
} from "../words.js";

test("el banco tiene palabras rimbombantes y suficientes para un reto", () => {
  assert.ok(WORD_BANK.length >= 24);
  assert.ok(WORD_BANK.includes("rimbombante"));
  assert.ok(WORD_BANK.includes("parangaricutirimícuaro"));
});

test("pickWords elige tres distintas del banco", () => {
  const words = pickWords(3);
  assert.equal(words.length, 3);
  assert.equal(new Set(words).size, 3);
  for (const word of words) assert.ok((WORD_BANK as readonly string[]).includes(word));
});

test("issueVoiceChallenge emite tres palabras y se consume una sola vez", () => {
  resetVoiceChallenges();
  const challenge = issueVoiceChallenge();
  assert.equal(challenge.words.length, 3);
  const transcript = `Voy a decir ${challenge.words.join(" y ")}`;
  assert.equal(consumeVoiceChallenge(challenge.id, transcript), true);
  assert.equal(consumeVoiceChallenge(challenge.id, transcript), false);
});

test("un vídeo con otras palabras no pasa el reto", () => {
  resetVoiceChallenges();
  const challenge = issueVoiceChallenge();
  assert.equal(consumeVoiceChallenge(challenge.id, "hola buenos días"), false);
});

test("wordHeard tolera acentos y un tronco largo", () => {
  assert.equal(wordHeard("PARANGARICUTIRIMICUARO por favor", "parangaricutirimícuaro"), true);
  assert.equal(transcriptMatches("rimbombante murcielago", ["rimbombante", "murciélago"]), true);
});
