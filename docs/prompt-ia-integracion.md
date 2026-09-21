# Prompt para IA: Integrar facelogin como proveedor de autenticación

Copia este prompt completo y envíalo a tu agente de IA (Claude, GPT-4, etc.) para que implemente la integración de facelogin en tu aplicación.

---

## Contexto

Necesito integrar **facelogin** como proveedor de autenticación alternativo en mi aplicación. facelogin es un IdP (proveedor de identidad) OpenID Connect que usa reconocimiento facial para autenticación sin contraseña.

**URL del servidor facelogin:** https://facelogin.theclubsuperbroker.com

**Credenciales de mi aplicación:**
- `client_id`: [TU_CLIENT_ID]
- `client_secret`: [TU_CLIENT_SECRET] (si es cliente confidencial)
- `redirect_uri`: [TU_REDIRECT_URI]
- Scopes: `openid profile`

## Especificación técnica de facelogin

### Endpoints OIDC

```
Discovery:       https://facelogin.theclubsuperbroker.com/.well-known/openid-configuration
JWKS:            https://facelogin.theclubsuperbroker.com/.well-known/jwks.json
Authorization:   https://facelogin.theclubsuperbroker.com/authorize
Token:           https://facelogin.theclubsuperbroker.com/token
UserInfo:        https://facelogin.theclubsuperbroker.com/userinfo
```

### Configuración del flujo

- **Grant type:** `authorization_code` (único soportado)
- **Response type:** `code` (único soportado)
- **PKCE:** **Obligatorio**, método `S256` (único soportado, `plain` se rechaza)
- **Firma de tokens:** RS256 (único soportado)
- **Subject type:** `pairwise` (el `sub` es distinto para cada cliente)
- **Autenticación de cliente:**
  - Confidencial: `client_secret_basic` (Authorization header) o `client_secret_post` (en body)
  - Público: `none` (solo PKCE, sin secret)

### Parámetros de `/authorize`

**Obligatorios:**
- `client_id`: Mi identificador
- `redirect_uri`: Exactamente una de mi allowlist
- `response_type`: `code`
- `scope`: Debe incluir `openid`; opcionalmente `profile`
- `state`: Token anti-CSRF (generado por mí, verifico que vuelva igual)
- `nonce`: Token anti-replay (generado por mí, debe aparecer en el `id_token`)
- `code_challenge`: `base64url(SHA256(code_verifier))`
- `code_challenge_method`: `S256`

**Opcionales:**
- `max_age`: Segundos de frescura máxima (servidor acota a 300s)
- `prompt`: `login` fuerza re-auth, `none` siempre da `login_required`

### Claims del `id_token`

```json
{
  "iss": "https://facelogin.theclubsuperbroker.com",
  "sub": "zevZFyu4sCB5vhH_P8YugGdG5ZW3rCa9j3yI6XZTi8o",
  "aud": "mi-client-id",
  "exp": 1788075747,
  "iat": 1788075447,
  "auth_time": 1788075432,
  "nonce": "mi-nonce",
  "amr": ["face", "hwk"],
  "name": "Ana García"
}
```

- `sub`: Identidad única (pairwise, estable para mi cliente, distinto en otros)
- `name`: Solo si pedí scope `profile`
- `auth_time`: Cuándo se verificó la cara realmente
- `amr`: `["face", "hwk"]` (dispositivo) o `["face", "passkey"]` (WebAuthn)

### Características de seguridad

- **Códigos de autorización:** 60 segundos TTL, un solo uso (segundo intento revoca tokens emitidos)
- **PKCE obligatorio:** Protege cliente público y confidencial
- **Nonce obligatorio:** Anti-replay en `id_token`
- **State recomendado:** Anti-CSRF
- **Firma RS256:** Verificar contra JWKS, con `issuer`, `audience` y `algorithms: ['RS256']` fijos

### Rate limits

- `/authorize`: 30 req/min por IP
- `/token`: 30 req/min por IP
- `/api/oidc/approve`: 15 req/min por IP (interno de facelogin, no llamar desde tu app)

### Errores comunes

| Error | Endpoint | Causa |
|-------|----------|-------|
| `invalid_client` | `/token` | `client_id` o `client_secret` incorrecto |
| `invalid_grant` | `/token` | Código expirado, ya usado, o `code_verifier` malo |
| `invalid_request` | Cualquiera | Falta parámetro obligatorio o formato malo |
| `access_denied` | `/authorize` callback | Usuario canceló o no se verificó |
| `temporarily_unavailable` | Cualquiera | Rate limit excedido |

## Requisitos de la implementación

### 1. Añadir botón "Continuar con tu cara"

En mi página de login, añade un botón que inicie el flujo OIDC. NO elimines los métodos de login existentes (email/password, Google, etc.).

### 2. Ruta de inicio de flujo

Crea una ruta (ej: `/auth/facelogin/start` o `/auth/facelogin`) que:

1. **Genere PKCE:**
   - `code_verifier`: 32 bytes aleatorios en base64url (43-128 caracteres)
   - `code_challenge`: `base64url(SHA256(code_verifier))`

