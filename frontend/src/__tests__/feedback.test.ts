import assert from "node:assert/strict";
import { test } from "node:test";
import { cueNotes } from "../feedback";

test("cueNotes de paso son dos notas cortas", () => {
  const notes = cueNotes("step");
  assert.equal(notes.length, 2);
  assert.ok(notes[1]!.freq > notes[0]!.freq);
  assert.ok(notes.every((note) => note.dur < 0.3 && note.dur >= 0.1));
});

test("cueNotes de ronda y fin son más largos que un paso", () => {
  const step = cueNotes("step");
  const round = cueNotes("round");
  const done = cueNotes("done");
  const last = (notes: typeof step) => notes[notes.length - 1]!.start + notes[notes.length - 1]!.dur;
  assert.ok(last(round) > last(step));
  assert.ok(last(done) > last(step));
});

test("playCue no lanza fuera del navegador", async () => {
  const { playCue, unlockCue } = await import("../feedback");
  unlockCue();
  playCue("step");
});
