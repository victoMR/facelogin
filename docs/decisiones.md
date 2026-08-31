# Decisiones de diseño y por qué

Este documento explica **por qué** facelogin está construido como está. No describe el código —
para eso está el `README.md` y los comentarios— sino las decisiones que se tomaron, qué se
descartó y con qué evidencia.

Muchas de estas decisiones nacieron de un fallo real. Están escritas con el error incluido,
porque el error es la parte útil.

---

## 1. El umbral: el fallo que lo cambió todo

### Qué pasaba

Una persona ajena al sistema hizo login y **entró como el titular de la cuenta**. No fue un caso
límite ni un parecido razonable.

Medido después contra 1500 desconocidos reales, con la forma exacta del vault de producción:

| calibración | umbral | desconocidos que entraban |
| --- | --- | --- |
| la que había | 0.577 | **1500 de 1500 (100 %)** |
| su techo máximo alcanzable | 0.720 | **1500 de 1500 (100 %)** |
| la actual | 0.958 | **1 de 1500 (0.07 %)** |

El desconocido que **menos** puntuaba sacaba 0.8519, muy por encima del umbral de 0.577. No es
que entrara gente parecida: entraba todo el mundo, y ninguna configuración alcanzable con las
constantes de entonces lo habría impedido.

### Por qué pasaba

Un error de aritmética que estaba en la documentación y se propagó al código.

El `README` afirmaba que la distancia euclidiana 0.6 de face-api "equivale a un coseno ≈ 0.82".
Esa conversión **solo vale para vectores unitarios**, y los descriptores de face-api no lo son:
su norma medida es **1.4318**. Con `d² = 2r²(1 − cos)`, el listón real de face-api es
**coseno 0.912**, no 0.82.

Sobre esa premisa falsa se eligió `BASE_COSINE_THRESHOLD = 0.52`, que en distancia euclidiana es
0.98 — más del doble de laxo que el listón estándar de 0.6.

Un detalle que importa: durante el diagnóstico se propuso anclar el umbral en 0.82, repitiendo el
error del README. **Habría dejado el sistema inseguro**, porque el impostor medio real puntúa
0.837. El fallo solo se vio al medir contra caras reales.

### La decisión

- `BASE_COSINE_THRESHOLD` = **0.93**, clamps **[0.92, 0.96]**.
- El punto de operación se elige por **FPIR**, no por EER. El EER (3.49 % en coseno 0.8954)
  equilibra falsos positivos y falsos negativos, pero en autenticación **no son igual de caros**:
  a un usuario rechazado le basta reintentar; un impostor aceptado es una cuenta comprometida.
  En ese punto de EER el FPIR 1:N era del 30 %.
- `MIN_INTER_CONDITION_COSINE` pasó de 0.45 a **0.92**. A 0.45 era una puerta trasera: dos
  personas distintas puntúan 0.837, así que se podía registrar a **otra persona** como la
  "segunda condición" de tu identidad.

### Regresión

`backend/src/__tests__/openset.test.ts` mide FPIR contra un fixture de descriptores LFW reales y
falla si sube del objetivo. Verificado: revertir la constante hace fallar el test.

---

## 2. Calibrar con caras reales, no con vectores sintéticos

**Este es el error de método que causó el fallo anterior.**

La calibración original se hizo generando vectores aleatorios con una similitud objetivo. Sobre
esos datos se midió un FAR del 27 % y se dio por aceptable, describiéndolo como un límite
inherente de FaceNet-128.

No lo era. Era el umbral. Pero en vectores inventados un FAR del 27 % no significa nada, porque la
distribución de "impostor sintético" no se parece a la distribución de caras reales.

**Con vectores sintéticos no se puede elegir un umbral.** Sirven para comparar dos montajes entre
sí, nunca para fijar un punto de operación.

La calibración actual usa **LFW** (13 233 imágenes, 10 641 con detección válida), con descriptores
extraídos por el mismo `@vladmandic/face-api` y el mismo recorte alineado que usa el navegador.
El banco es reproducible: `npm run eval:threshold` produce el mismo informe byte a byte.