2. **Genere state y nonce:**
   - `state`: Token aleatorio (16+ bytes) anti-CSRF
   - `nonce`: Token aleatorio (16+ bytes) anti-replay

3. **Guarde en sesión de servidor:**
   - `codeVerifier`, `state`, `nonce`
   - NO uses localStorage ni cookies accesibles desde JavaScript

4. **Construya URL de autorización:**
   ```
   https://facelogin.theclubsuperbroker.com/authorize?
     client_id=[MI_CLIENT_ID]
     &redirect_uri=[MI_REDIRECT_URI]
     &response_type=code
     &scope=openid+profile
     &state=[GENERADO]
     &nonce=[GENERADO]
     &code_challenge=[GENERADO]
     &code_challenge_method=S256
   ```

5. **Redirija al usuario** a esa URL

### 3. Ruta de callback

Crea la ruta de callback (la que pusiste en `redirect_uri`) que:

1. **Verifique state:**
   ```javascript
   if (query.state !== session.state) {
     throw new Error('CSRF: state no coincide');
   }
   ```

2. **Maneje errores:**
   ```javascript
   if (query.error) {
     // Mostrar error al usuario
     // Errores comunes: access_denied, invalid_request
   }
   ```

3. **Canjee código por tokens:**
   ```javascript
   const response = await fetch('https://facelogin.theclubsuperbroker.com/token', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/x-www-form-urlencoded',
       // Cliente confidencial:
       'Authorization': `Basic ${base64(client_id + ':' + client_secret)}`
     },
     body: new URLSearchParams({
       grant_type: 'authorization_code',
       code: query.code,
       redirect_uri: MI_REDIRECT_URI,  // Exactamente la misma
       code_verifier: session.codeVerifier
       // Cliente público: añadir client_id en el body
     })
   });
   const tokens = await response.json();
   // { access_token, token_type: "Bearer", expires_in, id_token, scope }
   ```

4. **Verifique `id_token`:**
   
   **CRÍTICO:** NO confíes en el token sin verificarlo.

   Usa una biblioteca JOSE/JWT:
   ```javascript
   // Con jose (Node.js):
   import { createRemoteJWKSet, jwtVerify } from 'jose';

   const jwks = createRemoteJWKSet(
     new URL('https://facelogin.theclubsuperbroker.com/.well-known/jwks.json')
   );

   const { payload } = await jwtVerify(tokens.id_token, jwks, {
     issuer: 'https://facelogin.theclubsuperbroker.com',
     audience: MI_CLIENT_ID,
     algorithms: ['RS256']  // Fija el algoritmo
   });
   ```

   **¿Por qué fijar `algorithms`?** Sin ello, un token con `alg: "none"` podría colarse.

5. **Verifique nonce:**
   ```javascript
   if (payload.nonce !== session.nonce) {
     throw new Error('Nonce no coincide: posible replay');
   }
   ```

6. **Extraiga identidad:**
   ```javascript
   const { sub, name } = payload;
   // sub es la clave primaria del usuario en mi sistema
   ```

7. **Busque o cree usuario:**
   ```javascript
   let user = await db.findByFaceloginSub(sub);
   if (!user) {
     // Primera vez: crear usuario
     user = await db.createUser({
       facelogin_sub: sub,
       name: name
     });
   }
   ```

8. **Abra sesión:**
   ```javascript
   session.userId = user.id;
   ```

9. **Redirija** a dashboard/home

### 4. Schema de base de datos

Añade columna a la tabla de usuarios:

```sql
ALTER TABLE users ADD COLUMN facelogin_sub VARCHAR(255) UNIQUE;
CREATE INDEX idx_facelogin_sub ON users(facelogin_sub);
```

### 5. Variables de entorno

Añade a `.env`:

```bash
FACELOGIN_ISSUER=https://facelogin.theclubsuperbroker.com
FACELOGIN_CLIENT_ID=[MI_CLIENT_ID]
FACELOGIN_CLIENT_SECRET=[MI_CLIENT_SECRET]  # Si cliente confidencial
FACELOGIN_REDIRECT_URI=[MI_REDIRECT_URI]
```

NO commitees el `.env` al repositorio.

## Criterios de aceptación

### ✅ Funcionalidad

- [ ] El botón "Continuar con tu cara" aparece en la página de login
- [ ] Al hacer clic, el usuario es redirigido a facelogin
- [ ] Después de verificar su cara en facelogin, vuelve a mi app
- [ ] Si es la primera vez, se crea un usuario nuevo
- [ ] Si ya existía, se abre sesión
- [ ] El usuario accede a su dashboard/home
- [ ] Si el usuario cancela en facelogin, vuelve con error y la app lo maneja correctamente

### ✅ Seguridad

