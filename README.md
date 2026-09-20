# facelogin
![CI](https://github.com/victoMR/facelogin/actions/workflows/ci.yml/badge.svg)](https://github.com/victoMR/facelogin/actions/workflows/ci.yml)
**La foto no viaja.**

Autenticación solo con tu cara. Sin contraseña.
El navegador saca un descriptor; el servidor guarda una plantilla cifrada.
Listo como IdP OIDC (PKCE) para demos e integraciones internas.

Licencia: [MIT](LICENSE).

> Demo / IdP interno — no es Face ID bancario. El liveness corre en el cliente. El JWT exige la cara **y** una firma de dispositivo o una passkey; el texto de las palabras no abre sesión.

## Norte

Ambición: el auth **open source sin password** — fácil para ti, infernal para ellos.
Hoy cumplimos **La foto no viaja** (demo / IdP interno). El camino a seguridad verificable en servidor (attestation, honeypots, threat model + FAR/FPIR) está en [`docs/norte.md`](docs/norte.md).

## Cómo lo hacen quienes ya lo hicieron bien

| Sistema | Qué aciertan | Qué no copiamos a ciegas |
| --- | --- | --- |
| **Apple Face ID** | Match 1:1 en enclave, FAR ~1/1 000 000, profundidad 3D, plantilla que no sale del dispositivo | No tenemos sensor TrueDepth; compensamos con liveness 2D + umbral más alto |
| **Android Face Unlock / Play Integrity** | Plantilla en TEE cuando el OEM lo permite | Muchos desbloqueos 2D son débiles ante foto; aquí el login es 1:N y por eso el umbral sube con el tamaño de la galería |
| **FaceMe / CyberLink** | Guardan *features*, no fotos, y cifran AES-256 | Mismo principio: el vault nunca persiste JPEG/PNG |
| **Bancos / eKYC** | Liveness certificado (iBeta) y prueba de vida activa | En este repo la prueba es activa y local (parpadeo + yaw), no un vendor PAD |
| **NIST FRVT** | Los mejores algoritmos bajan de 0.1 % FNMR a 0.001 % FMR | Usamos FaceNet 128-d en el navegador: menos preciso que ArcFace 512, suficiente para un vault local pequeño |
| **CipherFace / CryptoMask** | Comparan embeddings en dominio cifrado (FHE) | FHE es caro en CPU; aquí ciframos en reposo y comparamos tras descifrar solo los candidatos LSH |

Prácticas que este repo toma como no negociables:

1. **La foto no viaja.** El descriptor se calcula en el cliente.
2. **La plantilla se cifra** (AES-256-GCM). Un `vault.json` filtrado no entrega caras ni vectores en claro.
3. **El índice es irreversible.** Las cubetas LSH se firman con HMAC-SHA256; no se puede reconstruir el embedding desde la clave de cubeta.
4. **Hay prueba de vida** antes de enrolar o entrar (frente, parpadeo, giro) — pero es del cliente, y por tanto UX, no control de seguridad (ver *Límites honestos*).
5. **El umbral no es un número mágico único.** Se calcula por persona y por tamaño de galería.

## Fiabilidad y umbral

Un sistema facial no “reconoce o no”: compara una similitud (coseno, tras L2-normalizar) contra un **umbral operativo**. Ese umbral equilibra:

- **FAR / FPIR** — aceptar a otra persona (grave en auth: entrega la cuenta)
- **FRR / FNIR** — rechazarte a ti (molesto, pero recuperable reintentando)

### El umbral se calibra con caras reales, no con vectores sintéticos

Hasta la recalibración, todo esto se ajustaba con descriptores inventados. **Con vectores sintéticos no se puede elegir un umbral**: la distribución impostora es la que uno decide al generarla, así que un FAR del 27 % medido ahí no significa nada. El banco de evaluación es ahora:

```
npm run eval:threshold
```

Descarga **LFW** (Labeled Faces in the Wild, 5749 personas / 13 233 imágenes), extrae los descriptores con **el mismo `@vladmandic/face-api` y el mismo recorte alineado que corre en el navegador** —en Node, sin `canvas` ni `tfjs-node`— y produce distribuciones, curva DET, EER, tabla FAR/FRR y el ROC de conjunto abierto (FPIR/TPIR) del NIST. Los descriptores se cachean, así que la primera ejecución tarda ~5 min y las siguientes segundos, con los mismos números. El informe queda en `scripts/eval/resultados/lfw.json`.

Fuente y licencia del dataset, y sus límites conocidos, están documentados en `scripts/eval/dataset.mjs`. En resumen: **LFW es más fácil que una webcam real** (fotos de prensa, frontales, bien iluminadas) y tiene un sesgo demográfico fuerte (~77 % hombres, ~83 % piel clara), así que el FAR de aquí no se extrapola a otra población. El detector de extracción del proyecto (416 px, score 0.6) encuentra cara en 10 641 de las 13 233 imágenes: el 80.4 %.

### El error de aritmética que estaba en la raíz

Este README decía *“en vectores unitarios, la distancia euclidiana 0.6 de face-api equivale a un coseno ≈ 0.82”*. La equivalencia es correcta **solo si los vectores son unitarios, y los de face-api no lo son**: su norma medida es **‖d‖ = 1.4318** (p01 1.2912, p99 1.6010). Con norma `r`, `d² = 2r²(1 − cos)`, así que:

- el listón de face-api (distancia 0.6) es **coseno 0.912**, no 0.82;
- un coseno de 0.82 es **distancia 0.86**, muy por encima de ese listón.

Y aun así 0.82 tampoco sería un umbral: es lo que da un impostor cualquiera.

### Lo que hay realmente ahí fuera

6000 pares oficiales de LFW (View 2), coseno tras L2-normalizar:

| | media | σ | p01 | p05 | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| genuino (misma persona) | 0.9494 | 0.0245 | 0.8422 | 0.9137 | 0.9534 | 0.9767 | — | — |
| impostor (personas distintas) | 0.8370 | 0.0346 | — | — | 0.8383 | 0.8915 | 0.9093 | 0.9269 |

**El impostor medio puntúa 0.837.** Con el umbral que había —base 0.52, techo 0.72, umbral efectivo medido en el vault de producción **0.5773**— no filtraba nada.

Tabla FAR/FRR por umbral (verificación 1:1):

| coseno | distancia equiv. | FAR 1:1 | FRR 1:1 |
| --- | --- | --- | --- |
| 0.88 | 0.701 | 9.905 % | 2.83 % |
| 0.90 | 0.640 | 2.278 % | 3.74 % |
| 0.91 | 0.607 | 0.953 % | 4.61 % |
| 0.92 | 0.573 | 0.318 % | 7.09 % |
| 0.93 | 0.536 | 0.000 % | 11.79 % |
| 0.95 | 0.453 | 0.000 % | 41.70 % |

**EER 3.49 % en coseno 0.8954** — y el EER **no** es el punto de operación: ahí el FPIR de 1:N sería del 30 %.

### El punto de operación se elige por FPIR

En 1:N lo que importa no es el FAR de una comparación, sino el **FPIR**: la probabilidad de que un probe de alguien que **no** está en la galería empareje con alguien. Es exactamente el fallo que ocurrió. Objetivo de diseño: **FPIR ≤ 0.1 %**, medido contra 1500 personas que aparecen una sola vez en todo LFW y por tanto no pueden estar enroladas.

FPIR / TPIR medidos (enrollo de 5 capturas por identidad):

| umbral | N=1 | N=3 | N=10 | N=100 |
| --- | --- | --- | --- | --- |
| 0.90 | 5.667 % / 100 % | 24.467 % / 100 % | 63.067 % / 100 % | 98.933 % / 97.5 % |
| 0.92 | 0.267 % / 100 % | 3.867 % / 100 % | 14.867 % / 100 % | 73.400 % / 97.5 % |
| 0.94 | 0.000 % / 100 % | 0.133 % / 100 % | 0.800 % / 100 % | 8.867 % / 97.5 % |
| 0.95 | 0.000 % / 100 % | 0.067 % / 100 % | 0.067 % / 100 % | 1.333 % / 95.0 % |
| 0.96 | 0.000 % / 100 % | 0.000 % / 100 % | 0.000 % / 95 % | 0.267 % / 88.0 % |
| 0.97 | 0.000 % / 100 % | 0.000 % / 50 % | 0.000 % / 50 % | 0.067 % / 57.5 % |

Por encima de 0.96 el FRR se dispara sin comprar FPIR: ese es el techo.

### La fórmula

```
umbral = 0.93                     // listón 1:N, por encima del 1:1 de face-api (0.912)
       + cobertura(0–0.030)       // (1 − intraMean) · 0.22 del sub-cluster
       + dispersión(0–0.015)      // intraStd · 0.30
       + separación(0–0.020)      // (0.95 − coseno entre condiciones) · 0.30
       + margen_1N(0–0.030)       // 0.005 · log10(N+1) · 3
       + multi-probe(0–0.005)     // 0.0015 · log2(descriptores por intento)
       + muestras(0–0.005)        // 0.001 · log2(1 + muestras guardadas)
       acotado a [0.92, 0.96]     // el acotado se aplica AL FINAL, penalizaciones incluidas
```

Todos los coeficientes están medidos, no elegidos:

- **cobertura.** Ordenando 120 identidades por lo ancho de su enrollo, el tercio más ancho (`intraMean` 0.9315) atrae impostores a p99 0.9266 y el más apretado (0.9618) a 0.9207: 0.0059 de p99 por 0.030 de `intraMean` ⇒ coeficiente ≈ 0.20. El 0.22 que ya estaba escrito era correcto; lo que estaba mal eran los **topes**, dimensionados para una escala de 0.52 donde sobraba sitio.
- **separación entre condiciones.** El ancla pasó de 0.9 a 0.95 porque la separación real entre dos condiciones de la misma persona es 0.98–0.99: con el ancla vieja este término era cero siempre.
- **margen 1:N.** Sale directamente de la tabla FPIR/TPIR de arriba.
- **multi-probe.** Medido con las variantes de augmentación **de verdad**, no con tiradas independientes: pasar de 1 a 7 descriptores sube el p99 del impostor de 0.9511 a 0.9550 (+0.0039) y el p05 del dueño de 0.9516 a 0.9555 (+0.0039). El coeficiente anterior (0.015·log2 N, tope 0.035) era un orden de magnitud mayor de lo que hace falta — en la escala nueva habría rechazado al dueño en cada login.
- **muestras guardadas.** Es el término que faltaba. El motor puntúa con `max` sobre el centroide **y cada muestra** de cada condición; la plantilla de producción guardaba 2 × 15 muestras, o sea 32 comparaciones por probe. Aislado, pasar de 0 a 20 muestras sube el p99 del impostor de 0.9481 a 0.9520 (+0.0039). Es real, pero **mucho menor de lo que parece**: las muestras de una misma persona están muy correlacionadas, así que el máximo de 32 no es el máximo de 32 tiradas independientes.
- **el acotado final.** `MAX_COSINE_THRESHOLD` no era un techo real, porque las penalizaciones se sumaban después. Con galería de 100, colarse a 0.9626 costaba 5.5 puntos de TPIR (82.5 % en vez de 88 %) con el mismo FPIR.

**La señal de calidad estaba invertida y se corrigió**, y la corrección resiste la medición: el enrollo ancho es el que atrae más impostores y el que necesita el listón alto, no el apretado.

Durante el enrollo se miden `intraMean` e `intraStd` **por sub-cluster**, nunca sobre la mezcla. Los dos límites del gate también estaban demasiado bajos: `intraMean` pasa de 0.62 a **0.88** y `intraStd` de 0.14 a **0.10**. Medido, cinco fotos de la misma persona dan `intraMean` 0.9502 (p50) y 0.8877 en el peor caso de 203 identidades, mientras que cinco fotos de cinco personas **distintas** dan como mucho 0.8702: el gate de 0.62 aceptaba sin pestañear un “enrollo” de cinco desconocidos.

### El incidente, con números

Reconstruido sobre LFW con la forma exacta que tenía el vault de producción —galería de 3 identidades, enrollo de 2 condiciones × 15 muestras— y 1500 desconocidos:

| calibración | umbral efectivo | FPIR | TPIR |
| --- | --- | --- | --- |
| la que había | 0.5773 | **100.000 %** (1500/1500) | 100 % |
| su techo absoluto | 0.7200 | **100.000 %** (1500/1500) | 100 % |
| la nueva | 0.9578 | **0.067 %** (1/1500) | 100 % |

El desconocido que **menos** puntuaba contra esa galería sacaba 0.8519, es decir, 0.27 por encima del umbral que estaba en producción. No entró alguien que se pareciera mucho: entraba cualquiera.

Comprobado además de punta a punta con el `FaceEngine` real:

| galería | TPIR | FPIR |
| --- | --- | --- |
| 3 | 100.00 % | 0.000 % (0/1500) |
| 25 | 90.00 % | 0.067 % (1/1500) |
| 100 | 88.00 % | 0.267 % (4/1500) |

El TPIR de las galerías grandes es el precio elegido a sabiendas: los probes son fotos de LFW tomadas en otro momento y otro sitio que el enrollo, y un login real ocurre con la misma cámara y luz parecida. Un rechazo se resuelve reintentando; un desconocido dentro, no.

`backend/src/__tests__/openset.test.ts` recalcula el FPIR en cada `npm test` con un fixture de descriptores reales (30 identidades + 400 desconocidos, generado por el banco). Si alguien vuelve a bajar el umbral, falla ahí y no en producción.

## Enrollo multi-condición: el caso de los lentes

Quien se enrola con lentes tiene que poder entrar sin ellos. La vía que **no** funciona es sintetizar un descriptor “sin lentes” a partir del de “con lentes”: un vector de 128-d ya perdió esa información y no es separable; generar variantes sintéticas del vector solo ensancha el cluster y sube el FAR.

Lo que se hace en su lugar:

1. **Se pregunta.** Si el usuario dice que usa lentes, el enrollo pide las dos tandas. No se detectan los lentes automáticamente: en 2D es poco fiable con reflejos y monturas finas, y el usuario lo sabe seguro.
2. **Se guardan como sub-clusters de la misma identidad**, cada uno con su centroide, sus muestras y sus propias métricas. **No se promedian**: el promedio de “con lentes” y “sin lentes” cae en tierra de nadie, lejos de las dos nubes.
3. **El match compara contra el sub-cluster más cercano**, y el umbral sale de la condición que gana, no de la mezcla.
4. **Se comprueba que sigan siendo la misma cara.** Los centroides de dos condiciones tienen que estar a coseno ≥ **0.92** entre sí. El valor anterior, 0.45, era una puerta abierta: dos personas distintas puntúan 0.837 de media y 0.9269 en el máximo medido, así que “también me enrolo con lentes” era la forma trivial de meter a un segundo individuo bajo una sola identidad.

### Cuánto mueven los lentes al descriptor (medido, no supuesto)

Aquí es donde la calibración anterior estaba más equivocada. Asumía que unos lentes mueven el descriptor a coseno **0.60–0.65** entre condiciones. Medido:

| | coseno entre condiciones de la MISMA persona |
| --- | --- |
| enrollo real del vault de producción (con lentes / sin lentes) | **0.9907** |
| 42 identidades de LFW partidas en dos (2-medias): media / p05 / mínimo | 0.9845 / 0.9755 / 0.9444 |
| dos personas **distintas** (referencia): media / p99 / máximo | 0.8370 / 0.9093 / 0.9269 |

Es decir: dos condiciones de la misma persona están **mucho** más cerca entre sí que dos personas distintas. Un `crossCosine` de 0.62 no describe unos lentes; describe a otra persona. De ahí sale el 0.92 del punto 4.

### Con el listón bien puesto, ¿sigue funcionando el enrollo multi-condición?

Sí, **si se enrolan las dos condiciones**. Lo que se pierde es la *tolerancia* a entrar en una condición que nunca se enroló. Medido sobre LFW, con las dos nubes reales de cada persona:

| | p05 | p50 |
| --- | --- | --- |
| enroló A, entra en A | 0.9531 | 0.9748 |
| enroló **solo** A, entra en B | 0.9413 | 0.9651 |
| enroló **A y B**, entra en B | 0.9512 | 0.9739 |

Con el umbral en ~0.955 la fila del medio no entra de forma fiable y las otras dos sí. **La solución correcta es exigir un enrollo por condición, no una tolerancia más ancha**: bajar el umbral para salvar la comodidad de los lentes es exactamente lo que causó el incidente. Enrolar la segunda condición recupera prácticamente todo (0.9512 frente a 0.9531).

### Por qué no basta con echarlo todo a un cluster

Medido en `src/__tests__/conditions.test.ts` (200 intentos por fila, galería de 3, el dueño enroló con lentes y entra **sin** ellos). Los parámetros del generador ya no son inventados: salen de la medición sobre LFW (`MEDIDO` en `synthetic.ts`).

| coseno con/sin lentes | frame de login | solo una condición | todo en un cluster | sub-clusters |
| --- | --- | --- | --- | --- |
| 0.93 | típico (p50) | 0.0 % | 62.5 % | **100.0 %** |
| 0.96 | típico (p50) | 0.0 % | 80.0 % | **100.0 %** |
| 0.98 | típico (p50) | 49.5 % | 99.0 % | **100.0 %** |
| 0.99 | típico (p50) | 98.0 % | 100.0 % | 100.0 % |
| 0.93 | malo (p05) | 0.0 % | 5.5 % | **67.5 %** |
| 0.96 | malo (p05) | 0.0 % | 16.0 % | **96.5 %** |
| 0.98 | malo (p05) | 5.0 % | 58.5 % | **95.0 %** |
| 0.99 | malo (p05) | 40.0 % | 85.0 % | **95.5 %** |

Hay que corregir también lo que este README afirmaba antes. Decía que el cluster único da 0 % porque *“el alta ni siquiera ocurre: la mezcla da `intraStd ≈ 0.19`, por encima del límite de 0.14”*. Con la separación entre condiciones que de verdad existe, **eso ya no pasa**: la mezcla da `intraStd ≈ 0.028` y el gate en bloque la acepta. La ganancia de los sub-clusters es más modesta y viene de otro sitio: la mezcla arrastra un `intraMean` peor y por tanto un **umbral más alto** (0.9600 frente a 0.9503 para la misma persona), y eso se paga en FRR sin comprar nada de FAR.

### FAR y FRR sintéticos: para qué sirven y para qué no

`src/__tests__/far.test.ts`, galería de 20, 150 impostores por banda. Las bandas también se remidieron: estaban en 0.35–0.55 y 0.55–0.75, descritas como “donde vive un hermano o un doble”. En LFW **dos personas cualesquiera** puntúan 0.8370 de media; un impostor a coseno 0.45 no existe. Las bandas nuevas son 0.84–0.90 (la masa de la distribución) y 0.90–0.94 (del p99 al máximo observado y un poco más allá).

| montaje | FAR parecido (0.84–0.90) | FAR extremo (0.90–0.94) | FRR misma condición | FRR otra condición |
| --- | --- | --- | --- | --- |
| línea base (1 condición × 5, 1 descriptor) | 0 % | 0 % | 0 % | **95 %** |
| sub-clusters (2 × 5, 1 descriptor) | 0 % | 0 % | 0 % | **0 %** |
| sub-clusters (2 × 5, 4 descriptores) | 0 % | 0 % | 0 % | 0 % |
| sub-clusters + augmentación (2 × 6, 4 descriptores) | 0 % | 0 % | 0 % | 0 % |

Que el FAR salga 0 % en todas las bandas es la consecuencia esperable de subir el umbral por encima del máximo impostor observado, y **no es una cifra de producto**: estos impostores son vectores colocados a un coseno que elegimos nosotros. Sirven para comparar montajes entre sí (¿empeora al añadir sub-clusters o descriptores?). La cifra de producto es el FPIR de la sección anterior, medida con caras reales.

El recall del índice **no** es donde ganan los sub-clusters: el multi-probe Hamming-1 sobre 10 tablas ya lo tenía saturado (100 % → 100 %). Indexar la segunda condición no lo mejora de forma apreciable; simplemente no lo empeora.

## Calidad de la extracción

- **Alineación por landmarks antes de extraer.** El recorte se define con los ojos, no con la caja del detector: roll a 0, escala fija por distancia interocular, centro entre ojos y boca. La caja de TinyFaceDetector baila varios píxeles entre frames; la distancia interocular no. Es la mejora individual más rentable, y el encuadre resultante se mantiene cerca del de la caja (≈3.1 × interocular) porque la red de reconocimiento se entrenó con recortes de ese estilo.
- **Dos detectores.** Seguimiento en vivo a 224 px / score 0.4 (40 veces por segundo, solo tiene que decir dónde está la cara) y extracción a 416 px / score 0.6 (una vez por captura, decide la calidad del descriptor que acaba en el vault).
- **El descriptor sale del frame que pasó el liveness.** Antes `extractDescriptor` hacía una segunda detección sobre un frame *nuevo* y no volvía a aplicar `sampleGate`: el vector que se enviaba podía venir de otro instante y sin control de calidad. Ahora el frame se congela en un canvas antes de analizarlo, y el gate se reaplica sobre la detección de extracción.
- **La captura del parpadeo espera a que el ojo se abra.** El reto se daba por superado en cuanto el párpado empezaba a subir, y ese frame —el peor de la sesión— era además el único que se mandaba al login.
- **Constantes con nombre.** `MIN_TRACK_BOX` (64) y `MIN_SAMPLE_BOX` (80) siguen siendo distintas a propósito: el seguimiento se mantiene permisivo para poder decir “acércate” en vez de quedarse mudo, y el mínimo de extracción es el que decide si una captura entra.
- **El login manda varios descriptores.** Los mejores por calidad (score de detección, tamaño, frontalidad y nitidez por varianza del laplaciano), no `samples.at(-1)`.

## Augmentación sobre el frame — y su palanca de rendimiento

Las 5 capturas del enrollo salen de frames consecutivos de la misma sesión: misma luz, misma cámara, mismo encuadre. El enrollo representa **una sola condición**. Antes de extraer, cada frame se dibuja en un canvas fuera de pantalla y se generan variantes —espejo horizontal, brillo/gamma/contraste, micro-rotaciones de ±6°, crop ligero— y se extrae un descriptor de cada una. Las transformaciones geométricas van *dentro* de la matriz de alineación, así que no cuestan un pase extra sobre el frame completo.

Esto multiplica el trabajo justo en los equipos que menos tienen, así que el número de variantes es una palanca explícita, no una constante enterrada:

| nivel | variantes | cuándo |
| --- | --- | --- |
| `off` | 1 | gama muy baja |
| `light` | 3 | por defecto al arrancar |
| `full` | 7 | escritorio |

- Se arranca en `light` y se **sube** a `full` si el equipo responde, no al revés: empezando en `full`, un equipo lento pagaría la captura de 7 variantes al menos una vez antes de que la medición lo salvara.
- `calibrateAugmentation(msPorVariante)` decide con el coste real medido de la primera extracción, contra `AUGMENT_BUDGET_MS`.
- El **perfil del dispositivo pone además un techo**: en `bajo` o `minimo` no hay medición que devuelva `full`. El nivel efectivo se *recalcula* de sus dos fuentes (lo medido y el techo del perfil) en cada cambio de perfil, en vez de acumularse hacia abajo: si el perfil sube, la augmentación puede volver a subir con él.
- `setAugmentationLevel(nivel)` lo fuerza desde código, y `localStorage["facelogin.augment"]` lo fija entre sesiones.

La decisión vive en `frontend/src/perf.ts` (puro, con tests) y el estado en `frontend/src/face.ts`.

Esto no sustituye un sensor 3D ni un modelo ArcFace 512. Evita, eso sí, el fallo clásico de “cualquier cara parecida entra” al exigir:

- calidad de caja y score de detección en el cliente
- liveness de gesto
- umbral adaptativo en el servidor
- máximo entre centroide y cada muestra cifrada (no un único promedio flojo)

## Rendimiento multi-dispositivo

El reconocimiento tiene que funcionar en un MacBook y en un Android de gama muy baja, y esas dos máquinas no aguantan la misma configuración. Antes había constantes fijas —`inputSize` 224/416, una cadencia de bucle constante, `getUserMedia` sin resolución— y eso significaba desperdiciar capacidad arriba y ahogar la máquina abajo.

### El bucle: presupuesto por frame, no intervalo fijo

El fallo de fondo del diseño anterior era programar el siguiente frame con un `setTimeout` de intervalo constante. En un equipo donde la detección tarda más que el intervalo, cada vuelta encola trabajo sobre una cola que ya no se vacía: el equipo lento no se ralentiza, se muere, con la pantalla congelada y el anillo parado.

Ahora el siguiente frame **solo se programa cuando el anterior ha resuelto su promesa** — es estructuralmente imposible tener dos detecciones en vuelo—, y el salto final es un `requestAnimationFrame`, que además para el bucle en seco cuando la pestaña pasa a segundo plano (un móvil en el bolsillo deja de ocupar la cámara). El presupuesto se cobra sobre el **frame completo** (copia del vídeo + detección + landmarks + overlay), no solo sobre la red: en un móvil con DPR 3 el `drawImage` del óvalo cuesta tanto como la detección.

### Perfiles

El perfil no se adivina por `hardwareConcurrency`, `deviceMemory` ni user agent —son proxies malos: un teléfono de 8 núcleos con la GPU saturada va peor que un portátil de 2—, sino que **se mide** la latencia real del frame y se decide con eso, con histéresis para no rebotar (cambiar de `inputSize` obliga a tfjs a recompilar shaders).

| perfil | seguimiento | extracción | presupuesto | augmentación | cámara | DPR máx |
| --- | --- | --- | --- | --- | --- | --- |
| `alto` | 224 | 416 | 33 ms | `full` | 1280×720 | 2 |
| `medio` | 224 | 416 | 66 ms | `light` | 960×540 | 2 |
| `bajo` | 160 | 320 | 125 ms | `off` | 640×480 | 1.5 |
| `minimo` | 128 | 256 | 250 ms | `off` | 480×360 | 1 |

**224/416 es el techo, no el objetivo.** Los valores medidos que documenta *Calidad de la extracción* se conservan intactos en `alto` y `medio`; los perfiles lentos solo pueden bajarlos. Un test lo fija para que nadie los suba "aprovechando" el mecanismo.

El umbral de cada perfil **es su propio presupuesto de frame**: te toca el perfil X si tu latencia medida cabe dentro de lo que X promete. Cualquier otra elección haría que un perfil prometiera unos fps que su cadencia no permite.

### Backend de cómputo: verificado, no supuesto

`tf.setBackend('webgl')` puede devolver `true` y fallar en la primera convolución —la GPU está en la lista negra, el contexto se pierde, es un WebGL por software—. Así que se pide el backend, **se corre una convolución 2D real** y solo si devuelve el resultado correcto se da por bueno; si no, se prueba el siguiente. Orden: WebGL → WASM (con SIMD) → CPU.

Medido con `npm run test:perf` en un M2 (medianas, ms; `seg` = detección + landmarks, `ext` = solo detección de extracción):

| backend | cpu | seg128 | seg160 | seg224 | ext256 | ext320 | ext416 | landmarks | descriptor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| webgl (Metal) | 1× | 16.4 | 18.8 | 29.3 | 19.2 | 22.7 | 25.9 | 7.3 | 18.6 |
| webgl | 4× | 24.7 | 23.4 | 34.8 | 23.7 | 27.5 | 29.0 | 8.1 | 23.1 |
| webgl | 6× | 30.8 | 29.0 | 56.6 | 32.7 | 38.5 | 40.1 | 9.0 | 24.3 |
| wasm+SIMD | 1× | 4.0 | 5.8 | 16.1 | 14.4 | 23.1 | 39.2 | 4.8 | 15.7 |
| wasm | 4× | 16.7 | 24.5 | 67.9 | 61.0 | 96.3 | 163.2 | 19.6 | 66.1 |
| wasm | 6× | 24.0 | 37.2 | 101.8 | 92.0 | 148.2 | 245.3 | 30.6 | 98.9 |
| cpu | 1× | 79.7 | 123.1 | 380.0 | 317.7 | 501.1 | 839.7 | 139.1 | 468.8 |
| cpu | 4× | 330.5 | 513.4 | 1587.8 | 1324.5 | 2146.5 | 3560.0 | 577.8 | 1962.1 |
| cpu | 6× | 453.7 | 738.0 | 2396.4 | 1967.0 | 3091.7 | 5206.2 | 860.9 | 2926.5 |

Tres cosas que la tabla dice y la intuición no:

1. **El throttling de CPU casi no toca a WebGL** (29.3 → 56.6 ms entre 1× y 6×, y los fps del bucle en vivo se quedan en 12–13 en los tres niveles). El trabajo está en la GPU y CDP no la frena. Un 6× sobre WebGL **no simula un teléfono barato**: simula un ordenador con la CPU ocupada. Esto es una limitación real del método que pedía el encargo, y hay que decirla: el escenario que sí se parece a un Android de gama baja es WASM —o CPU— con throttling.
2. **WASM en reposo gana a WebGL** en el detector chico (16.1 vs 29.3 ms): a 224 px subir la textura y leerla de vuelta pesa más que el cálculo. Aun así el techo de WASM se queda en `medio`, y el motivo está en la misma tabla: entre 1× y 4× WASM se multiplica por 4.2 y WebGL por 1.2. Un equipo en WASM no tiene margen —cualquier trabajo de fondo lo tumba— y `alto` compromete 7 variantes por captura y una cámara de 720p.
3. **`cpu` solo aguanta el perfil `minimo`, y ni así a 6×** (ver *¿Hay un piso de hardware?*).

### Pesos propios y con caché

Los modelos ya **no salen de `cdn.jsdelivr.net`**. Eran 6.7 MB de binarios servidos por un tercero, sin versión fijada y sin SRI, que se ejecutan como red neuronal en la misma página que tiene abierta la cámara. Ahora salen de `frontend/public/models/`, mismo origen que la app, y los `.wasm` del backend WASM de `frontend/public/tfjs/`. `scripts/sync-assets.mjs` los copia desde `node_modules` en `predev` y `prebuild`, así que la versión de los pesos y la del código que los interpreta no pueden divergir; no se commitean.

La caché es `CacheStorage`, y cada entrada se verifica contra su SHA-256 (`frontend/src/model-digests.json`) antes de servirse: es lo que sustituye al SRI que nunca hubo, y descarta una entrada corrupta o manipulada en vez de dársela a la red.

Hubo que instalar el `fetch` con caché en **dos** sitios, y costó una medición descubrirlo: `faceapi.env` cubre los manifiestos (32 kB), pero los shards de pesos (6.95 MB) los pide `tf.io.loadWeights` con el `fetch` de plataforma de tfjs. Con solo el primero, el banco de medición contra 3G daba lo mismo en frío que en caliente.

Medido contra 3G rápido (1.6 Mbit/s, 300 ms de RTT), tiempo hasta el primer frame analizado:

| caché de pesos | primer frame | pesos |
| --- | --- | --- |
| fría | 35 459 ms | 34 840 ms de red |
| caliente | 1 987 ms | 63 ms de `CacheStorage` |

**17.8× más rápido en la segunda visita**, y sin conexión al CDN la app arranca igual porque ya no hay CDN. Contra localhost el mismo par mide 777 ms y 593 ms: por eso el banco emula 3G, porque medir la caché contra un servidor local diría que sobra.

### Carga diferida

face-api son ~1.3 MB minificados (tfjs entero con sus backends CPU, WebGL y WASM) que el visitante de la portada no necesita para leer "Entra con tu cara". Ahora se carga con `import()` dinámico:

| | antes | después |
| --- | --- | --- |
| chunk inicial | 1 542 kB (gzip 408 kB) | **230 kB (gzip 74 kB)** |
| chunk diferido | — | 1 328 kB (gzip 340 kB) |

El prefetch se sigue disparando al montar la app, así que quien va a usar la cámara no espera más: simplemente ya no bloquea el primer render.

### Móvil de verdad

- `playsInline` y `muted` en el `<video>`, y si el navegador rechaza el `play()` por política de autoplay —`await getUserMedia()` rompe la cadena del gesto del usuario— se pide un toque explícito en vez de dejar un rectángulo negro.
- Constraints de `getUserMedia` por perfil (`ideal`, no `exact`: con `exact` una cámara sin ese modo devuelve `OverconstrainedError` y nos quedamos sin cámara).
- El canvas del óvalo limita el `devicePixelRatio` según el perfil. En un teléfono con DPR 3 y pantalla de 412×915 el búfer sin límite son 3.4 M de píxeles repintados en cada frame; a 1.5× son 0.85 M y la viñeta se ve igual (es un relleno plano).
- Vertical y apaisado: la geometría del óvalo ya se limitaba por ancho *y* alto, y se verificó en las dos.
- **`getUserMedia` exige contexto seguro, y `http://` a una IP de la red local no lo es.** En un móvil de verdad `npm run dev:https` deja de ser opcional (ver *Cómo correrlo*). Si el contexto es inseguro, el mensaje de error lo dice con la orden que hay que correr.

### Degradación honesta

Si el equipo no da, la UI lo dice y ajusta expectativas en vez de congelarse fingiendo que funciona:

- Por debajo de 4 fps sostenidos, un aviso grave **con el número**: "Tu dispositivo va a 1.4 imágenes por segundo…".
- Backend `cpu`, o perfil `minimo`: aviso grave permanente.
- Perfil `bajo`, o un enrollo proyectado por encima de 12 s solo de extracción: aviso suave.
- Un bloque "Rendimiento" plegado muestra perfil, backend, fps, latencia por etapa y de dónde salieron los pesos, para poder depurar un móvil lento sin abrir un depurador.
- Si la detección revienta cinco frames seguidos —contexto WebGL perdido al rotar, memoria de GPU agotada— el bucle deja de reintentar y **lo dice**. Antes la promesa de `tick` se rechazaba, nadie la reprogramaba, y la pantalla se quedaba congelada con la última instrucción puesta.

### ¿Hay un piso de hardware?

Sí, y está en un sitio concreto: **un navegador sin WebGL *y* sin WASM+SIMD, en un equipo lento.** No es "sin GPU" a secas — el cálculo, con los números del perfil que a cada backend le toca:

| backend | cpu | perfil | frame de seguimiento | fps | una captura (det+lmk+descr) | 5 gestos |
| --- | --- | --- | --- | --- | --- | --- |
| webgl | 6× | `medio` (224/416) | 57 ms | 12.6 medidos | 40 + 9 + 24 ms | ~0.4 s |
| wasm | 6× | `bajo` (160/320) | 37 ms | 7.3 medidos | 148 + 31 + 99 ms | ~1.4 s |
| cpu | 1× | `minimo` (128/256) | 80 ms | ~4 (lo capa el presupuesto) | 318 + 139 + 469 ms | ~4.6 s |
| cpu | 4× | `minimo` | 331 ms | ~3.0 | 1 325 + 578 + 1 962 ms | ~19 s |
| **cpu** | **6×** | `minimo` | **454 ms** | **~2.2** | **1 967 + 861 + 2 927 ms = 5.8 s** | **~29 s** |

Las cuatro primeras filas son usables. La última no: **29 segundos de congelación pura** repartidos en cinco gestos —el anillo parado dos segundos y medio cada vez— más lo que el usuario tarde en girar la cabeza, con una vista previa a 2.2 fps que no permite corregir el encuadre. Es dudoso que alguien complete la secuencia, y si la completa, la calidad de los descriptores sale de un `inputSize` de 256 y sin augmentación.

Nótese que `cpu` a 1× **sí** es completable (~4.6 s de extracción en todo el enrollo), pero solo porque el techo lo mete en `minimo`: con el perfil `medio` el mismo equipo mediría 380 ms por frame de seguimiento y 1.4 s por captura. Ese techo es lo que separa "lento" de "roto", y por eso `cpu` no puede subir de `minimo` aunque la primera medición salga optimista.

Con WASM+SIMD a 6× —la mejor aproximación disponible a un Android de gama muy baja— la app se estabiliza en `bajo` a 5–7 fps con la augmentación en `off` y una captura completa en ~300 ms. Es lento, pero es usable, y la UI lo dice.

**Las dos salidas para el piso de `cpu` son bajar el listón de UX en ese perfil o mover la extracción al servidor.** Aquí se ha hecho lo primero (menos variantes, menos resolución, menos `inputSize`, aviso explícito). Lo segundo **no se ha implementado, y se recomienda no implementarlo**: mandar el frame al servidor rompe el punto 1 de este README —*la foto no viaja*— y convierte un vault de plantillas cifradas en un servidor que ve caras. La ganancia sería para la fracción de usuarios cuyo navegador no tiene ni WebGL ni WASM SIMD, que en 2026 es esencialmente un navegador con la aceleración deshabilitada a mano. Es un precio malísimo.

### Cómo medirlo

```bash
npm test          # unitarios: backend (81) + perfilado del frontend (41), sin navegador
npm run test:perf # extremo a extremo con Playwright y throttling de CPU por CDP
```

`npm run test:perf` levanta un servidor estático en un puerto efímero —no toca el 5173 ni el 8787—, alimenta la app con un `MediaStream` sintético (`canvas.captureStream` sobre un retrato auto-encuadrado) y mide a 1×, 4× y 6×. Playwright es una `devDependency` **solo de la raíz**: `npm test` corre sin él.

Lo que ese banco **no** puede medir, y conviene decirlo: el enrollo completo de punta a punta. El reto del parpadeo necesita un párpado que se cierre, y un retrato estático no lo tiene. Se mide la primera captura real (gesto "de frente" superado con extracción incluida) y de ahí se proyecta el resto.

## Tabla hash compartida cifrada

Por cada entrenamiento (enrollo) ocurre esto:

1. Se L2-normalizan 4–40 descriptores **por condición** y se calcula un **centroide por condición**.
2. Se generan **10 tablas LSH × 8 bits** (planos gaussianos con semilla fija). Se indexan todos los centroides **y cada muestra**: una pose —o una condición entera— que se aleja del centroide sigue teniendo cubeta propia.
3. Cada cubeta se guarda como `HMAC-SHA256(secreto, tabla || bits)`.
4. Centroides y muestras se cifran con AES-256-GCM y se escriben en `backend/data/vault.json`.
5. El índice global (`buckets`) apunta de cubeta → ids de identidad.

En el login:

1. El probe —o los probes, si el cliente manda varios— se hashea igual, pero se consulta con **multi-probe**: la cubeta exacta más todas las vecinas a distancia Hamming 1 (10 tablas × 9 cubetas = 90 lookups).
2. Se unen las cubetas (candidatos, no toda la galería).
3. Solo esos blobs se descifran.
4. Por cada **sub-cluster** se toma `max(coseno(probe, centroide), max coseno(probe, muestra_i))` sobre todos los probes.
5. Se elige al candidato con **mayor margen** (`score − umbral`), no con mayor score bruto: los umbrales son por persona **y por condición**.
6. Si el margen es positivo, se emite un JWT de 8 h.

Las plantillas escritas antes de los sub-clusters (sin `conditions`) se leen como una condición única llamada `default`. Un vault viejo sigue entrando sin migración manual.

**Por qué multi-probe.** Con hiperplanos aleatorios, `P(bit coincide) = 1 − arccos(s)/π`. Con 10×8 bits y consulta exacta, el recall de la identidad genuina se derrumba en cuanto el coseno baja. Medido con vectores sintéticos en `src/__tests__/lsh.test.ts`:

| coseno | recall consulta exacta | recall multi-probe |
| --- | --- | --- |
| 0.60 | 47 % | 97 % |
| 0.70 | 65 % | 98 % |
| 0.82 | 89 % | 100 % |
| **0.95** (el punto de operación real) | **99.5 %** | **100 %** |

Aquí también hay que corregir lo que decía antes este README: *“justo donde vive un login real”*. Un login real **no** vive a coseno 0.60 — el coseno genuino medido sobre LFW es 0.9494 de media, p05 0.9137— y a 0.95 la consulta exacta ya recupera el 99.5 %. El multi-probe sigue siendo lo correcto (cuesta 90 lookups en memoria y cubre la cola: a 0.82, que es el p01 genuino, la consulta exacta pierde 1 de cada 9 logins), pero no rescata del 47 %: eso era un régimen que no ocurre.

El fallback a barrido completo entra cuando el índice no devuelve a nadie **y también cuando el mejor candidato no llega a su umbral** — si solo se disparara con la lista vacía, bastaría una colisión de cubeta ajena para rechazar a un usuario legítimo sin haberlo comparado nunca. En galerías chicas es instantáneo; el camino feliz sigue siendo el índice.

El vault se cachea en memoria y se invalida en cada escritura: `identify` no relee ni reparsea `vault.json` por request. La escritura es atómica (`vault.json.tmp` + `rename`), y un vault ilegible aborta el arranque en vez de degradarse a un vault vacío que la siguiente alta persistiría encima.

## Cómo correrlo

```bash
npm install
npm run dev
```

- UI: http://localhost:5173
- API: http://localhost:8787

`predev` y `prebuild` copian los pesos de face-api y los `.wasm` de tfjs desde `node_modules` a `frontend/public/`; se puede forzar con `npm run sync:assets`. No están en git a propósito (7.8 MB de binarios que envejecerían mal y se desincronizarían del paquete).

### Desde un móvil de verdad

```bash
npm run dev:https   # genera certs si faltan y sirve por TLS
```

Y en el teléfono: `https://<ip-del-equipo>:5173`, aceptando el certificado autofirmado.

**Esto no es opcional.** `getUserMedia` exige contexto seguro, y `http://192.168.x.x:5173` no lo es: `http://localhost` está en la lista blanca del navegador, una IP de la red local no. Sin HTTPS el teléfono no da cámara y no hay forma de arreglarlo desde la app — solo de explicarlo, que es lo que hace el mensaje de error.

La primera ejecución escribe `FACELOGIN_MASTER_KEY`, `FACELOGIN_SESSION_SECRET` y `FACELOGIN_LSH_HMAC_KEY` en `.env` (no se commitea). **Si pierdes esa master key, el vault ya no se descifra**: el backend lo detecta al arrancar y falla con un mensaje explícito en vez de reventar en cada login.

Variables opcionales (ver `.env.example`):

- `FACELOGIN_ENROLL_TOKEN` — si se define, `/api/enroll` exige `Authorization: Bearer <token>`. Sin ella el enrolamiento queda abierto y el backend lo avisa por consola al arrancar.
- `FACELOGIN_ADMIN_TOKEN` — obligatorio para `DELETE /api/identities`. Sin él el borrado queda cerrado, aunque el enrolamiento esté abierto. No lo pongas en el frontend.

Tests:

```bash
npm test              # backend + frontend, sin navegador.
npm test -w backend
npm run test:perf     # extremo a extremo con Playwright y throttling de CPU (ver *Rendimiento multi-dispositivo*)
npm run eval:threshold  # calibración del umbral sobre caras reales (LFW)
```

`npm test` no descarga nada: el test de regresión de FPIR usa un fixture de descriptores reales ya commiteado (`backend/src/__tests__/fixtures/lfw-openset.json`).

`npm run eval:threshold` sí descarga LFW (~173 MB, verificado por SHA-256) a `.eval-data/`, que está en `.gitignore`. La primera ejecución tarda ~5 min extrayendo 13 233 descriptores con 6 procesos; a partir de ahí lee la caché y tarda segundos, con los mismos números. El informe se escribe en `scripts/eval/resultados/lfw.json`.

Flujo:

1. **Enrolar rostro** — nombre visible, la pregunta de los lentes y cinco gestos. Si usas lentes, la secuencia se repite dos veces: una con ellos y otra sin ellos.
2. **Entrar** — frente y parpadeo. Sin usuario ni password.
3. Si el score ≥ umbral, queda sesión.

### Contrato de la API

`POST /api/enroll` acepta las dos formas:

```jsonc
{ "displayName": "Ana", "shape": […64…], "samples": [[…128 floats…], …] }
{ "displayName": "Ana", "shape": […64…], "conditions": [
    { "label": "con-lentes", "samples": [[…], …] },
    { "label": "sin-lentes", "samples": [[…], …] }
], "device": { "id": "…", "publicKey": "…" } }
```

La malla `shape` es obligatoria en plantillas nuevas. `GET /api/identities` solo devuelve `{ count }`.

`POST /api/identify` también:

```jsonc
{ "descriptor":  [ …128 floats… ], "device": { "id": "…", "nonce": "…", "signature": "…" } }
{ "descriptors": [ [ … ], [ … ] ], "passkey": { "ticket": "…", "assertion": { } } }
```

Con varios descriptores el servidor se queda con el mejor y cobra `multiProbePenalty` por ello: el máximo de N intentos sube el score del impostor, y sin compensarlo mandar más descriptores bajaría el FRR a costa del FAR. Los coeficientes están medidos en `far.test.ts`, no elegidos a ojo.

## facelogin como proveedor de identidad (OIDC)

Otros servicios pueden delegar el login aquí. El flujo es **authorization code + PKCE (S256 obligatorio)** con firma **RS256**, y la guía completa está en [`docs/integracion-oidc.md`](docs/integracion-oidc.md).

| endpoint | qué hace |
| --- | --- |
| `GET /.well-known/openid-configuration` | descubrimiento |
| `GET /.well-known/jwks.json` | **solo** la clave pública, con `kid` para poder rotar |
| `GET /authorize` | valida los parámetros y manda al flujo facial; vuelve con `?code=…&state=…` |
| `POST /token` | canjea el código por `id_token` + `access_token` |
| `GET /userinfo` | claims del scope concedido, con el `access_token` como bearer |

**El servicio cliente nunca ve un descriptor, ni el vault, ni la master key.** Recibe un token firmado que dice quién es el usuario, y ya. La alternativa que se descartó —entregar a cada cliente la tabla hash cifrada, el nombre cifrado y la clave para descifrarlos— convierte una filtración en cualquiera de los N servicios en el descifrado de todas las plantillas de todos los usuarios. Una clave repartida entre N deja de ser una clave, y la biometría no se rota. Contradice además el punto 2 de la lista de arriba.

Decisiones que se toman una sola vez y no se pueden añadir después sin migrar a todos los clientes:

- **RS256, no HS256.** La sesión propia de la app sigue con HS256 porque el único que la verifica es este servidor. Con clientes externos, HS256 obligaría a repartir el secreto de firma: quien puede verificar también puede emitir. El par se genera en el primer arranque y se persiste en `.env`, con el mismo cuidado que la master key.
- **`sub` pairwise por cliente.** El `sub` sale de `HMAC(secreto, sector ‖ identidad)`: estable para un cliente entre sesiones, distinto en otro cliente. Dos servicios que crucen sus bases de usuarios no pueden deducir que su usuario A y su usuario B son la misma cara.
- **Allowlist exacta de `redirect_uri`.** Igualdad de cadena. Con prefijos, `https://app.com` dejaría pasar `https://app.com.attacker.net`.
- **Códigos de un solo uso y 60 s.** El segundo canje falla *y revoca* lo emitido en el primero: un código repetido significa que alguien más lo tenía.
- **PKCE también para clientes confidenciales.** Protege el tramo del navegador, que el `client_secret` no cubre.

El registro de clientes vive en configuración (`FACELOGIN_OIDC_CLIENTS` o `FACELOGIN_OIDC_CLIENTS_FILE`), **nunca** en el vault de rostros: son cosas con permisos, respaldos y ciclos de vida distintos. Ver `backend/config/clients.example.json`.

## Qué vendría después (evaluado, no implementado)

Las dos vías que más subirían el listón, con números y coste. **Ninguna se implementa en este pase**: se dejan medidas para poder decidir.

### 1. ArcFace / InsightFace en vez de FaceNet-128

El techo del sistema hoy es el descriptor, no el umbral. Medido sobre LFW con nuestro propio pipeline: **EER 3.49 %**, y para bajar el FAR 1:1 al 0.1 % hay que pagar un FRR del 8.86 %. InsightFace publica para `w600k_r50` (ArcFace, 512-d) exactitudes en LFW por encima del 99.8 %, es decir un EER en torno a un orden de magnitud menor. Con esa separación, el punto de operación dejaría de doler: hoy el precio de FPIR ≤ 0.1 % con galería de 100 es un TPIR del 88 %.

Tamaños **verificados** (bytes reales de los ONNX publicados por `immich-app` en Hugging Face, y de los artefactos de `onnxruntime-web@1.29.0` en jsDelivr):

| pieza | tamaño |
| --- | --- |
| modelos actuales del proyecto (reconocimiento + landmarks + detector) | **7.0 MB** |
| `buffalo_l` reconocimiento (`w600k_r50`, ResNet-50, 512-d) | 166.3 MiB |
| `buffalo_l` detección (`det_10g`, SCRFD) | 16.1 MiB |
| `buffalo_s` reconocimiento (`w600k_mbf`, MobileFaceNet, 512-d) | **13.0 MiB** |
| `buffalo_s` detección (`det_500m`, SCRFD) | **2.4 MiB** |
| `onnxruntime-web` runtime WASM+SIMD+threads | 13.3 MiB |
| `onnxruntime-web` runtime con WebGPU (jsep) | 26.5 MiB |

De ahí sale la primera conclusión, y es la que importa: **`buffalo_l` está descartado para este proyecto**. 166 MB de modelo son 24 veces el bundle de modelos actual, servidos desde el propio origen y verificados por SHA-256; con el piso de hardware documentado (un equipo sin WebGL ni SIMD ya tarda ~29 s en el enrollo) no hay conversación. El candidato realista es **`buffalo_s`**: 15.4 MiB de modelos + 13.3 MiB de runtime, unas 4 veces el peso actual de modelos, y con 512-d en MobileFaceNet en vez de 128-d.

Coste de migración, que no es pequeño:

- **Las plantillas del vault quedan inservibles.** Un descriptor de 512-d de ArcFace no es comparable con uno de 128-d de FaceNet, ni por coseno ni por nada: hay que **re-enrolar a todo el mundo**. No hay migración automática posible, porque el vault guarda vectores cifrados, no fotos — que es justo la propiedad que queremos conservar.
- **Toda la calibración se rehace.** La escala de coseno de ArcFace no tiene nada que ver con la de aquí (los descriptores de ArcFace sí son unitarios y las distribuciones genuina e impostora están mucho más separadas). Base, topes, coeficientes y `MIN_INTER_CONDITION_COSINE`: todo a medir de nuevo. La buena noticia es que **el banco ya está hecho**: `npm run eval:threshold` con LFW cacheado da los números en minutos, y el mismo informe permite comparar los dos modelos lado a lado antes de tocar producción.
- **Los planos LSH se reconstruyen** (128 → 512 dimensiones) y el índice entero se reescribe.
- **Los perfiles de rendimiento hay que remedirlos.** `onnxruntime-web` no comparte runtime con TFJS: durante la transición conviven los dos, o se migra también la detección y los landmarks. La latencia de MobileFaceNet en WASM en los perfiles `bajo`/`minimo` es la incógnita que decide si esto es viable, y es lo primero que habría que medir.

**Recomendación:** no migrar a ciegas. El paso siguiente barato es correr el banco con `buffalo_s` sobre el mismo LFW cacheado y comparar EER, FPIR/TPIR y latencia por perfil contra la tabla de este README. Con eso sobre la mesa la decisión se toma con datos; sin eso, se cambia un modelo por otro y se vuelve a calibrar a ojo, que es exactamente el error que provocó el incidente.

### 2. Anti-spoofing pasivo (Silent-Face / MiniFASNet)

Hoy el proyecto **no tiene ninguna defensa contra presentación**: una foto impresa o un vídeo en pantalla pasan el liveness activo (parpadeo + giro) si el vídeo los contiene. MiniFASNetV2 en ONNX pesa **1.66 MiB** (`garciafido/minifasnet-v2-anti-spoofing-onnx`, Apache-2.0, repaquetado de `minivision-ai/Silent-Face-Anti-Spoofing`), corre sobre el recorte de la cara que ya tenemos y no pide gestos al usuario.

Es, con diferencia, la mejor relación valor/coste de las dos vías: 1.66 MiB de modelo frente a 15.4 MiB, y cubre un hueco donde hoy hay un cero. Necesita el mismo `onnxruntime-web` (13.3 MiB) que la vía anterior, así que el coste real es del runtime, no del modelo; si se va a traer ORT para ArcFace, este sale casi gratis.

Con dos advertencias que hay que decir en voz alta:

- **Sigue siendo del lado cliente**, y este README ya explica en *Límites honestos* que el liveness del cliente no es un control de seguridad: el descriptor solo no abre sesión, pero un anti-spoofing en el navegador no sustituye la firma del aparato ni la passkey. Es una mejora de UX-seguridad, no un PAD.
- **No está certificado.** No es iBeta nivel 1/2, y no debería anunciarse como tal.

## Límites honestos

- **El liveness es exclusivamente del lado cliente y por eso no es una defensa de origen.** El parpadeo, el giro, la malla y las palabras dichas viven en el navegador. El servidor **no** abre sesión con un descriptor ni con un `transcript` inventado: hace falta la cara **y** una firma de la llave del aparato o una aserción WebAuthn verificada. Quien solo tenga 128 floats recibe `403 PASSKEY_REQUIRED`.
- **Como IdP, el `id_token` vale lo que valen la cara más el factor vinculante.** OIDC (PKCE, RS256, códigos de un solo uso, `sub` pairwise) protege el transporte. El origen ahora exige dispositivo de confianza o passkey; un portátil robado con la llave local sigue siendo un hueco. Por eso esto es un IdP interno o de demostración, no un proveedor público.
- El rate limit (8 identify/min, 3 enroll/min por IP, 30 token/min) y el 401 opaco —sin `score` ni `threshold` en el body— acotan el hill-climbing sobre el endpoint, no lo eliminan: una IP rotativa sigue teniendo intentos.
- Cámara 2D: una foto impresa o un vídeo engañan al liveness activo, y **no hay ninguna defensa contra presentación**. La opción barata evaluada (MiniFASNetV2 ONNX, 1.66 MiB) está en *Qué vendría después*; para producción de verdad hace falta PAD de nivel iBeta o profundidad.
- **FaceNet 128 no es el techo NIST 2024–2026**, y ahora está cuantificado: EER 3.49 % sobre LFW con nuestro propio pipeline. ArcFace 512 separa bastante mejor, pero `buffalo_l` pesa 166 MB y no cabe en el piso de hardware de este repo; el candidato realista es `buffalo_s`. Ver *Qué vendría después*.
- **Hay un piso de hardware.** Un navegador sin WebGL y sin WASM+SIMD, en un equipo lento, tarda ~29 s de congelación pura en completar el enrollo y muestra la cámara a 2.2 fps. La app lo detecta, lo dice y baja todo lo que puede bajar, pero no lo arregla: arreglarlo de verdad exigiría mandar el frame al servidor, y eso rompe el punto 1 de este README. Los números están en *¿Hay un piso de hardware?*.
- El vault vive en disco local. En un servicio real iría a KMS + store aislado, y el match 1:N se auditaría por demografía (sesgo).

Eso no cambia el contrato de este repo: **la cara abre la puerta, el aparato o la passkey la firman**, con plantillas cifradas y un umbral que se gana en el enrollo, no que se inventa a ojo.
