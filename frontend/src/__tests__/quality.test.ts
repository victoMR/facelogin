/**
 * Tests del diagnóstico de calidad de captura.
 *
 * Corren con `node:test` + `tsx`, **sin navegador, sin cámara y sin face-api**:
 * `quality.ts` es puro a propósito, igual que `perf.ts`, y esa pureza es lo que
 * permite fijar por test cosas que de otra forma solo se podrían mirar a ojo
 * delante de una webcam — que nunca se acuse a alguien de estar cerca y lejos a
 * la vez, que el texto no cambie dos veces en el mismo frame, o que el consejo
 * tras un login fallido no filtre nada del servidor.
 *
 * Lo que NO se prueba aquí, y hay que decirlo: que 0.33 sea la distancia
 * correcta para decir "acércate" es una decisión anclada en la fórmula de
 * `captureQuality` (satura en 180 px de caja) y en los límites duros de
 * `sampleGate`, no un teorema. Estos tests fijan el comportamiento, no calibran
 * el número.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adviceAfterFailure,
  BACKLIGHT_RATIO,
  BLUR_LIMIT,
  buildSignals,
  COACH_DELAY_MS,
  coachReady,
  DARK_LUMA,
  diagnose,
  FAR_RATIO,
  imageWarning,
  lightLevel,
  MIN_DWELL_MS,
  NEAR_RATIO,
  NO_FACE,
  OFFSET_LIMIT,
  sharpnessLevel,
  StableDiagnosis,
  STABLE_FRAMES,
  WEAK_CAPTURE,
  resolveBlocking,
  YAW_LIMIT,
  type FrameSignals,
  type Photometry,
} from "../quality";

/** Una cara perfectamente puesta: nada debería quejarse de ella. */
const GOOD_PHOTO: Photometry = { luma: 0.52, background: 0.5, sharpness: 0.6 };