- [ ] El `state` se verifica (protección CSRF)
- [ ] El `nonce` se verifica (anti-replay)
- [ ] El `id_token` se verifica contra JWKS con `issuer`, `audience` y `algorithms: ['RS256']` fijos
- [ ] El `client_secret` NO está en el frontend ni en el repo
- [ ] `codeVerifier`, `state`, `nonce` viven en sesión de servidor (no localStorage/sessionStorage)
- [ ] La `redirect_uri` usada es exactamente la registrada
- [ ] El `sub` se usa como clave primaria del usuario (no `name` ni otro claim)

### ✅ Manejo de errores

- [ ] Si facelogin devuelve `error=access_denied`, se muestra mensaje al usuario
- [ ] Si el canje de token falla (`invalid_grant`), se muestra error
- [ ] Si la verificación del `id_token` falla, se rechaza el login
- [ ] Si `state` no coincide, se rechaza (no se continúa con el flujo)
- [ ] Si `nonce` no coincide, se rechaza

### ✅ Código limpio

- [ ] El código usa biblioteca OIDC/JOSE recomendada (no implementación manual de JWT)
- [ ] Los secretos vienen de variables de entorno
- [ ] Hay comentarios explicando los pasos críticos (verificación de state, nonce, firma)
- [ ] Las rutas están organizadas lógicamente (`/auth/facelogin/start`, `/auth/facelogin/callback`)

## Bibliotecas recomendadas por lenguaje/framework

### Node.js / Express / Next.js
- **`jose`** para JWT/JWKS (recomendada por facelogin)
- Alternativa: **`openid-client`** (cliente OIDC completo)

### Python / Django / Flask
- **`python-jose`** para JWT
- **`requests`** para HTTP
- Alternativa: **`authlib`** (cliente OIDC completo)

### PHP / Laravel
- **`firebase/php-jwt`** para JWT
- **`guzzlehttp/guzzle`** para HTTP

### Ruby / Rails
- **`json-jwt`** para verificar tokens
- **`oauth2`** gem para flujo OAuth

### Java / Spring Boot
- **Spring Security OAuth2 Client** (soporte OIDC integrado)

## Notas adicionales

### ⚠️ Restricciones de facelogin

1. **El usuario debe estar enrolado** en facelogin antes de poder autenticarse
   - Si el enroll requiere token de invitación, coordina con el operador
   - Tu app puede detectar `error=access_denied` y sugerir enrolarse

2. **Passkey/dispositivo requerido:**
   - El descriptor facial solo no abre sesión
   - Se requiere firma de dispositivo o passkey WebAuthn
   - Es una protección adicional de facelogin

3. **Rate limits:**
   - No hagas reintentos agresivos
   - Si recibes `temporarily_unavailable`, espera antes de reintentar

### 🔒 Recordatorios de seguridad

- El `sub` es **pairwise**: distinto para cada cliente, estable para el mismo cliente
- NO asumas que `sub=X` en tu app es el mismo `sub=X` en otra app
- Si el operador de facelogin cambia su secreto pairwise, todos los `sub` cambian
- El `access_token` expira en 900s (15 min), el `id_token` en 300s (5 min)
- Los códigos de autorización viven 60s y son de un solo uso

### 📚 Recursos

- **Doc completa:** `docs/integrar-con-tu-app.md` en el repo facelogin
- **Doc técnica:** `docs/integracion-oidc.md` en el repo facelogin
- **Ejemplo mínimo:** En `docs/integracion-oidc.md` líneas 196-284 (cliente Node.js completo)

## Ejemplo de salida esperada

Después de la implementación, el flujo debería verse así:

1. **Usuario en login:**
   - Ve botón "Continuar con tu cara"
   - Hace clic

2. **Redirección:**
   - URL: `https://facelogin.theclubsuperbroker.com/authorize?client_id=...&redirect_uri=...&...`

3. **Usuario en facelogin:**
   - Ve: "Mi Aplicación quiere acceder a tu identidad"
   - Verifica su cara (parpadeo, giro)
   - Completa verificación

4. **Redirección de vuelta:**
   - URL: `https://miapp.com/auth/facelogin/callback?code=abc123&state=xyz`

5. **Backend de mi app:**
   - Verifica state ✓
   - Canjea código por tokens ✓
   - Verifica `id_token` ✓
   - Verifica nonce ✓
   - Extrae `sub` y `name`
   - Busca/crea usuario
   - Abre sesión

6. **Usuario en mi app:**
   - Sesión abierta
   - Redirigido a dashboard

---

## Instrucciones para el agente de IA

Por favor implementa esta integración siguiendo EXACTAMENTE las especificaciones de arriba. Presta especial atención a:

1. **Generación de PKCE correcta** (SHA-256 del verifier en base64url)
2. **Verificación de firma del `id_token`** contra JWKS con parámetros fijos
3. **Verificación de `state` y `nonce`** (no omitir)
4. **Uso de `sub` como clave primaria** del usuario
5. **Protección del `client_secret`** (backend only, no frontend)

Genera:
- Código de rutas de inicio y callback
- Código de verificación de JWT
- Migraciones de base de datos
- Variables de entorno de ejemplo
- Comentarios explicando cada paso crítico

No implementes tu propia lógica de JWT desde cero: usa las bibliotecas recomendadas.