**Límites de esos datos, que hay que tener presentes:** LFW son fotos de prensa, frontales y bien
iluminadas — más fáciles que una webcam real. Y tiene sesgo demográfico conocido (~77 % hombres,
~83 % piel clara), así que el FAR medido **no se extrapola a otra población**.

---

## 3. Lentes: sub-clusters, y no ensanchar la tolerancia

Quien usa lentes a veces necesita entrar con y sin ellos.

**Se descartó** sintetizar variantes del descriptor. Un vector de 128 dimensiones ya perdió la
información de si había lentes; generar copias sintéticas solo ensancha el cluster y sube el FAR.

**Se descartó** un centroide único que promediara ambas condiciones: el promedio entre "con
lentes" y "sin lentes" cae lejos de las dos.

**La decisión:** cada condición es un sub-cluster con su propio centroide, bajo la misma
identidad, y el match compara contra el más cercano.

Dos cosas que se aprendieron midiendo, y que contradicen la intuición original:

1. **La premisa del diseño era falsa.** Se asumió que los lentes mueven el descriptor a coseno
   0.60–0.65. Medido, dos condiciones de la misma persona están a **0.99**.
2. **El cluster único no fallaba en el match, fallaba en el alta.** El motor ya compara contra
   cada muestra guardada, y esas rescatan el score. Lo que fallaba era el gate de calidad: juntar
   las dos condiciones disparaba `intraStd` y el enrollo se rechazaba.

**Y la decisión que importa:** con el umbral bien calibrado, entrar en una condición **no
enrolada** deja de funcionar (p05 de 0.9413, por debajo del listón). Se decidió **no bajar el
umbral para salvar esa comodidad**. La seguridad manda: es preferible pedir un enrollo por
condición que dejar entrar a desconocidos.

Consecuencia práctica: **si usas lentes, tienes que enrolar ambas condiciones.**

---

## 4. El 401 de `/api/identify` es opaco a propósito

Originalmente, un login fallido devolvía `score`, `threshold` y `candidates`.

Eso es un **oráculo de hill-climbing**: un atacante manda un vector cualquiera, observa el score,
lo perturba, y converge iterativamente a un descriptor que pase el umbral — sin tener una cara ni
pasar por una cámara. Es un ataque de reconstrucción de plantilla, y devolver el score exacto lo
hace casi gratuito.

Ahora el 401 devuelve solo un mensaje genérico. Los números quedan en el log del servidor.

**Esta decisión tiene una consecuencia en la interfaz** que conviene entender: cuando un login
falla, la ayuda que se muestra al usuario ("acércate", "hay poca luz") **no puede venir de la
respuesta del servidor**. Sale de la calidad medida localmente en el navegador, que el cliente ya
tiene y que no revela nada del vault. Hay un test que recorre todas las combinaciones y verifica
que ese consejo nunca menciona score, umbral, similitud ni un decimal.

---

## 5. LSH: multi-probe, y por qué el índice rechazaba a usuarios legítimos

Con hiperplanos aleatorios, `P(bit coincide) = 1 − arccos(s)/π`. Con 10 tablas × 8 bits y consulta
exacta, el recall de la identidad genuina se derrumba justo donde vive un login real:

| coseno | recall consulta exacta | recall multi-probe |
| --- | --- | --- |
| 0.60 | 47 % | 97 % |
| 0.70 | 65 % | 98 % |
| 0.82 | 89 % | 100 % |

Un recall del 47 % significa que en más de la mitad de los logins legítimos la identidad correcta
**ni siquiera entraba en la lista de candidatos**.

Y era peor de lo que parece: el fallback a barrido completo solo se disparaba con la lista vacía.
Bastaba que otra identidad colisionara en una cubeta para que el usuario legítimo fuera rechazado
sin haber sido comparado nunca.

**La decisión:** indexar el centroide **y cada muestra**, consultar con multi-probe (cubeta exacta
más vecinas a Hamming 1), y disparar el fallback también cuando el mejor candidato no llega a su
umbral.

**Se descartó** bajar a 6 bits por tabla: con multi-probe aportaba ~0.4 puntos a costa de cubetas
más pobladas y más descifrados por request.

---

## 6. El vault: escritura atómica y fallo ruidoso

