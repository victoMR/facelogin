# Estado actual de las funcionalidades de seguridad

**Fecha:** 2026-09-20

## Resumen ejecutivo

El sistema tiene implementado código de seguridad avanzado (honeypots, challenge-response, redacción de datos) que está **presente en el código pero NO activo por defecto**. El flujo básico enroll→identify funciona correctamente sin estas características adicionales.

## Funcionalidades de seguridad implementadas

### 1. Challenge-Response (DESACTIVADO por defecto)

**Estado:** Código implementado, NO activo
**Ubicación:** `backend/src/challenge.ts`, integrado en `backend/src/routes.ts`
**Activación:** Variable de entorno `FACELOGIN_REQUIRE_CHALLENGE=true`

**Qué hace:**
- El servidor emite challenges de un solo uso (60s TTL)
- El cliente debe enviar HMAC(challenge + descriptors) junto con el identify
- Previene replay de descriptores capturados

**Por qué NO está activo:**
- El frontend NO implementa el flujo de obtener challenge → calcular HMAC → enviar con identify
- Activar `FACELOGIN_REQUIRE_CHALLENGE=true` rompería el login porque el frontend no envía los campos necesarios
- Implementar esto en el navegador requeriría exponer `FACELOGIN_SESSION_SECRET` al cliente, lo cual es inseguro

**Para activarlo correctamente se necesitaría:**
1. Rediseño del esquema: el servidor firma el challenge con una clave pública/privada
2. Frontend obtiene challenge antes de identify
3. Frontend envía challenge + HMAC en el POST /api/identify
4. O bien, mover el matching al servidor sobre frames firmados

### 2. Honeypots y Canaries (PRESENTES, modo pasivo)

**Estado:** Código implementado, esperando inicialización
**Ubicación:** `backend/src/honeypot.ts`, `backend/src/init-honeypots.ts`
**Inicialización:** `npm run init:honeypots` (script pendiente de crear)

**Qué hace:**
- Honeypots: identidades trampa en el vault que disparan alarmas si son accedidas
- Canaries: tokens de enroll que detectan credenciales robadas
- Logging estructurado de eventos de seguridad sin exponer datos reales

**Estado actual:**
- El código está integrado en routes.ts
- `isHoneypot()` y `isCanaryToken()` funcionan
- Pero el vault NO contiene honeypots porque nunca se han inicializado
- Los checks están activos pero no encuentran nada (galería vacía de honeypots)

### 3. Redacción de datos sensibles (ACTIVO)

**Estado:** Código implementado y ACTIVO
**Ubicación:** `backend/src/redact.ts`, usado en `backend/src/routes.ts`

**Qué hace:**
- Respuestas de enroll no incluyen blobs cifrados (solo metadata)
- Respuestas de identify fallido son opacas (sin score/threshold)
- Logs no incluyen descriptores, vectores cifrados ni claves
- Errores sanitizados para no filtrar información del sistema

**Funcionando en:** Todas las respuestas de /api/enroll y /api/identify

## Flujo actual (FUNCIONAL)

### Enroll
1. Frontend captura 5 gestos (frente, parpadeo, giros)
2. Frontend extrae descriptores con face-api en el navegador
3. POST /api/enroll con `{ displayName, conditions: [{ label, samples }] }`
4. Backend calcula umbral adaptativo, cifra plantilla, indexa en LSH
5. Retorna metadata (ID, nombre, umbral, métricas) SIN datos cifrados

### Identify
1. Frontend captura frente + parpadeo
2. Frontend extrae descriptores (envía los 3 mejores por calidad)
3. POST /api/identify con `{ descriptors: [[...], [...], [...]] }`
4. Backend busca en índice LSH (multi-probe Hamming-1)
5. Descifra solo candidatos, calcula score vs umbral adaptativo
6. Si match: retorna JWT + identity + métricas
7. Si no match: retorna 401 opaco (sin decir qué tan cerca estuvo)

**Sin challenge:** El identify acepta descriptores desnudos, no requiere challenge previo

## Tests

- ✅ 135 tests unitarios pasan (backend + frontend)
- ✅ Tests de regresión enroll→identify confirman que funciona
- ✅ Tests de honeypots, challenge y redact cubren esos módulos
- ✅ Tests de FAR/FRR y FPIR con vectores sintéticos pasan
- ✅ CI configurado en GitHub Actions

## Recomendaciones

1. **Para producción interna/demo:** Estado actual es funcional y seguro dentro de sus límites documentados
2. **Para activar challenge-response:** Requiere rediseño frontend + esquema de firma diferente
3. **Para activar honeypots:** Ejecutar script de inicialización + configurar alertas SIEM
4. **Para producción pública:** Cerrar el bypass documentado en `README.md` (attestation o match en servidor)

## Documentos relacionados

- [`README.md`](../README.md) — Límites honestos, calibración de umbrales
- [`docs/norte.md`](./norte.md) — Roadmap de confianza
- [`docs/threat-model.md`](./threat-model.md) — Amenazas conocidas
- [`docs/aceptacion-humana.md`](./aceptacion-humana.md) — Checklist de UX
