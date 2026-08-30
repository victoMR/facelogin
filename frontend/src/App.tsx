import { useEffect, useMemo, useRef, useState } from "react";
import { enroll, identify, me, type EnrollResult, type IdentifyResult } from "./api";
import { detectFace, loadModels } from "./face";
import {
  challengeLabel,
  challengeMet,
  enrollChallenges,
  loginChallenges,
  type ChallengeId,
} from "./liveness";

type Mode = "home" | "enroll" | "login" | "session";

type SessionState = IdentifyResult & { token: string };

export function App() {
  const [mode, setMode] = useState<Mode>("home");
  const [models, setModels] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState<SessionState | null>(null);
  const [enrolled, setEnrolled] = useState<EnrollResult | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("facelogin.token");
    if (!token) return;
    me(token)
      .then((identity) => {
        setSession({
          token,
          identity,
          score: 0,
          threshold: 0,
          candidates: 0,
          latencyMs: 0,
          reason: "session",
        });
        setMode("session");
      })
      .catch(() => localStorage.removeItem("facelogin.token"));
  }, []);

  async function ensureModels() {
    if (models === "ready") return;
    setModels("loading");
    try {
      await loadModels();
      setModels("ready");
    } catch {
      setModels("error");
      throw new Error("No se pudieron cargar los modelos faciales.");
    }
  }

  function logout() {
    localStorage.removeItem("facelogin.token");
    setSession(null);
    setMode("home");
  }

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">
          face<span>login</span>
        </strong>
        <p className="eyebrow">solo reconocimiento facial</p>
      </header>

      {mode === "home" && (
        <section className="hero">
          <p className="eyebrow">acceso biométrico 1:N</p>
          <h1>Entras con tu cara. Nada más.</h1>
          <p className="lede">
            Cada enrollo genera una tabla hash compartida y cifrada. El servidor nunca guarda
            fotos: solo descriptores AES-256-GCM y cubetas LSH para decidir, en milisegundos, si
            eres tú.
          </p>
          <div className="actions">
            <button className="btn primary" onClick={() => setMode("enroll")}>
              Enrolar rostro
            </button>
            <button className="btn" onClick={() => setMode("login")}>
              Entrar
            </button>
          </div>
        </section>
      )}

      {mode === "enroll" && (
        <FaceFlow
          title="Enrollar identidad"
          subtitle="Cinco gestos. Un umbral propio."
          challenges={enrollChallenges}
          nameRequired
          models={models}
          error={error}
          onBack={() => {
            setError("");
            setMode("home");
          }}
          onPrepare={ensureModels}
          onComplete={async (samples, name) => {
            setError("");
            const result = await enroll(name, samples);
            setEnrolled(result);
            setMode("home");
          }}
          onError={setError}
        />
      )}

      {mode === "login" && (
        <FaceFlow
          title="Identificación"
          subtitle="Parpadea. El índice LSH busca candidatos y el umbral decide."
          challenges={loginChallenges}
          models={models}
          error={error}
          onBack={() => {
            setError("");
            setMode("home");
          }}
          onPrepare={ensureModels}
          onComplete={async (samples) => {
            setError("");
            const result = await identify(samples[samples.length - 1]);
            localStorage.setItem("facelogin.token", result.token);
            setSession(result);
            setMode("session");
          }}
          onError={setError}
        />
      )}

      {mode === "session" && session && (
        <section className="panel">
          <p className="eyebrow">sesión abierta</p>
          <h1>{session.identity.displayName}</h1>
          <p className="lede">
            Autenticado solo con el descriptor facial. La foto no viajó. El match cruzó el umbral
            adaptativo de esta identidad.
          </p>
          <div className="metrics">
            <div className="metric">
              <b>{session.score.toFixed(3)}</b>
              <span>similitud coseno</span>
            </div>
            <div className="metric">
              <b>{session.threshold.toFixed(3)}</b>
              <span>umbral usado</span>
            </div>
            <div className="metric">
              <b>{session.latencyMs} ms</b>
              <span>tiempo de match</span>
            </div>
            <div className="metric">
              <b>{session.candidates}</b>
              <span>candidatos LSH</span>
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={logout}>
              Cerrar sesión
            </button>
          </div>
        </section>
      )}

      {enrolled && mode === "home" && (
        <section className="panel" style={{ marginTop: 20 }}>
          <p className="eyebrow">último enrollo</p>
          <h1>{enrolled.displayName}</h1>
          <div className="metrics">
            <div className="metric">
              <b>{enrolled.samples}</b>
              <span>muestras cifradas</span>
            </div>
            <div className="metric">
              <b>{enrolled.threshold.toFixed(3)}</b>
              <span>umbral personal</span>
            </div>
            <div className="metric">
              <b>{enrolled.intraMean.toFixed(3)}</b>
              <span>coherencia intra-clase</span>
            </div>
            <div className="metric">
              <b>{enrolled.intraStd.toFixed(3)}</b>
              <span>dispersión</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function FaceFlow({
  title,
  subtitle,
  challenges,
  nameRequired,
  models,
  error,
  onBack,
  onPrepare,
  onComplete,
  onError,
}: {
  title: string;
  subtitle: string;
  challenges: ChallengeId[];
  nameRequired?: boolean;
  models: "idle" | "loading" | "ready" | "error";
  error: string;
  onBack: () => void;
  onPrepare: () => Promise<void>;
  onComplete: (samples: number[][], name: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [name, setName] = useState("");
  const [step, setStep] = useState(0);
  const [captured, setCaptured] = useState(0);
  const [status, setStatus] = useState("Activa la cámara para empezar.");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const holdRef = useRef(0);
  const samplesRef = useRef<number[][]>([]);
  const nameRef = useRef(name);
  const completeRef = useRef(onComplete);
  nameRef.current = name;
  completeRef.current = onComplete;

  const current = challenges[step];
  const progress = useMemo(
    () => challenges.map((id, index) => ({ id, state: index < step ? "done" : index === step ? "active" : "todo" })),
    [challenges, step],
  );

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startCamera() {
    if (nameRequired && name.trim().length < 2) {
      onError("Escribe un nombre visible antes de abrir la cámara.");
      return;
    }
    try {
      await onPrepare();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 720, height: 540 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus(challengeLabel(challenges[0]));
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo abrir la cámara.");
    }
  }

  useEffect(() => {
    if (!videoRef.current || models !== "ready" || !current || busy) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled || !videoRef.current) return;
      const face = await detectFace(videoRef.current);
      if (!face) {
        holdRef.current = 0;
        setStatus("Acerca el rostro y céntralo en el marco.");
      } else if (!challengeMet(current, face.landmarks)) {
        holdRef.current = 0;
        setStatus(challengeLabel(current));
      } else {
        holdRef.current += 1;
        if (holdRef.current >= (current === "blink" ? 1 : 4)) {
          samplesRef.current = [...samplesRef.current, face.descriptor];
          setCaptured(samplesRef.current.length);
          holdRef.current = 0;
          if (step + 1 >= challenges.length) {
            setBusy(true);
            try {
              await completeRef.current(samplesRef.current, nameRef.current);
            } catch (err) {
              onError(err instanceof Error ? err.message : "Falló la verificación.");
              setBusy(false);
              setStep(0);
              samplesRef.current = [];
              setCaptured(0);
            }
          } else {
            setStep((value) => value + 1);
            setStatus(challengeLabel(challenges[step + 1]));
          }
        }
      }
      if (!cancelled && !busy) window.setTimeout(tick, 180);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [busy, current, models, onError, step, challenges]);

  return (
    <section className="grid">
      <div className="stage">
        <video ref={videoRef} playsInline muted />
        <div className="frame" />
        <div className="overlay">
          {status} {captured > 0 ? `· ${captured} muestra${captured === 1 ? "" : "s"}` : ""}
        </div>
      </div>
      <div className="panel">
        <p className="eyebrow">{subtitle}</p>
        <h1>{title}</h1>
        {nameRequired && (
          <div className="field">
            <label htmlFor="name">Nombre visible</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Cómo te reconocemos"
            />
          </div>
        )}
        <ol className="steps">
          {progress.map((item, index) => (
            <li key={`${item.id}-${index}`} className={item.state}>
              <span>{challengeLabel(item.id)}</span>
              <span>{item.state === "done" ? "ok" : item.state === "active" ? "ahora" : ""}</span>
            </li>
          ))}
        </ol>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="btn primary" onClick={startCamera} disabled={models === "loading" || busy}>
            {models === "loading" ? "Cargando modelos…" : "Abrir cámara"}
          </button>
          <button className="btn" onClick={onBack}>
            Volver
          </button>
        </div>
        <p className="note">
          La imagen no se envía. Solo viaja un vector de 128 dimensiones extraído en tu navegador.
        </p>
      </div>
    </section>
  );
}