`load()` hacía `catch { return emptyVault() }`. Si el JSON se corrompía, se devolvía un vault
vacío **sin un solo error**, y el siguiente enrollo lo persistía encima: todas las identidades
perdidas, en silencio.

**La decisión:** distinguir "el archivo no existe" (legítimo, vault vacío) de "el archivo es
ilegible" (aborta el arranque con un mensaje explícito), y escribir de forma atómica
(`vault.json.tmp` + `rename`) para que un crash a media escritura no deje el archivo roto.

Principio general: **un fallo de integridad debe ser ruidoso**. Degradarse en silencio a un estado
vacío es peor que caerse.

---

## 7. OIDC: por qué los servicios cliente no reciben la clave

La propuesta inicial era entregar a cada servicio integrado la tabla hash cifrada, el nombre
cifrado y **la clave para descifrarlos**.

**Se descartó, y no debe reintentarse.** Tres razones:

1. **Una clave repartida entre N servicios deja de ser una clave.** Basta que uno filtre para que
   se descifren todas las plantillas de todos los usuarios. Y la biometría no se rota: quien queda
   comprometido lo está para siempre, en todos los servicios.
2. **Cada servicio haría su propio match.** Umbral, liveness y política de decisión en manos de
   terceros; uno que ponga el umbral mal abre un boquete en todos los demás, porque las identidades
   son las mismas.
