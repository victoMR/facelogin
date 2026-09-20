/**
 * Acuse sonoro de un gesto hecho.
 *
 * Sin archivo: un oscilador corto. El usuario ya tocó para abrir la cámara,
 * así que `AudioContext.resume()` suele pasar. Si el navegador lo bloquea,
 * el anillo y el texto siguen siendo el acuse; el sonido no puede ser la
 * única señal.
 */

export type CueKind = "step" | "round" | "done";

export type CueNote = { freq: number; start: number; dur: number };

export function cueNotes(kind: CueKind): CueNote[] {
  if (kind === "step") {
    return [
      { freq: 440, start: 0, dur: 0.12 },
      { freq: 659, start: 0.1, dur: 0.18 },
    ];
  }
  if (kind === "round") {
    return [
      { freq: 392, start: 0, dur: 0.1 },
      { freq: 523, start: 0.09, dur: 0.1 },
      { freq: 659, start: 0.18, dur: 0.2 },
    ];
  }
  return [
    { freq: 330, start: 0, dur: 0.12 },
    { freq: 440, start: 0.1, dur: 0.12 },
    { freq: 659, start: 0.22, dur: 0.24 },
  ];
}

type AudioWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = (window as AudioWindow).AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Hay que llamarlo en un gesto (cámara / toque). Si no, Safari deja el contexto suspendido. */
export function unlockCue(): void {
  const audio = context();
  if (!audio || audio.state !== "suspended") return;
  void audio.resume().catch(() => undefined);
}

export function playCue(kind: CueKind): void {
  const audio = context();
  if (!audio) return;
  void audio.resume().then(() => {
    const now = audio.currentTime;
    const master = audio.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.38, now + 0.02);
    master.connect(audio.destination);

    let end = now;
    for (const note of cueNotes(kind)) {
      const start = now + note.start;
      const stop = start + note.dur;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.7, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      gain.connect(master);

      for (const [type, freq, mix] of [
        ["triangle", note.freq, 1],
        ["triangle", note.freq / 2, 0.55],
        ["square", note.freq, 0.12],
      ] as const) {
        const osc = audio.createOscillator();
        const voice = audio.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        voice.gain.setValueAtTime(mix, start);
        osc.connect(voice);
        voice.connect(gain);
        osc.start(start);
        osc.stop(stop + 0.03);
      }
      end = Math.max(end, stop);
    }
    master.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
  }).catch(() => undefined);
}
