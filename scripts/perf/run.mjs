#!/usr/bin/env node
/**
 * Banco de medición de extremo a extremo, con throttling de CPU real (CDP,
 * `Emulation.setCPUThrottlingRate`) a 1×, 4× y 6×.
 *
 * Qué mide:
 *
 * 1. **Latencia por etapa** —detección a cada `inputSize`, landmarks,
 *    alineación y descriptor— llamando a las redes ya cargadas en la página, no
 *    a un mock. Son los números que calibran `perf.ts`.
 * 2. **fps sostenidos del bucle en vivo**, con la app corriendo de verdad sobre
 *    un `MediaStream` sintético (`canvas.captureStream`). Sin cámara física no
 *    hay otra forma, y con ella el bucle, el overlay, el perfilado adaptativo y
 *    la extracción corren exactamente igual que con una cámara.
 * 3. **Tiempo hasta el primer frame analizado**, con y sin caché de pesos.
 * 4. **Tiempo hasta la primera captura completa** (gesto "de frente" superado y
 *    descriptores extraídos), que es la unidad con la que se proyecta el enrollo.
 *
 * ## Dos motores, y por qué hacen falta los dos
 *
 * - `webgl` corre en el **Chrome instalado**, con GPU real (ANGLE/Metal en un
 *   Mac). Es el único modo que da cifras de WebGL comparables a las de un
 *   equipo de verdad: el Chromium headless de Playwright no tiene GPU y cae a
 *   SwiftShader, que es WebGL por software y midió 44 ms donde el Metal real
 *   mide 17.
 * - `wasm` corre en el Chromium de Playwright con `--disable-gpu`, que fuerza a
 *   tfjs al backend WASM.
 *
 * La distinción importa porque **el throttling de CPU casi no toca a WebGL**:
 * el trabajo está en la GPU y CDP no la frena. Un 6× sobre WebGL no simula un
 * teléfono barato; simula un ordenador con la CPU ocupada. El perfil que sí se
 * parece a un Android de gama baja es WASM (o CPU) con throttling.
 *
 * Playwright es una dependencia de desarrollo **de la raíz** y solo la usa este
 * script: `npm test` sigue corriendo sin él y sin ralentizarse.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const distDir = join(root, "frontend", "dist-perf");
const outDir = join(root, "scripts", "perf", "resultados");

/** El retrato de prueba sale del propio paquete face-api; nunca se commitea. */
const FACE_IMAGE = join(root, "node_modules", "@vladmandic", "face-api", "demo", "sample1.jpg");

const THROTTLES = [1, 4, 6];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
};

