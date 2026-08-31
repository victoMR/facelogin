/**
 * Tests del perfilado adaptativo. Corren con `node:test` + `tsx`, **sin
 * navegador, sin modelos y sin face-api**: `perf.ts` es puro a propósito, y esa
 * pureza es lo que hace que la decisión de perfil se pueda probar en
 * milisegundos en vez de levantar Chrome.
 *
 * Lo que NO se prueba aquí, y hay que decirlo: que 25 ms sea la frontera correcta
 * entre `alto` y `medio` es una calibración medida en el navegador
 * (`npm run test:perf`), no un teorema. Estos tests fijan que la función se
 * comporte como dice su documentación —monótona, acotada, con histéresis, sin
 * saltos de dos escalones— para que un refactor no la mueva sin querer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjustProfile,
  augmentLevelForCost,
  AUGMENT_BUDGET_MS,
  BACKEND_CAP,
  degradation,
  enrollEstimateMs,
  HYSTERESIS,
  LATENCY_MS,
  LatencyWindow,
  MIN_USABLE_FPS,
  minAugmentation,
  nextFrameDelay,
  profile,
  profileForLatency,
  PROFILE_ORDER,
  SLOW_ENROLL_MS,
  sustainedFps,
  VARIANT_COUNT,
  type ComputeBackend,
  type ProfileName,
} from "../perf";

// ---------------------------------------------------------------------------
// Selección de perfil por latencia
// ---------------------------------------------------------------------------

test("una latencia de MacBook con WebGL da el perfil alto", () => {
  assert.equal(profileForLatency(12, "webgl").name, "alto");
  assert.equal(profileForLatency(LATENCY_MS.alto, "webgl").name, "alto");
});

test("los umbrales son inclusivos por abajo y exclusivos por arriba", () => {
  assert.equal(profileForLatency(LATENCY_MS.alto, "webgl").name, "alto");
  assert.equal(profileForLatency(LATENCY_MS.alto + 0.01, "webgl").name, "medio");
  assert.equal(profileForLatency(LATENCY_MS.medio, "webgl").name, "medio");
  assert.equal(profileForLatency(LATENCY_MS.medio + 0.01, "webgl").name, "bajo");
  assert.equal(profileForLatency(LATENCY_MS.bajo, "webgl").name, "bajo");
  assert.equal(profileForLatency(LATENCY_MS.bajo + 0.01, "webgl").name, "minimo");
});

test("un Android que tarda 400 ms por detección cae a mínimo", () => {
  assert.equal(profileForLatency(400, "webgl").name, "minimo");
  assert.equal(profile("minimo").trackInputSize, 128);
  assert.equal(profile("minimo").capture.width, 480);
});

test("la selección es monótona: más lento nunca da un perfil mejor", () => {
  let previous = -1;
  for (let ms = 1; ms <= 500; ms += 1) {
    const index = PROFILE_ORDER.indexOf(profileForLatency(ms, "webgl").name);
    assert.ok(index >= previous, `a ${ms} ms el perfil mejoró en vez de empeorar`);
    previous = index;
  }
});

test("una medición absurda no rompe nada: se cae al perfil neutro", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
    const name = profileForLatency(value, "webgl").name;
    assert.ok(PROFILE_ORDER.includes(name));
  }
  assert.equal(profileForLatency(Number.NaN, "webgl").name, "medio");
});

test("el backend pone un techo que la latencia no puede saltar", () => {
  // Mismo equipo, misma latencia de ensueño: el backend decide el techo.
  assert.equal(profileForLatency(5, "webgl").name, "alto");
  assert.equal(profileForLatency(5, "wasm").name, "medio");
  assert.equal(profileForLatency(5, "cpu").name, "minimo");
});

test("cada umbral es el presupuesto de su propio perfil", () => {
  // No son constantes sueltas: si alguien cambia un presupuesto sin mover el
  // umbral, el perfil prometería unos fps que su cadencia no permite.
  assert.equal(LATENCY_MS.alto, profile("alto").frameBudgetMs);
  assert.equal(LATENCY_MS.medio, profile("medio").frameBudgetMs);
  assert.equal(LATENCY_MS.bajo, profile("bajo").frameBudgetMs);
});

test("una latencia medida en un M2 real cae en `alto`, no en la frontera", () => {
  // 24.6 ms es la mediana medida de detección+landmarks a 224 px con WebGL
  // sobre Metal (`npm run test:perf`). El umbral tiene que dejarla dentro con
  // margen, no rozarla.
  assert.equal(profileForLatency(24.6, "webgl").name, "alto");
});

test("el techo del backend acota por arriba y NUNCA rescata a un equipo malo", () => {
  // El techo limita lo BUENO que puede salir el perfil, no lo malo: que un
  // equipo tenga un backend u otro no es motivo para devolverle un perfil mejor
  // del que su latencia demuestra.
  assert.equal(profileForLatency(900, "webgl").name, "minimo");
  assert.equal(profileForLatency(900, "wasm").name, "minimo");
  assert.equal(profileForLatency(900, "cpu").name, "minimo");
});

test("cada perfil es consistente: más lento, menos trabajo en todos los ejes", () => {
  const names = PROFILE_ORDER.map(profile);
  for (let i = 1; i < names.length; i += 1) {
    const mejor = names[i - 1];
    const peor = names[i];
    assert.ok(peor.trackInputSize <= mejor.trackInputSize, `${peor.name}: inputSize de seguimiento`);
    assert.ok(peor.extractInputSize <= mejor.extractInputSize, `${peor.name}: inputSize de extracción`);
    assert.ok(peor.frameBudgetMs >= mejor.frameBudgetMs, `${peor.name}: presupuesto`);
    assert.ok(peor.capture.width <= mejor.capture.width, `${peor.name}: cámara`);
    assert.ok(peor.maxDpr <= mejor.maxDpr, `${peor.name}: DPR`);
    assert.ok(
      VARIANT_COUNT[peor.augment] <= VARIANT_COUNT[mejor.augment],
      `${peor.name}: augmentación`,
    );
  }
});

test("416 es el techo de extracción: ningún perfil lo sube", () => {
  // El README documenta 224/416 como valores medidos. El pase de rendimiento
  // solo tiene permiso para BAJARLOS.
  for (const name of PROFILE_ORDER) {
    assert.ok(profile(name).extractInputSize <= 416);
    assert.ok(profile(name).trackInputSize <= 224);
  }
});

// ---------------------------------------------------------------------------
// Reajuste en caliente
// ---------------------------------------------------------------------------

test("degradar es inmediato y de un solo escalón", () => {
  // Un equipo en `alto` que empieza a medir 500 ms baja a `medio`, no a `minimo`
  // de golpe: puede ser un pico y el siguiente ciclo lo confirmará.
  assert.equal(adjustProfile("alto", 500, "webgl"), "medio");
  assert.equal(adjustProfile("medio", 500, "webgl"), "bajo");
  assert.equal(adjustProfile("bajo", 500, "webgl"), "minimo");
  assert.equal(adjustProfile("minimo", 500, "webgl"), "minimo");
  // Y con CPU no hay escalones: el techo lo pone en `minimo` de entrada.
  assert.equal(adjustProfile("alto", 500, "cpu"), "minimo");
});

test("promover exige margen: rozar el umbral no basta (histéresis)", () => {
  const justo = LATENCY_MS.alto; // 25 ms: rozando la frontera
  assert.equal(adjustProfile("medio", justo, "webgl"), "medio");

  const holgado = LATENCY_MS.alto * (1 - HYSTERESIS); // 18.75 ms
  assert.equal(adjustProfile("medio", holgado, "webgl"), "alto");
});

test("sin histéresis habría rebote; con ella, no", () => {
  // Un equipo que oscila alrededor del umbral de `alto` (33 ms) se queda en
  // `medio` en vez de cambiar de inputSize —y recompilar shaders— dos veces por
  // segundo.
  let name: ProfileName = "medio";
  for (const ms of [31, 35, 32, 34, 31, 35, 33, 32]) {
    name = adjustProfile(name, ms, "webgl");
  }
  assert.equal(name, "medio");
});

test("el reajuste respeta el techo del backend", () => {
  // Con WASM, por rápido que vaya, nunca sube de `medio`.
  assert.equal(adjustProfile("medio", 1, "wasm"), "medio");
  // Y si alguien fuerza `alto` con WASM, el siguiente reajuste lo corrige.
  assert.equal(adjustProfile("alto", 1, "wasm"), "medio");
});

test("un equipo que se calienta acaba en mínimo, escalón a escalón", () => {
  let name: ProfileName = "alto";
  const visitados: ProfileName[] = [name];
  for (let i = 0; i < 5; i += 1) {
    name = adjustProfile(name, 600, "webgl");
    visitados.push(name);
  }
  assert.deepEqual(visitados, ["alto", "medio", "bajo", "minimo", "minimo", "minimo"]);
});

test("los techos por backend están ordenados como la realidad", () => {
  const index = (b: ComputeBackend) => PROFILE_ORDER.indexOf(BACKEND_CAP[b]);
  assert.ok(index("webgl") < index("wasm"));
  assert.ok(index("wasm") < index("cpu"));
});

// ---------------------------------------------------------------------------
// Calibración de la augmentación
// ---------------------------------------------------------------------------

test("la augmentación sale del coste por variante, no de una constante", () => {
  assert.equal(augmentLevelForCost(40), "full");
  assert.equal(augmentLevelForCost(AUGMENT_BUDGET_MS.full), "full");
  assert.equal(augmentLevelForCost(AUGMENT_BUDGET_MS.full + 1), "light");
  assert.equal(augmentLevelForCost(AUGMENT_BUDGET_MS.light), "light");
  assert.equal(augmentLevelForCost(AUGMENT_BUDGET_MS.light + 1), "off");
  assert.equal(augmentLevelForCost(2000), "off");
});

test("un nivel forzado a mano gana sobre la medición", () => {
  // Es lo que hace `localStorage["facelogin.augment"]`.
  assert.equal(augmentLevelForCost(2000, "full"), "full");
  assert.equal(augmentLevelForCost(1, "off"), "off");
});

test("una medición corrupta no deja el equipo en `full` por accidente", () => {
  assert.equal(augmentLevelForCost(Number.NaN), "light");
  assert.equal(augmentLevelForCost(-1), "light");
});

test("minAugmentation se queda siempre con el más conservador", () => {
  assert.equal(minAugmentation("full", "light"), "light");
  assert.equal(minAugmentation("light", "full"), "light");
  assert.equal(minAugmentation("light", "off"), "off");
  assert.equal(minAugmentation("full", "full"), "full");
});

test("el techo del perfil acota la calibración: en bajo no hay `full`", () => {
  // Es la composición que hace `face.ts`: la medición puede decir `full`, pero
  // el perfil `bajo` la corta a `off`.
  const medido = augmentLevelForCost(10); // full
  assert.equal(minAugmentation(medido, profile("bajo").augment), "off");
  assert.equal(minAugmentation(medido, profile("alto").augment), "full");
});

test("la estimación del enrollo multiplica variantes × gestos × condiciones", () => {
  // 5 gestos, dos condiciones (lentes), `full`, 100 ms por variante.
  assert.equal(enrollEstimateMs("full", 100, 5, 2), 7 * 100 * 5 * 2);
  assert.equal(enrollEstimateMs("off", 100, 5, 1), 500);
});

test("la calibración acota el enrollo: no se puede llegar a `full` y ser lento", () => {
  // Propiedad de diseño, no coincidencia: el nivel baja cuando el coste sube,
  // así que el producto variantes × coste no se dispara. El peor caso realista
  // de un equipo decente (2 condiciones, 5 gestos) se queda muy por debajo del
  // umbral de aviso.
  for (const coste of [10, 60, 119, 121, 300, 321, 800]) {
    const nivel = augmentLevelForCost(coste);
    const total = enrollEstimateMs(nivel, coste, 5, 2);
    assert.ok(total < SLOW_ENROLL_MS, `a ${coste} ms/variante el enrollo son ${total} ms`);
  }
  // Solo un equipo verdaderamente al límite lo cruza: >1.2 s por descriptor.
  assert.ok(enrollEstimateMs(augmentLevelForCost(1400), 1400, 5, 2) > SLOW_ENROLL_MS);
});

// ---------------------------------------------------------------------------
// Degradación honesta
// ---------------------------------------------------------------------------

test("un equipo que va bien no recibe ninguna disculpa", () => {
  const aviso = degradation({ profile: "alto", backend: "webgl", fps: 24 });
  assert.equal(aviso.level, "ninguna");
  assert.equal(aviso.message, "");
});

test("por debajo del piso de fps el aviso es grave y dice el número", () => {
  const aviso = degradation({ profile: "bajo", backend: "webgl", fps: 1.4 });
  assert.equal(aviso.level, "grave");
  assert.match(aviso.message, /1\.4/);
});

test("MIN_USABLE_FPS es la frontera, y no se cruza por redondeo", () => {
  assert.equal(degradation({ profile: "medio", backend: "webgl", fps: MIN_USABLE_FPS }).level, "ninguna");
  assert.equal(
    degradation({ profile: "medio", backend: "webgl", fps: MIN_USABLE_FPS - 0.01 }).level,
    "grave",
  );
});

test("fps 0 significa 'todavía no hay medida', no 'está roto'", () => {
  // Al arrancar no hay fps. Avisar de lentitud antes de haber medido nada sería
  // exactamente la deshonestidad que este bloque intenta evitar.
  assert.equal(degradation({ profile: "alto", backend: "webgl", fps: 0 }).level, "ninguna");
});

test("el backend CPU se anuncia aunque los fps aún no hayan bajado", () => {
  const aviso = degradation({ profile: "bajo", backend: "cpu", fps: 12 });
  assert.equal(aviso.level, "grave");
  assert.match(aviso.message, /JavaScript/);
});

test("el perfil mínimo se anuncia siempre", () => {
  assert.equal(degradation({ profile: "minimo", backend: "webgl", fps: 10 }).level, "grave");
});

test("un enrollo largo se avisa antes de empezarlo", () => {
  const aviso = degradation({
    profile: "medio",
    backend: "webgl",
    fps: 12,
    enrollEstimateMs: SLOW_ENROLL_MS + 1,
  });
  assert.equal(aviso.level, "aviso");
});

test("el perfil bajo avisa, pero sin alarmar", () => {
  assert.equal(degradation({ profile: "bajo", backend: "webgl", fps: 8 }).level, "aviso");
});

// ---------------------------------------------------------------------------
// Medición
// ---------------------------------------------------------------------------

test("la ventana usa mediana, así que un pico aislado no la mueve", () => {
  const window = new LatencyWindow(9);
  for (const ms of [20, 21, 19, 22, 20, 900, 21, 20, 19]) window.push(ms);
  assert.equal(window.median(), 20);
  // La media sería 118 ms y habría degradado el perfil de un equipo sano.
  const media = [20, 21, 19, 22, 20, 900, 21, 20, 19].reduce((a, b) => a + b) / 9;
  assert.ok(media > 100);
});

test("la ventana descarta lo viejo y las medidas imposibles", () => {
  const window = new LatencyWindow(3);
  window.push(10);
  window.push(Number.NaN);
  window.push(-4);
  window.push(20);
  window.push(30);
  window.push(40);
  assert.equal(window.count, 3);
  assert.equal(window.median(), 30);
});

test("una ventana vacía devuelve 0, no NaN", () => {
  assert.equal(new LatencyWindow().median(), 0);
  assert.equal(new LatencyWindow().count, 0);
});

test("la ventana con número par de muestras promedia las dos centrales", () => {
  const window = new LatencyWindow(4);
  [10, 20, 30, 40].forEach((ms) => window.push(ms));
  assert.equal(window.median(), 25);
});

// ---------------------------------------------------------------------------
// Cadencia del bucle
// ---------------------------------------------------------------------------

test("un equipo rápido espera el resto del presupuesto", () => {
  assert.equal(nextFrameDelay(10, 33), 23);
});

test("un equipo lento no espera NADA: ya va tarde", () => {
  // Esta es la propiedad que evita la cola que mataba a los móviles: el retraso
  // nunca es negativo ni se acumula.
  assert.equal(nextFrameDelay(200, 33), 0);
  assert.equal(nextFrameDelay(33, 33), 0);
});

test("el retraso nunca es negativo, para ninguna entrada", () => {
  for (let last = 0; last <= 400; last += 7) {
    for (const budget of [33, 66, 125, 250]) {
      assert.ok(nextFrameDelay(last, budget) >= 0);
      assert.ok(nextFrameDelay(last, budget) <= budget);
    }
  }
});

test("los fps sostenidos los manda el más lento de los dos límites", () => {
  // Equipo rápido: manda el presupuesto (no tiene sentido ir a 200 fps).
  assert.equal(Math.round(sustainedFps(5, 33)), 30);
  // Equipo lento: manda la latencia real.
  assert.equal(Math.round(sustainedFps(250, 33)), 4);
  assert.equal(Math.round(sustainedFps(1000, 250)), 1);
});

test("cada perfil declara un presupuesto que sus fps objetivo pueden cumplir", () => {
  // Si el presupuesto de `minimo` diera menos de MIN_USABLE_FPS incluso con
  // latencia cero, el perfil estaría prometiendo algo que no puede dar.
  assert.ok(sustainedFps(0, profile("minimo").frameBudgetMs) >= MIN_USABLE_FPS);
  assert.ok(sustainedFps(0, profile("alto").frameBudgetMs) >= 24);
});
