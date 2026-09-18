# Threat model v0 — facelogin

> Documento vivo. La seguridad es el producto. Si algo aquí queda viejo, es un bug.

**Alcance:** monorepo actual (`backend` + `frontend`), modo face-only, vault local cifrado, IdP OIDC (PKCE).
**Clasificación de riesgo:** C = confidencialidad, I = integridad, D = disponibilidad, A = autenticación (suplantación).
**Nivel de confianza actual:** demo / IdP interno. **No** listo para dinero, datos de terceros ni perimeter “banco/Pentágono” hasta cerrar T1.

---

## 1. Activos

| Activo | Qué es | Impacto si se pierde |
| --- | --- | --- |
| Plantilla facial cifrada | Embeddings 128-d AES-256-GCM en vault | Reidentificación / replay si hay clave |
| `FACELOGIN_MASTER_KEY` | Llave del vault | Descifrado masivo de plantillas |
| Session / OIDC tokens | Prueba de identidad | Secuestro de sesión / IdP |
| Descriptor en tránsito | Vector float en `POST /api/identify` y `/enroll` | Oráculo de matching / enrolamiento fraudulento |
| LSH buckets (HMAC) | Índice de candidatos | Menor: no reconstruye embedding, filtra búsqueda |
| Cámara / frames en cliente | Solo en memoria del navegador | Privacidad UX; no deben persistir ni salir |

**No-activo (por diseño):** JPEG/PNG de cara. Si aparecen en disco, logs o red → incidente.

---

## 2. Superficie de ataque

```
[Webcam] → [Browser: face-api + liveness UX] → HTTPS → [API Express]
                                                      ├─ /api/enroll
                                                      ├─ /api/identify  ← crítico
                                                      ├─ /api/me
                                                      └─ OIDC (/authorize, /token, …)
                                                      └─ vault.json + secrets env
```

- **Cliente no es TCB.** Cualquier chequeo solo-en-browser (parpadeo, yaw) es UX, no control.
- **Servidor confía hoy en vectores.** Quien tenga un descriptor válido (o lo fabrique) puede pegarle a `/identify` sin cámara.

---

## 3. Amenazas (STRIDE resumido)

| ID | Amenaza | STRIDE | Severidad hoy | Mitigación actual | Estado |
| --- | --- | --- | --- | --- | --- |
| **T1** | Bypass de liveness: `curl` / cliente instrumentado manda descriptores | Spoofing | **Crítica** | Ninguna verificable en server | **Abierto — bloquea “nivel banco”** |
| **T2** | Presentación (foto/video/máscara) ante webcam real | Spoofing | Alta | Liveness 2D activo en cliente | Parcial (evitable) |
| **T3** | Impostor 1:N (cara parecida / umbral flojo) | Spoofing | Alta→Media | Umbral calibrado LFW, FPIR target, tests openset | Mitigado medido; re-eval continua |
| **T4** | Oráculo de score en identify fallido | Info disclosure | Media | Body opaco en 401; score solo en éxito / logs server | Mitigado en API pública |
| **T5** | Enrolamiento abierto sin `FACELOGIN_ENROLL_TOKEN` | Elevation | Alta en prod | Token opcional; demo lo deja vacío | Config: **obligatorio en prod** |
| **T6** | Robo de `vault.json` sin master key | Confidentiality | Baja | AES-256-GCM at rest | OK si la key no viaja con el vault |
| **T7** | Robo de vault **+** master key | Confidentiality | Crítica | Separación ops; (futuro) HSM/KMS + rotación | Runbook + rotación pendientes |
| **T8** | Brute / spray identify | DoS + auth | Media | Rate limit por IP (in-memory) | Mejorar: Redis, captcha, backoff, ban |
| **T9** | Replay de descriptor capturado | Spoofing | Alta | No hay nonce/challenge ligado al frame | Cubierto por T1 (attestation) |
| **T10** | OIDC: redirect_uri / PKCE / client mal configurado | Spoofing | Alta | Allowlist exacta, PKCE S256, tests | Mantener; no relajar |
| **T11** | Trust proxy mal puesto → bypass rate limit | Elevation | Alta | Off por default | Documentado; no activar sin proxy real |
| **T12** | Logs con score/threshold ayudan a tuning ofensivo | Info disclosure | Baja | Solo server-side | Redactar en prod o sampling |
| **T13** | Supply chain (face-api, tfjs, deps) | Tampering | Media | Lockfile, digests de modelos | Pin + verify digests en CI |
| **T14** | Insider con acceso a env de prod | Insider | Crítica | Least privilege (futuro) | Honeypots/canaries (T15) |
| **T15** | Atacante cree que “sacó” el vault | — | — | Aún no | **Honeypot templates + canary tokens** |

---

## 4. Controles que YA cuentan (no vender de más)

1. Descriptor en cliente; foto no se persiste ni se sube (promesa de producto cumplida).
2. Plantillas cifradas AES-256-GCM; LSH con HMAC (índice no invertible a embedding).
3. Umbral 1:N calibrado con caras reales (LFW), no sintéticos; tests de openset.
4. Identify fallido opaco (anti-oráculo).
5. OIDC authorization code + PKCE S256 + RS256.
6. Rate limits básicos en enroll/identify.

## 5. Controles que FALTAN para el norte (“infernal para ellos”)

Orden de prioridad del pilar técnico:

1. **Cerrar T1/T9** — attestation o frame firmado / match en entorno que el server pueda verificar. Sin esto no hay pitch bancario.
2. **T15** — honeypot identities + canary paths en API; alerta y quemado de credenciales/session si se tocan.
3. **T7** — KMS/HSM, rotación de `MASTER_KEY`, runbook de incidente.
4. **Publicar** FAR/FPIR medidos y este threat model en el repo abierto.
5. **T8** — rate limit distribuido + detección de abuso.

---

## 6. Supuestos y fuera de alcance (v0)

- El navegador del usuario puede estar comprometido (malware) → fuera hasta attestation fuerte de dispositivo.
- No hay TEE/Secure Enclave en el servidor de demo.
- LFW ≠ webcam real ni todas las demografías; métricas son piso, no techo de seguridad.
- Passkeys/WebAuthn siguen siendo el estándar “cara no sale del device”; facelogin compite en UX IdP + open source, no niega ese hecho.

---

## 7. Criterio de “listo para productos reales”

- [ ] T1 cerrado con diseño revisado (attestation verificable).
- [ ] Threat model v1 + advisory process (`SECURITY.md`).
- [ ] Honeypots/canaries en staging con alerta.
- [ ] Eval FAR/FPIR publicado y reproducible (`npm run eval:threshold`).
- [ ] Rotación de llaves ensayada una vez en staging.
- [ ] Enroll token obligatorio; trust proxy auditado.

Hasta entonces: **demo / IdP interno**. Ambición intacta; honestidad también.

---

## 8. Issues propuestas (títulos)

1. Threat model v0 (este doc) — mantener
2. Cerrar bypass de `/api/identify` (attestation)
3. Honeypots + canaries en vault/API
4. Publicar eval FAR/FPIR
5. Rotación de llaves + runbook de incidente