function run(command, args) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: root });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} salió con ${code}`))));
  });
}

/**
 * Servidor estático mínimo en un puerto efímero.
 *
 * A propósito **no** se usa `vite preview` ni el 5173: puede haber un dev server
 * de otra persona ahí, y ni chocar con él ni matarlo es cosa de un banco de
 * medición. El puerto 0 deja que el sistema elija uno libre.
 */
function serve(dir, extra = {}) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = extra[path] ?? join(dir, path === "/" ? "index.html" : path.slice(1));
    if (!existsSync(file)) {
      response.writeHead(404).end("no");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // Los assets con hash en el nombre se sirven como inmutables, igual que
      // haría cualquier CDN o servidor estático delante de un build de Vite: si
      // se sirvieran `no-store`, la medición cargaría 1.3 MB de JS en cada
      // visita y atribuiría a los pesos un tiempo que no es suyo. El resto va
      // sin caché para que cada escenario arranque igual.
      "cache-control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port }));
  });
}

function chunkName() {
  const chunk = readdirSync(join(distDir, "assets")).find(
    (name) => name.startsWith("face-api") && name.endsWith(".js"),
  );
  if (!chunk) throw new Error("no encuentro el chunk de face-api en dist-perf/assets");
  return `/assets/${chunk}`;
}

/**
 * Monta el `MediaStream` sintético.
 *
 * El retrato se **auto-encuadra**: se detecta la cara una vez sobre la imagen
 * original y se calcula la transformación para que quede centrada y ocupando la
 * misma fracción del frame que una cara dentro del óvalo. Sin eso, el detector
 * del bucle veía una cara de 40 px, por debajo de `MIN_TRACK_BOX`, y la app
 * pasaba la medición entera diciendo "acerca tu rostro".
 */
/*
 * Ojo: estas dos rutinas se pasan a `page.evaluate` como FUNCIONES, no como
 * cadenas. Playwright evalúa una cadena como expresión y devuelve su valor sin
 * llamarla, así que una cadena con el código de una función se "ejecuta" sin
 * efecto: el stream sintético nunca se montaba y la app acababa pidiendo la
 * cámara real.
 */
const SETUP_STREAM = async ({ chunk, width, height }) => {
  const faceapi = await import(chunk);
  await new Promise((ok) => {
    const timer = setInterval(() => {
      if (faceapi.nets.tinyFaceDetector.isLoaded) { clearInterval(timer); ok(); }
    }, 100);
  });

  const image = new Image();
  image.src = "/perf/rostro.jpg";
  await image.decode();

  const found = await faceapi.detectSingleFace(
    image,
    new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.3 }),
  );
  if (!found) throw new Error("no se detecta ninguna cara en el retrato de prueba");
  const box = found.box;

  // La cara tiene que ocupar ~36 % del ancho del frame: es lo que ocupa una cara
  // bien puesta dentro del óvalo, y deja la caja muy por encima de MIN_SAMPLE_BOX.
  const scale = (width * 0.36) / box.width;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const draw = () => {
    // Un pelo de deriva: con un canvas totalmente estático algunos navegadores
    // dejan de emitir frames y el bucle mediría un vídeo congelado.
    const t = performance.now() / 900;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2 + Math.sin(t) * 1.5, height / 2 + Math.cos(t) * 1.5);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
    requestAnimationFrame(draw);
  };
  draw();
  window.__faceloginTestStream = canvas.captureStream(30);
  return { caraPx: Math.round(box.width * scale) };
};

/** Mide cada etapa por separado sobre las redes YA cargadas por la app. */
const STAGE_BENCH = async ({ chunk, backend, repeticiones }) => {
  const faceapi = await import(chunk);
  await new Promise((ok) => {
    const timer = setInterval(() => {
      if (faceapi.nets.faceRecognitionNet.isLoaded) { clearInterval(timer); ok(); }
    }, 100);
  });
  if (faceapi.tf.getBackend() !== backend) {
    if (backend === "wasm") faceapi.tf.setWasmPaths?.("/tfjs/");
    await faceapi.tf.setBackend(backend);
    await faceapi.tf.ready();
  }

  const image = new Image();
  image.src = "/perf/rostro.jpg";
  await image.decode();

  const frame = document.createElement("canvas");
  frame.width = 960;
  frame.height = 540;
  const fctx = frame.getContext("2d");
  const cover = Math.max(960 / image.width, 540 / image.height);
  fctx.drawImage(image, (960 - image.width * cover) / 2, (540 - image.height * cover) / 2,
    image.width * cover, image.height * cover);

  const crop = document.createElement("canvas");
  crop.width = 150;
  crop.height = 150;
  const cctx = crop.getContext("2d", { willReadFrequently: true });
  cctx.drawImage(frame, 0, 0, 150, 150);

  const mediana = async (fn) => {
    await fn(); // calentamiento: la primera pasada compila shaders
    const muestras = [];
    for (let i = 0; i < repeticiones; i += 1) {
      const t = performance.now();
      await fn();
      muestras.push(performance.now() - t);
    }
    muestras.sort((a, b) => a - b);
    return Number(muestras[muestras.length >> 1].toFixed(2));
  };

  const seguimiento = (size) => async () => {
    await faceapi
      .detectSingleFace(frame, new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.4 }))
      .withFaceLandmarks();
  };
  const soloDeteccion = (size) => async () => {
    await faceapi.detectSingleFace(frame, new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.6 }));
  };

  const resultado = {
    backend: faceapi.tf.getBackend(),
    seguimiento128: await mediana(seguimiento(128)),
    seguimiento160: await mediana(seguimiento(160)),
    seguimiento224: await mediana(seguimiento(224)),
    extraccion256: await mediana(soloDeteccion(256)),
    extraccion320: await mediana(soloDeteccion(320)),
    extraccion416: await mediana(soloDeteccion(416)),
    landmarks: await mediana(async () => { await faceapi.nets.faceLandmark68Net.detectLandmarks(crop); }),
    alineacion: await mediana(async () => {
      cctx.save();
      cctx.translate(75, 75);
      cctx.rotate(0.05);
      cctx.scale(1.4, 1.4);
      cctx.drawImage(frame, -480, -270);
      cctx.restore();
      const data = cctx.getImageData(0, 0, 150, 150);
      const table = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i += 1) table[i] = Math.min(255, Math.round(i * 1.18));
      for (let i = 0; i < data.data.length; i += 4) {
        data.data[i] = table[data.data[i]];
        data.data[i + 1] = table[data.data[i + 1]];
        data.data[i + 2] = table[data.data[i + 2]];
      }
      cctx.putImageData(data, 0, 0);
    }),
    descriptor: await mediana(async () => { await faceapi.computeFaceDescriptor(crop); }),
  };
  return resultado;
};

/**
 * Perfil de red "3G rápido" tal como lo define DevTools. Sin él, medir la caché
 * de pesos no dice nada: contra localhost los 6.7 MB tardan 60 ms con caché y
 * 90 ms sin ella, y la conclusión sería que la caché sobra. Contra 3G la misma
 * comparación es la que de verdad ve alguien en un móvil.
 */
const RED_3G = {
  offline: false,
  latency: 300,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
};
const RED_LIBRE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

async function escenario({ page, cdp, base, chunk, rate, motor, cacheFria, red = "local" }) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  if (cacheFria) {
    await page.evaluate(() => caches.delete("facelogin.models.v1").catch(() => {}));
  }
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", red === "3g" ? RED_3G : RED_LIBRE);

  const arranque = Date.now();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const encuadre = await page.evaluate(SETUP_STREAM, { chunk, width: 960, height: 540 });
  // Guardia, no adorno: si el stream sintético no quedó montado, la app pide la
  // cámara real, el navegador la deniega y la medición entera sería sobre una
  // pantalla de error. Mejor parar aquí que publicar números de nada.
  const pistas = await page.evaluate(
    () => window.__faceloginTestStream?.getVideoTracks?.().length ?? 0,
  );
  if (pistas !== 1) throw new Error("el MediaStream sintético no se montó");

  // El throttling se aplica DESPUÉS de montar el stream: throttlear la carga del
  // retrato de prueba mediría el banco, no la app.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.getByRole("button", { name: "Ya me registré, entrar" }).click();

  try {
    await page.waitForFunction(() => window.__faceloginFirstFrameMs > 0, null, { timeout: 240_000 });
  } catch (error) {
    // Un timeout aquí no es un fallo del banco: puede ser un equipo tan lento
    // que no llega a analizar ni un frame. Dice qué se ve en pantalla en vez de
    // morir con un stack de Playwright.
    const visto = await page.evaluate(() => document.body.innerText.replace(/\n+/g, " | "));
    throw new Error(`sin primer frame en ${motor} ${rate}× tras 240 s. En pantalla: ${visto}`);
  }
  const primerFrame = await page.evaluate(() => window.__faceloginFirstFrameMs);

  // Primera captura completa: el pulso del anillo solo aparece cuando el gesto
  // se superó Y los descriptores salieron. Es un gesto de punta a punta.
  let primeraCaptura = null;
  try {
    await page.waitForSelector(".ring__pulse", { timeout: 120_000 });
    primeraCaptura = Date.now() - arranque;
  } catch {
    // Se reporta como "no llegó". No se inventa un número.
  }

  // fps sostenidos, ya con el perfil estabilizado.
  await page.waitForTimeout(8000);
  const stats = await page.evaluate(() => window.__faceloginStats ?? null);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.send("Network.emulateNetworkConditions", RED_LIBRE);

  return {
    motor,
    rate,
    red,
    cache: cacheFria ? "fría" : "tibia",
    caraPx: encuadre.caraPx,
    primerFrameMs: Math.round(primerFrame),
    modelosMs: stats?.modelMs ?? 0,
    modelosDeCache: stats?.modelFromCache ?? 0,
    fps: stats?.fps ?? 0,
    frameMs: stats?.frameMs ?? 0,
    perfil: stats?.profile ?? "—",
    backend: stats?.backend ?? "—",
    augment: stats?.augment ?? "—",
    trackMs: stats?.trackMs ?? 0,
    extDetectMs: stats?.detectMs ?? 0,
    extAlignMs: stats?.alignMs ?? 0,
    extDescribeMs: stats?.describeMs ?? 0,
    variantMs: stats?.variantMs ?? 0,
    resolucion: stats?.resolution ?? "—",
    frames: stats?.frames ?? 0,
    primeraCapturaMs: primeraCaptura,
  };
}

const MOTORES = {
  webgl: {
    // Chrome instalado, GPU real. El Chromium headless de Playwright no tiene
    // GPU y caería a SwiftShader (WebGL por software), que midió 44 ms donde
    // Metal mide 17: cifras que no representan a ningún usuario.
    channel: "chrome",
    args: ["--enable-gpu", "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"],
    backends: ["webgl"],
  },
  wasm: {
    // Sin GPU, tfjs cae a WASM+SIMD. También es el sitio donde se mide `cpu`,
    // forzándolo desde la página.
    args: ["--disable-gpu", "--disable-software-rasterizer"],
    backends: ["wasm", "cpu"],
  },
};

async function main() {
  if (!existsSync(FACE_IMAGE)) {
    throw new Error(`Falta el retrato de prueba (${FACE_IMAGE}). Corre npm install.`);
  }
  if (!existsSync(distDir) || process.argv.includes("--build")) {
    await run("npm", ["run", "build:perf", "-w", "frontend"]);
  }

  const { chromium } = await import("playwright");
  const { server, port } = await serve(distDir, { "/perf/rostro.jpg": FACE_IMAGE });
  const base = `http://127.0.0.1:${port}/`;
  const chunk = chunkName();
  console.log(`[perf] sirviendo ${distDir} en ${base}`);

  const resultados = { fecha: new Date().toISOString(), etapas: [], escenarios: [] };
  const soloMotor = process.argv.find((a) => a.startsWith("--motor="))?.split("=")[1];

  for (const [motor, config] of Object.entries(MOTORES)) {
    if (soloMotor && soloMotor !== motor) continue;
    let browser;
    try {
      browser = await chromium.launch({ channel: config.channel, args: config.args });
    } catch (error) {
      console.log(`[perf] motor ${motor}: no se pudo lanzar (${error.message.split("\n")[0]})`);
      continue;
    }
    const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`[navegador] ${e.message.slice(0, 300)}`));
    if (process.env.PERF_DEBUG) page.on("console", (m) => console.log(`[c:${m.type()}] ${m.text().slice(0, 200)}`));
    const cdp = await context.newCDPSession(page);
    await page.goto(base, { waitUntil: "domcontentloaded" });

    // Arranque contra 3G: primero con la caché vacía, luego con ella caliente.
    // Es el par que justifica (o no) la caché de pesos.
    resultados.escenarios.push(
      await escenario({ page, cdp, base, chunk, rate: 1, motor, cacheFria: true, red: "3g" }),
    );
    resultados.escenarios.push(
      await escenario({ page, cdp, base, chunk, rate: 1, motor, cacheFria: false, red: "3g" }),
    );

    for (const rate of THROTTLES) {
      resultados.escenarios.push(
        await escenario({ page, cdp, base, chunk, rate, motor, cacheFria: false }),
      );
      for (const backend of config.backends) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        try {
          const etapas = await page.evaluate(STAGE_BENCH, {
            chunk,
            backend,
            repeticiones: rate >= 6 ? 3 : 7,
          });
          resultados.etapas.push({ motor, rate, ...etapas });
        } catch (error) {
          console.log(`[perf] etapas ${backend} ${rate}×: ${error.message.slice(0, 120)}`);
        }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      console.log(`[perf] ${motor} ${rate}× listo`);
    }
    await browser.close();
  }

  server.close();
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `perf-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(resultados, null, 2)}\n`);
  informe(resultados);
  console.log(`\n[perf] crudo en ${file}`);
}

