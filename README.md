# facelogin

Autenticación **solo** por reconocimiento facial. No hay contraseña, correo ni segundo factor: el rostro es la credencial.

Cada enrollo genera una **tabla hash compartida y cifrada**. El navegador extrae un descriptor de 128 dimensiones; el servidor lo cifra con AES-256-GCM, lo indexa con LSH (planos aleatorios + HMAC) y, en el login, recupera candidatos en tiempo casi constante para decidir si eres tú.

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
4. **Hay prueba de vida** antes de enrolar o entrar (frente, parpadeo, giro).
5. **El umbral no es un número mágico único.** Se calcula por persona y por tamaño de galería.

## Fiabilidad y umbral

Un sistema facial no “reconoce o no”: compara una similitud (coseno, tras L2-normalizar) contra un **umbral operativo**. Ese umbral equilibra:

- **FAR** — aceptar a otra persona (grave en auth)
- **FRR** — rechazarte a ti (molesto, pero recuperable reintentando)

En vectores unitarios, la distancia euclidiana 0.6 de face-api equivale a un coseno ≈ 0.82. Eso es un listón alto para 1:1 con buena luz. En **identificación 1:N** el FAR crece con N: si cada comparación tiene FAR 0.001 y hay 1 000 identidades, esperas ~1 falso positivo. Por eso el umbral **sube** cuando la galería crece.

```
umbral = 0.52
       + offset_calidad(0–0.07)      // cluster de enrollo más apretado → más estricto
       + offset_compactación(0–0.04) // intraMean alto
       + margen_1N(0–0.08)           // log10(N)
       acotado a [0.48, 0.72]
```

Durante el enrollo se miden `intraMean` e `intraStd` entre las 5 capturas de la misma persona. Si la coherencia baja de 0.62 o la dispersión pasa de 0.14, se rechaza el alta: no hay “reconocimiento de verdad” si las muestras no forman un cluster.

Esto no sustituye un sensor 3D ni un modelo ArcFace 512. Evita, eso sí, el fallo clásico de “cualquier cara parecida entra” al exigir:

- calidad de caja y score de detección en el cliente
- liveness de gesto
- umbral adaptativo en el servidor
- máximo entre centroide y cada muestra cifrada (no un único promedio flojo)

## Tabla hash compartida cifrada

Por cada entrenamiento (enrollo) ocurre esto:

1. Se L2-normalizan 4–10 descriptores y se calcula el **centroide**.
2. Se generan **10 tablas LSH × 8 bits** (planos gaussianos con semilla fija).
3. Cada cubeta se guarda como `HMAC-SHA256(secreto, tabla || bits)`.
4. Centroide y muestras se cifran con AES-256-GCM y se escriben en `backend/data/vault.json`.
5. El índice global (`buckets`) apunta de cubeta → ids de identidad.

En el login:

1. El probe se hashea igual.
2. Se unen las cubetas (candidatos, no toda la galería).
3. Solo esos blobs se descifran.
4. Se toma `max(coseno(probe, centroide), max coseno(probe, muestra_i))`.
5. Si supera el umbral adaptativo, se emite un JWT de 8 h.

Si LSH no devuelve nadie (luz rara, pose extrema), hay un fallback a barrido completo. En galerías chicas es instantáneo; el camino feliz sigue siendo el índice.

## Cómo correrlo

```bash
npm install
npm run dev
```

- UI: http://localhost:5173
- API: http://localhost:8787

La primera ejecución escribe `FACELOGIN_MASTER_KEY` y `FACELOGIN_SESSION_SECRET` en `.env` (no se commitea).

Flujo:

1. **Enrolar rostro** — nombre visible + cinco gestos.
2. **Entrar** — frente y parpadeo. Sin usuario ni password.
3. Si el score ≥ umbral, queda sesión.

## Límites honestos

- Cámara 2D: una foto impresa o un video puede engañar liveness básico. Para producción hace falta PAD de nivel iBeta o profundidad.
- FaceNet 128 en WASM no es el techo NIST 2024–2026. ArcFace/buffalo_l 512 sube separación entre identidades.
- El vault vive en disco local. En un servicio real iría a KMS + store aislado, y el match 1:N se auditaría por demografía (sesgo).

Eso no cambia el contrato de este repo: **una sola puerta, la cara**, con plantillas cifradas y un umbral que se gana en el enrollo, no que se inventa a ojo.
