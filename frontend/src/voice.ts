/**
 * Micrófono + reconocimiento de voz para el captcha de tres palabras.
 *
 * Chrome/Edge/Safari tienen SpeechRecognition. Firefox no: se dice claro,
 * no se finge un “ya las dije”.
 */

type RecInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type RecCtor = new () => RecInstance;

function recognitionCtor(): RecCtor | null {
  const bag = window as unknown as {
    SpeechRecognition?: RecCtor;
    webkitSpeechRecognition?: RecCtor;
  };
  return bag.SpeechRecognition ?? bag.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return recognitionCtor() !== null;
}

export function listenSpeech(
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onError("Este navegador no puede oírte. Prueba en Chrome o Safari.");
    return () => undefined;
  }

  let stopped = false;
  const rec = new Ctor();
  rec.lang = "es-MX";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  const flush = (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => {
    const parts: string[] = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const alt = event.results[i]?.[0]?.transcript;
      if (alt) parts.push(alt);
    }
    if (parts.length) onTranscript(parts.join(" "));
  };

  rec.onresult = flush;
  rec.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    if (event.error === "not-allowed") {
      onError("Activa el micrófono para decir las palabras.");
      return;
    }
    onError("No se oyó bien. Vuelve a decir las tres palabras.");
  };
  rec.onend = () => {
    if (!stopped) {
      try {
        rec.start();
      } catch {
        /* ya arrancado */
      }
    }
  };

  try {
    rec.start();
  } catch {
    onError("No se pudo abrir el micrófono.");
  }

  return () => {
    stopped = true;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* ignore */
    }
  };
}

export async function openMicMeter(): Promise<{ rms: () => number; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const bins = new Uint8Array(analyser.fftSize);

  return {
    rms: () => {
      analyser.getByteTimeDomainData(bins);
      let sum = 0;
      for (const sample of bins) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      return Math.sqrt(sum / bins.length);
    },
    stop: () => {
      source.disconnect();
      void ctx.close();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