3. **Contradice el punto 2 del propio README** ("un `vault.json` filtrado no entrega caras ni
   vectores en claro") y es exactamente el supuesto que persiguen GDPR art. 9, BIPA y la LFPDPPP.

**La decisión:** OIDC estándar con authorization code + PKCE. El servicio cliente recibe un
`id_token` firmado y la clave **pública** para verificarlo. Nunca ve un descriptor, ni el vault, ni
la master key.

Detalles que no son opcionales y por qué:

- **RS256, no HS256.** Con secreto simétrico habría que compartirlo con cada cliente: el mismo
  problema en pequeño.
- **PKCE obligatorio en S256**, también para clientes confidenciales. `plain` no aparece ni en el
  discovery.
- **`sub` pairwise por cliente**, derivado con HMAC de (identidad, client_id) y sal propia. Si dos
  servicios comparan sus bases de usuarios, no pueden deducir que su usuario A y su usuario B son
  la misma cara. Se hizo desde el principio porque añadirlo después obliga a migrar a todos los
  clientes.
- **Allowlist exacta de `redirect_uri`**, sin comodines ni prefijos, y `client_id` inválido **no
  redirige**: mostrar un error es preferible a convertirse en un redirector abierto.

---

## 8. Rendimiento: hay un piso, y no se cruza moviendo la cara al servidor

Medido con throttling de CPU y distintos backends de cómputo:

| backend | throttling | fps | enrollo de 5 gestos |
| --- | --- | --- | --- |
| WebGL | 6× | 12.6 | ~0.4 s |
| WASM+SIMD | 6× | 7.3 | ~1.4 s |
| CPU | 1× | ~4 | ~4.6 s |
| CPU | 6× | ~2.2 | **~29 s** |

Solo el último caso es inutilizable, y corresponde a un navegador sin WebGL **y** sin WASM+SIMD —
en la práctica, aceleración desactivada a mano.

**La decisión:** bajar el listón de UX en ese perfil (menos variantes, menos resolución, aviso
explícito) en vez de mover la extracción del descriptor al servidor. Lo segundo rompería *la foto
no viaja*, que es el punto 1 del README, a cambio de rescatar una fracción marginal de equipos.
Mal precio.

Un hallazgo metodológico que conviene recordar: **el throttling de CPU no simula un móvil barato,
simula un PC ocupado.** WebGL apenas se inmuta. El proxy útil para gama baja es forzar WASM o CPU.

---

## 9. Modelos servidos desde el propio origen

Venían de `cdn.jsdelivr.net` sin caché ni verificación. Tres problemas: en 3G eran ~35 segundos
antes del primer frame, sin conexión no arrancaba, y era **código de terceros ejecutándose en la
página que tiene acceso a la cámara**.

Ahora se sirven desde el propio origen con `CacheStorage` y verificación SHA-256 (una entrada
envenenada se descarta y se rebaja a red). Primer frame en 3G: **35 s → 2 s**.

---

## 10. La interfaz: el péndulo entre "no sé qué pasa" y "me abruma"

Merece registrarse porque las dos versiones intermedias parecían correctas al escribirlas.

1. El diseño original mostraba métricas técnicas (`score`, `umbral`, `latencia`) tras el login —
   datos que no significan nada para quien entra — y durante la captura decía cosas genéricas como
   "mete la cara en el óvalo" sin explicar qué fallaba.
2. Se añadió diagnóstico de calidad, medidores de luz y nitidez, contador, acuse de captura y
   consejos. Resolvió el "no sé qué está pasando" y creó el problema contrario: seis focos de
   atención simultáneos mientras la persona intenta girar la cabeza.
3. **La versión actual** toma el modelo del registro de Face ID: **el anillo es el feedback**.
   Tramos radiales que se encienden por gesto, color que indica estado, sin malla dibujada sobre la
   cara, y **una sola línea de texto**. El consejo de corrección *sustituye* a la instrucción en
   lugar de sumarse, y espera ~2 s a que el problema persista — quien se está colocando se corrige
   solo y no merece un titular.

**Lo que no se sacrificó:** la información sigue en el árbol de accesibilidad y se anuncia por
`aria-live` aunque no se pinte en primer plano. Simplificar la vista no es vaciar el DOM.

**Lo que sí se perdió, a sabiendas:** el diagnóstico elige una sola causa, la dominante. Si tienes
poca luz *pero* la cabeza más ladeada, gana "inclinado" y lo de la luz no se menciona. Si aparecen
enrollos que fallan por iluminación sin aviso, la corrección es promover luz y contraluz a la línea
única aunque no bloqueen.

---

## Lo que sigue abierto

Honestidad sobre el estado real, no lista de deseos.

### El liveness es solo del lado cliente, y por eso no es una defensa

`POST /api/identify` acepta 128 floats y nada más. El parpadeo, el giro de cabeza y los gates de
calidad viven en el navegador y no dejan ninguna huella que el servidor pueda verificar: **no hay
que engañarlos, se saltan con un `curl`**. Quien consiga un descriptor válido entra sin pasar por
una cámara.

Cerrarlo de verdad exige attestation del cliente —que en web no se puede hacer bien— o mover el
matching al servidor sobre un frame firmado por un cliente de confianza (app nativa, hardware
dedicado). Este repo no hace ninguna de las dos.

**Mientras eso siga así, esto sirve como IdP interno o de demostración, no como proveedor
público.** Todo el aparato OIDC protege el *transporte* de la identidad, no su *origen*.

### Otros pendientes

- **Anti-spoofing pasivo.** MiniFASNetV2 en ONNX pesa 1.66 MiB (Apache-2.0) y cubriría un hueco
  donde hoy hay un cero. Sigue siendo cliente: sube el listón contra una foto ante la webcam, no
  contra el `curl`.
- **Modelo de 512 dimensiones.** `buffalo_l` está descartado (166 MiB, 24× el bundle actual).
  `buffalo_s` es viable (13 MiB + 13 de runtime) pero obliga a re-enrolar a todos, recalibrar y
  reconstruir los planos LSH.
- **Sesgo.** Los umbrales de luz y contraluz de la interfaz están **razonados, no medidos** contra
  distintos tonos de piel y cámaras. Pueden equivocarse de forma sistemática con unas personas más
  que con otras. Combinado con el sesgo demográfico de LFW, un despliegue real necesita auditoría
  por demografía.
- **`client_secret` en claro** en la configuración OIDC (debería estar hasheado), revocación
  explícita (RFC 7009) y `end_session_endpoint`.

### Y la alternativa que hay que conocer

Para integración masiva, la respuesta estándar de la industria son **passkeys / WebAuthn**: la
biometría no sale del dispositivo y todos los navegadores lo soportan. Este proyecto tiene algo que
passkeys no da —identificación 1:N sin declarar antes quién eres— pero esa es la comparación
obligada antes de apostar por esta vía.