function fila(cells, widths) {
  return cells.map((cell, i) => String(cell).padStart(widths[i])).join(" ");
}

function informe({ etapas, escenarios }) {
  console.log("\n=== Latencia por etapa (mediana, ms) ===");
  const w = [8, 4, 7, 7, 7, 7, 7, 7, 6, 6, 6];
  console.log(
    fila(
      ["backend", "cpu", "seg128", "seg160", "seg224", "ext256", "ext320", "ext416", "lmarks", "alinea", "descr"],
      w,
    ),
  );
  for (const e of etapas) {
    console.log(
      fila(
        [
          e.backend,
          `${e.rate}×`,
          e.seguimiento128,
          e.seguimiento160,
          e.seguimiento224,
          e.extraccion256,
          e.extraccion320,
          e.extraccion416,
          e.landmarks,
          e.alineacion,
          e.descriptor,
        ],
        w,
      ),
    );
  }

  console.log("\n=== Bucle en vivo (app real, MediaStream sintético) ===");
  const v = [7, 4, 6, 6, 7, 8, 6, 8, 8, 10, 11, 9];
  console.log(
    fila(
      ["motor", "cpu", "red", "caché", "perfil", "augment", "fps", "frame", "track", "1er frame", "1ª captura", "modelos"],
      v,
    ),
  );
  for (const s of escenarios) {
    console.log(
      fila(
        [
          s.motor,
          `${s.rate}×`,
          s.red,
          s.cache,
          s.perfil,
          s.augment,
          s.fps.toFixed(1),
          `${s.frameMs.toFixed(0)}ms`,
          `${s.trackMs.toFixed(0)}ms`,
          `${s.primerFrameMs}ms`,
          s.primeraCapturaMs === null ? "no llegó" : `${s.primeraCapturaMs}ms`,
          `${s.modelosMs}ms${s.modelosDeCache > 0 ? "*" : ""}`,
        ],
        v,
      ),
    );
  }
  console.log("(* pesos servidos desde CacheStorage)");

  console.log("\n=== Extracción medida en la app (por captura) ===");
  for (const s of escenarios) {
    if (s.extDetectMs === 0) continue;
    console.log(
      `${s.motor} ${s.rate}×  detección ${s.extDetectMs.toFixed(0)} ms + alineación ${s.extAlignMs.toFixed(0)} ms + descriptores ${s.extDescribeMs.toFixed(0)} ms  (${s.augment}, ${s.variantMs.toFixed(0)} ms/variante)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