function signals(overrides: Partial<FrameSignals> = {}): FrameSignals {
  return {
    detected: true,
    score: 0.92,
    boxRatio: 0.45,
    offset: 0.04,
    yaw: 0.03,
    roll: 0.05,
    photo: GOOD_PHOTO,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Una causa, la que más pesa
// ---------------------------------------------------------------------------

test("una cara bien puesta no genera ninguna queja", () => {
  assert.equal(diagnose(signals()).issue, "ninguno");
  assert.equal(diagnose(signals()).message, "");
});

test("sin cara detectada, la causa es 'sin-cara' y bloquea", () => {
  const verdict = resolveBlocking(diagnose(NO_FACE), false);
  assert.equal(verdict.issue, "sin-cara");
  assert.equal(verdict.blocking, true);
  assert.ok(verdict.message.length > 0);
});

test("una cara pequeña se diagnostica como 'lejos', no como algo genérico", () => {
  assert.equal(diagnose(signals({ boxRatio: FAR_RATIO * 0.5 })).issue, "lejos");
});

test("quién bloquea lo decide el gate, no el umbral de aviso", () => {
  // La franja entre el aviso ("acércate un poco") y el límite duro existe a
  // propósito. Dentro de ella la captura ENTRA, así que el titular tiene que
  // seguir siendo el gesto y la causa bajar a consejo. Marcarla como bloqueante
  // hacía que la pantalla gritara un arreglo innecesario un instante antes de
  // que el anillo avanzara igual.
  const lejos = diagnose(signals({ boxRatio: FAR_RATIO * 0.8 }));
  assert.equal(resolveBlocking(lejos, true).blocking, false);
  assert.equal(resolveBlocking(lejos, false).blocking, true);
  // Y la causa no cambia por bloquear o no: solo cambia dónde se pinta.
  assert.equal(resolveBlocking(lejos, true).issue, "lejos");
  assert.equal(resolveBlocking(lejos, false).issue, "lejos");
});

test("una cara enorme se diagnostica como 'cerca'", () => {
  assert.equal(diagnose(signals({ boxRatio: NEAR_RATIO * 1.4 })).issue, "cerca");
});

test("'cerca' y 'lejos' son mutuamente excluyentes para cualquier tamaño", () => {
  // Es la garantía que hace que el mensaje se pueda mostrar sin pensarlo: no
  // existe ningún tamaño de caja que dispare las dos causas contrarias.
  for (let ratio = 0.02; ratio < 1.2; ratio += 0.01) {
    const issue = diagnose(signals({ boxRatio: ratio })).issue;
    assert.ok(issue !== "cerca" || ratio > NEAR_RATIO);
    assert.ok(issue !== "lejos" || ratio < FAR_RATIO);
  }
});

test("estar descentrado pesa más que estar un poco lejos", () => {
  // Pedirle a alguien que se acerque mientras está fuera del óvalo es un consejo
  // que no resuelve nada: primero el encuadre.
  const verdict = diagnose(
    signals({ offset: OFFSET_LIMIT * 2, boxRatio: FAR_RATIO * 0.95 }),
  );
  assert.equal(verdict.issue, "fuera");
});

test("el diagnóstico devuelve SIEMPRE una sola causa", () => {
  // Todo mal a la vez: aun así sale una única frase, no una lista.
  const verdict = diagnose(
    signals({
      score: 0.3,
      boxRatio: 0.1,
      offset: 0.4,
      yaw: 0.8,
      roll: 0.9,
      photo: { luma: 0.05, background: 0.9, sharpness: 0.01 },
    }),
  );
  assert.ok(verdict.issue !== "ninguno");
  assert.equal(typeof verdict.message, "string");
  assert.ok(!verdict.message.includes("\n"));
});

// ---------------------------------------------------------------------------
// Pose: lo que se pide no puede ser un defecto
// ---------------------------------------------------------------------------

test("un yaw alto es un defecto en los gestos frontales", () => {
  assert.equal(diagnose(signals({ yaw: YAW_LIMIT * 2 }), "frontal").issue, "girado");
});

test("el mismo yaw NO es un defecto durante un gesto de perfil", () => {
  // Si no, la pantalla diría "gira la cabeza" arriba y "mira de frente" debajo.
  assert.equal(diagnose(signals({ yaw: YAW_LIMIT * 2 }), "perfil").issue, "ninguno");
});

test("la cabeza inclinada se avisa aunque el gesto sea de perfil", () => {
  assert.equal(diagnose(signals({ roll: 0.9 }), "perfil").issue, "inclinado");
});

// ---------------------------------------------------------------------------
// Luz
// ---------------------------------------------------------------------------

test("poca luz en la cara se llama 'oscuro'", () => {
  assert.equal(
    diagnose(signals({ photo: { luma: DARK_LUMA * 0.4, background: 0.2, sharpness: 0.6 } })).issue,
    "oscuro",
  );
});

test("el contraluz gana a 'oscuro' cuando el fondo es mucho más claro", () => {
  // "Falta luz" es cierto pero inútil frente a una ventana: lo accionable es
  // girarse, y por eso el contraluz se diagnostica aparte.
  const verdict = diagnose(
    signals({ photo: { luma: 0.2, background: 0.2 * BACKLIGHT_RATIO * 1.6, sharpness: 0.6 } }),
  );
  assert.equal(verdict.issue, "contraluz");
});

test("una pared blanca detrás de una cara bien iluminada NO es contraluz", () => {
  const verdict = diagnose(
    signals({ photo: { luma: 0.6, background: 0.95, sharpness: 0.6 } }),
  );
  assert.notEqual(verdict.issue, "contraluz");
});

test("una cara quemada se avisa igual que una oscura", () => {
  assert.equal(
    diagnose(signals({ photo: { luma: 0.97, background: 0.9, sharpness: 0.6 } })).issue,
    "quemado",
  );
});

test("una imagen movida se llama 'movido'", () => {
  assert.equal(
    diagnose(signals({ photo: { luma: 0.5, background: 0.5, sharpness: BLUR_LIMIT * 0.2 } })).issue,
    "movido",
  );
});

test("sin fotometría todavía, no se inventa ninguna causa de luz", () => {
  const verdict = diagnose(signals({ photo: null }));
  assert.equal(verdict.issue, "ninguno");
});

test("los niveles en palabras coinciden con el diagnóstico", () => {
  assert.equal(lightLevel(null), "desconocida");
  assert.equal(lightLevel({ luma: 0.1, background: 0.1, sharpness: 0.5 }), "baja");
  assert.equal(lightLevel(GOOD_PHOTO), "correcta");
  assert.equal(lightLevel({ luma: 0.95, background: 0.9, sharpness: 0.5 }), "alta");
  assert.equal(sharpnessLevel({ luma: 0.5, background: 0.5, sharpness: 0.01 }), "baja");
  assert.equal(sharpnessLevel(GOOD_PHOTO), "correcta");
});

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

test("el tamaño se normaliza por el lado corto, no por el ancho", () => {
  // Un frame 16:9 y otro 4:3 con la misma cara en píxeles tienen que dar el
  // mismo veredicto: lo que limita al acercarse es el alto, no el ancho.
  const wide = buildSignals({
    score: 0.9,
    boxWidth: 200,
    centerX: 480,
    centerY: 270,
    frameWidth: 960,
    frameHeight: 540,
    yaw: 0,
    roll: 0,
    photo: GOOD_PHOTO,
  });
  assert.ok(Math.abs(wide.boxRatio - 200 / 540) < 1e-9);
  assert.equal(wide.offset, 0);
  assert.equal(wide.detected, true);
});

test("el descentrado se mide por el eje que más se sale", () => {
  const off = buildSignals({
    score: 0.9,
    boxWidth: 200,
    centerX: 480,
    centerY: 540 * 0.9,
    frameWidth: 960,
    frameHeight: 540,
    yaw: 0,
    roll: 0,
    photo: null,
  });
  assert.ok(Math.abs(off.offset - 0.4) < 1e-9);
});

test("los ángulos se guardan en valor absoluto: da igual a qué lado", () => {
  const left = buildSignals({
    score: 0.9,
    boxWidth: 200,
    centerX: 480,
    centerY: 270,
    frameWidth: 960,
    frameHeight: 540,
    yaw: -0.4,
    roll: -0.5,
    photo: null,
  });
  assert.equal(left.yaw, 0.4);
  assert.equal(left.roll, 0.5);
});

test("si el gate duro rechaza y nada más se quejó, se dice algo igualmente", () => {
  const clean = diagnose(signals());
  assert.equal(clean.issue, "ninguno");
  const fallback = resolveBlocking(clean, false);
  assert.equal(fallback.issue, "dudosa");
  assert.equal(fallback.blocking, true);
  // Y si el frame sí pasa el gate, no se inventa nada.
  assert.equal(resolveBlocking(clean, true).issue, "ninguno");
});

test("el fallback no pisa una causa concreta que ya se había detectado", () => {
  const far = diagnose(signals({ boxRatio: 0.1 }));
  assert.equal(resolveBlocking(far, false).issue, "lejos");
});

// ---------------------------------------------------------------------------
// Estabilizador: el texto no puede parpadear
// ---------------------------------------------------------------------------

test("un veredicto nuevo no entra hasta repetirse y hasta que pase el tiempo mínimo", () => {
  const stable = new StableDiagnosis();
  const oscuro = diagnose(signals({ photo: { luma: 0.05, background: 0.05, sharpness: 0.6 } }));
  let now = 1000;
  for (let i = 0; i < STABLE_FRAMES + 2; i += 1) {
    // Frames seguidos pero muy juntos en el tiempo: 40 ms cada uno.
    const shown = stable.update(oscuro, now);
    assert.equal(shown.issue, "ninguno", "cambió antes de tiempo");
    now += 40;
  }
  // Pasado el tiempo mínimo, sí entra.
  assert.equal(stable.update(oscuro, 1000 + MIN_DWELL_MS + 50).issue, "oscuro");
});

test("una causa que aparece un solo frame no llega a pintarse", () => {
  const stable = new StableDiagnosis();
  const sinCara = diagnose(NO_FACE);
  const bien = diagnose(signals());
  let now = 0;
  for (let i = 0; i < 40; i += 1) {
    // Un frame perdido de cada cuatro: exactamente lo que hace un detector real.
    stable.update(i % 4 === 3 ? sinCara : bien, now);
    now += 70;
  }
  assert.equal(stable.current.issue, "ninguno");
});

test("un problema sostenido sí acaba mostrándose", () => {
  const stable = new StableDiagnosis();
  const lejos = diagnose(signals({ boxRatio: 0.1 }));
  let now = 0;
  for (let i = 0; i < 20; i += 1) {
    stable.update(lejos, now);
    now += 70;
  }
  assert.equal(stable.current.issue, "lejos");
});

test("reset devuelve el estabilizador a 'sin problema'", () => {
  const stable = new StableDiagnosis();
  const lejos = diagnose(signals({ boxRatio: 0.1 }));
  for (let i = 0, now = 0; i < 20; i += 1, now += 70) stable.update(lejos, now);
  stable.reset();
  assert.equal(stable.current.issue, "ninguno");
});

// ---------------------------------------------------------------------------
// Retardo del consejo
//
// El estabilizador ya evitaba que el TEXTO parpadeara. Esto es otra cosa: que
// el consejo no le quite el titular al gesto solo porque alguien esté a mitad
// de colocarse. Se prueba con reloj porque el fallo que arregla es de reloj.
// ---------------------------------------------------------------------------

test("un bloqueo recién mostrado todavía no le quita el titular al gesto", () => {
  const stable = new StableDiagnosis();
  const lejos = resolveBlocking(diagnose(signals({ boxRatio: 0.1 })), false);
  let now = 0;
  let shown = stable.current;
  for (let i = 0; i < 20; i += 1, now += 70) shown = stable.update(lejos, now);
  assert.equal(shown.issue, "lejos");
  assert.ok(shown.blocking);
  // Acaba de entrar: el reloj del consejo arranca justo aquí.
  assert.equal(coachReady(shown, stable.heldMs(now)), false);
});

test("un bloqueo que aguanta acaba hablando", () => {
  const stable = new StableDiagnosis();
  const lejos = resolveBlocking(diagnose(signals({ boxRatio: 0.1 })), false);
  let now = 0;
  let shown = stable.current;
  for (let i = 0; i < 60; i += 1, now += 70) shown = stable.update(lejos, now);
  assert.ok(stable.heldMs(now) >= COACH_DELAY_MS);
  assert.equal(coachReady(shown, stable.heldMs(now)), true);
});

test("una causa que no bloquea nunca le quita el titular al gesto", () => {
  // "movido" con el frame ACEPTADO por el gate: molesta, no impide. El titular
  // se queda en el gesto por mucho que dure.
  const movido = resolveBlocking(
    diagnose(signals({ photo: { luma: 0.5, background: 0.5, sharpness: 0.01 } })),
    true,
  );
  assert.equal(movido.issue, "movido");
  assert.equal(coachReady(movido, 60_000), false);
});

test("el reloj del consejo se reinicia al cambiar de causa", () => {
  const stable = new StableDiagnosis();
  const lejos = resolveBlocking(diagnose(signals({ boxRatio: 0.1 })), false);
  const sinCara = resolveBlocking(diagnose(NO_FACE), false);
  let now = 0;
  for (let i = 0; i < 60; i += 1, now += 70) stable.update(lejos, now);
  assert.ok(stable.heldMs(now) >= COACH_DELAY_MS);
  // Cambia la causa y vuelve a entrar: el reloj empieza de cero, no hereda.
  let shown = stable.current;
  for (let i = 0; i < 20; i += 1, now += 70) shown = stable.update(sinCara, now);
  assert.equal(shown.issue, "sin-cara");
  assert.equal(coachReady(shown, stable.heldMs(now)), false);
});

test("el anillo avisa exactamente de lo que enseñaban los medidores", () => {
  // Luz y nitidez perdieron su sitio en pantalla; lo que las sustituye es el
  // ámbar del anillo. Si esta lista se desincroniza, el usuario deja de tener
  // ninguna señal de que la foto va a salir mal.
  const oscuro = diagnose(signals({ photo: { luma: 0.05, background: 0.05, sharpness: 0.6 } }));
  const movido = diagnose(signals({ photo: { luma: 0.5, background: 0.5, sharpness: 0.01 } }));
  assert.equal(imageWarning(oscuro), true);
  assert.equal(imageWarning(movido), true);
  // Lo que ya se dice con palabras no necesita además teñir el anillo.
  assert.equal(imageWarning(diagnose(signals({ boxRatio: 0.1 }))), false);
  assert.equal(imageWarning(diagnose(NO_FACE)), false);
  assert.equal(imageWarning(diagnose(signals())), false);
});

// ---------------------------------------------------------------------------
// Después de un login fallido
// ---------------------------------------------------------------------------

test("una toma buena que no coincide deja el mensaje genérico", () => {
  // Es el punto de seguridad: el 401 de /api/identify es opaco a propósito y el
  // cliente NO puede acercar su mensaje al motivo real del servidor. Con una
  // captura buena, lo único honesto es "no hubo coincidencia".
  const advice = adviceAfterFailure(0.9, "ninguno");
  assert.equal(advice.weak, false);
  assert.match(advice.message, /No hubo coincidencia/);
});

test("el consejo tras un fallo nunca menciona score, umbral ni similitud", () => {
  const prohibidas = /score|umbral|threshold|similitud|coseno|0\.\d/i;
  for (const quality of [0.1, 0.5, WEAK_CAPTURE, 0.8, 1]) {
    for (const issue of ["ninguno", "oscuro", "lejos", "movido", "contraluz"] as const) {
      assert.doesNotMatch(adviceAfterFailure(quality, issue).message, prohibidas);
    }
  }
});

test("una toma floja sí recibe un consejo concreto, y sale del cliente", () => {
  const advice = adviceAfterFailure(WEAK_CAPTURE - 0.2, "contraluz");
  assert.equal(advice.weak, true);
  assert.match(advice.message, /floja/i);
  // El consejo es el mismo que ya se estaba viendo en pantalla durante la
  // captura: no añade información que el usuario no tuviera delante.
  assert.match(advice.message, /ventana|lámpara/i);
});

test("una toma floja sin causa identificada tiene igualmente algo que decir", () => {
  const advice = adviceAfterFailure(0.2, "ninguno");
  assert.equal(advice.weak, true);
  assert.ok(advice.message.length > 20);
});

test("el límite de 'toma floja' es inclusivo por arriba", () => {
  assert.equal(adviceAfterFailure(WEAK_CAPTURE, "oscuro").weak, false);
  assert.equal(adviceAfterFailure(WEAK_CAPTURE - 1e-6, "oscuro").weak, true);
});
