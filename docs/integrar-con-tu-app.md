# Integrar facelogin en tu aplicación

facelogin puede actuar como **proveedor de autenticación alternativo** ("Continuar con tu cara") junto a tu sistema de login existente. Tu aplicación delega la verificación facial y recibe un token firmado con la identidad del usuario.

## Qué es y qué no es facelogin

### ✅ Lo que facelogin SÍ hace

- **Autenticación biométrica sin contraseña** basada en reconocimiento facial
- **Proveedor de identidad OIDC** (OpenID Connect) con flujo authorization code + PKCE
- Verificación facial con liveness activo (parpadeo, giro)
- Plantillas faciales cifradas (AES-256-GCM) que nunca salen del servidor facelogin
- Emisión de tokens JWT firmados (RS256) con identidad del usuario
- Multi-condición: soporte para usuarios con/sin lentes

### ❌ Lo que facelogin NO es

- **No es Face ID de Apple ni Touch ID**: no usa hardware biométrico del dispositivo (TrueDepth, TEE)
- **No es eKYC bancario**: el liveness corre en el cliente, no hay certificación iBeta
- **No reemplaza autenticación de dos factores**: es un factor de autenticación, no múltiples factores
- **No es para producción crítica sin restricciones**: lee "Límites de seguridad" abajo

## Arquitectura del flujo

```
┌─────────────────┐
│   Tu App Web    │
│  (frontend)     │
└────────┬────────┘
         │ 1. Usuario hace clic "Continuar con tu cara"
         │
         v
┌─────────────────────────────────────────────────────────────┐
│ 2. Tu app redirige a:                                       │
│    https://facelogin.example/authorize?                     │
│      client_id=tu-app                                       │
│      &redirect_uri=https://tuapp.com/callback               │
│      &response_type=code                                    │
│      &scope=openid+profile                                  │
│      &state=xyz                                             │
│      &nonce=abc                                             │
│      &code_challenge=HASH_DEL_VERIFIER                      │
│      &code_challenge_method=S256                            │
└─────────────────────────────────────────────────────────────┘
         │
         v
┌────────────────────────────────┐
│   facelogin frontend           │
│   (interfaz facial)            │
│                                │
│   3. Usuario verifica su cara  │
│      - Parpadeo                │
│      - Giro de cabeza          │
│      - Liveness activo         │
│      - + firma de dispositivo  │
│        o passkey WebAuthn      │
└───────────┬────────────────────┘
            │
            v
┌───────────────────────────────────────────────────────────┐
│ 4. facelogin redirige de vuelta:                          │
│    https://tuapp.com/callback?code=CODIGO&state=xyz       │
└───────────────────────────────────────────────────────────┘
            │
            v
┌────────────────┐
│  Tu backend    │──────> 5. Canjea código por tokens
│                │        POST https://facelogin.example/token
│                │          code=CODIGO
│                │          code_verifier=VERIFIER_ORIGINAL
│                │          client_secret=... (si confidencial)
│                │
│                │<─────  { id_token: "eyJ...", access_token: "..." }
│                │
│                │        6. Verifica id_token (firma RS256 + JWKS)
│                │        7. Lee sub (identidad) y name del token
│                │        8. Asocia sub con usuario local
│                │        9. Abre sesión en tu app
└────────────────┘
```

## Límites de seguridad

**Antes de integrar**, entiende las restricciones del sistema:

### 🔴 Liveness del lado cliente

El liveness (parpadeo, giro) corre en JavaScript en el navegador. **No es una defensa de origen**. facelogin compensa esto exigiendo:

- La cara (descriptor facial) **Y**
- Firma de dispositivo de confianza **O** aserción WebAuthn (passkey)

Un descriptor facial solo, sin factor vinculante, responde `403 PASSKEY_REQUIRED`.

### 🔴 No es Face ID

- No usa sensores de profundidad 3D (TrueDepth)
- No usa Secure Enclave ni TEE
- Trabaja con cámaras 2D convencionales
- No tiene certificación anti-spoofing (iBeta)

### 🔴 Casos de uso apropiados

**✅ Apropiado para:**
- Aplicaciones internas de empresa
- Demos y prototipos
- Intranets y portales no públicos
- Apps donde el riesgo es recuperable

**❌ NO apropiado para:**
- Banca o finanzas
- Acceso a datos de terceros
- Sistemas donde un acceso no autorizado no se puede revertir
- Aplicaciones con cumplimiento regulatorio estricto

### Para producción masiva

La alternativa estándar de la industria son **WebAuthn/passkeys**, donde la biometría nunca sale del dispositivo y lo que viaja es una firma de clave pública.

## Requisitos previos

### 1. HTTPS obligatorio (excepto localhost)

- Tu `redirect_uri` **debe ser HTTPS** en producción
- `http://localhost` está permitido solo para desarrollo
- facelogin rechaza `redirect_uri` con `http://` que no sean loopback

### 2. Registro de tu aplicación como cliente OIDC

El operador de facelogin debe registrar tu app. Necesitas proporcionar:

- **`client_id`**: identificador único para tu app (ej: `"mi-app-web"`)
- **`name`**: nombre visible para usuarios (ej: `"Panel de Control"`)
- **`redirect_uris`**: lista exacta de URIs de callback (ej: `["https://miapp.com/auth/callback"]`)
- **`client_secret`** (opcional): solo si tu app es confidencial (tiene backend)
- **`scopes`**: normalmente `["openid", "profile"]`

Ejemplo de registro (el operador añade esto en `backend/config/clients.json`):

```json
{
  "client_id": "mi-app-web",
  "name": "Mi Aplicación",
  "redirect_uris": [
    "https://miapp.com/auth/callback"
  ],
  "client_secret": "32-bytes-aleatorios-generados-de-forma-segura",
  "scopes": ["openid", "profile"]
}
```

**Notas importantes:**
- Las `redirect_uris` se comparan por **igualdad exacta de cadena**
- No se admiten wildcards ni prefijos
- `https://app.com/callback?x=1` es **diferente** de `https://app.com/callback`
- Sin `client_secret` = cliente **público** (SPA, móvil): usa solo PKCE
- Con `client_secret` = cliente **confidencial** (backend): usa PKCE + secret

### 3. Variables de entorno en el servidor facelogin

El operador de facelogin configura:

```bash
# Emisor (URL pública del servidor facelogin)
FACELOGIN_ISSUER=https://facelogin.theclubsuperbroker.com

# Origen de la interfaz de usuario de facelogin
FACELOGIN_APP_ORIGIN=https://facelogin.theclubsuperbroker.com

# Registro de clientes (JSON inline o ruta a archivo)
FACELOGIN_OIDC_CLIENTS='[{"client_id":"...","name":"...","redirect_uris":["..."],"scopes":["openid","profile"]}]'
# O:
FACELOGIN_OIDC_CLIENTS_FILE=/ruta/a/clients.json

# Claves (generadas automáticamente en primer arranque si están vacías)
FACELOGIN_OIDC_PRIVATE_KEY=<generada>
FACELOGIN_OIDC_PAIRWISE_SALT=<generada>
```

## Guía paso a paso de integración

### Paso 0: Descubrimiento (opcional pero recomendado)

Lee la configuración OIDC del proveedor:

```bash
curl https://facelogin.theclubsuperbroker.com/.well-known/openid-configuration
```

Esto devuelve:
```json
{
  "issuer": "https://facelogin.theclubsuperbroker.com",
  "authorization_endpoint": "https://facelogin.theclubsuperbroker.com/authorize",
  "token_endpoint": "https://facelogin.theclubsuperbroker.com/token",
  "userinfo_endpoint": "https://facelogin.theclubsuperbroker.com/userinfo",
  "jwks_uri": "https://facelogin.theclubsuperbroker.com/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "subject_types_supported": ["pairwise"]
}
```

### Paso 1: Generar PKCE (código verifier)

PKCE protege el flujo de autorización. Genera un verifier aleatorio y su challenge:

**JavaScript/TypeScript:**
```javascript
import crypto from 'crypto';

// Generar code_verifier (43-128 caracteres, A-Za-z0-9-._~)
const codeVerifier = crypto.randomBytes(32).toString('base64url');

// Generar code_challenge
const hash = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
const codeChallenge = hash.toString('base64url');

// Guardar codeVerifier en la sesión del usuario
// (lo necesitarás en el paso 4)
```

**Python:**
```python
import hashlib
import base64
import secrets

# Generar code_verifier
code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')

# Generar code_challenge
challenge_bytes = hashlib.sha256(code_verifier.encode('ascii')).digest()
code_challenge = base64.urlsafe_b64encode(challenge_bytes).decode('utf-8').rstrip('=')
```

### Paso 2: Construir URL de autorización

```javascript
const authParams = new URLSearchParams({
  client_id: 'mi-app-web',
  redirect_uri: 'https://miapp.com/auth/callback',
  response_type: 'code',
  scope: 'openid profile',
  state: generarEstadoAleatorio(),    // Token CSRF, guardar en sesión
  nonce: generarNonceAleatorio(),     // Evita replay, guardar en sesión
  code_challenge: codeChallenge,
  code_challenge_method: 'S256'
});

const authUrl = `https://facelogin.theclubsuperbroker.com/authorize?${authParams}`;

// Redirigir al usuario
window.location.href = authUrl;
```

**Parámetros obligatorios:**

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `client_id` | Tu identificador | El que te dio el operador de facelogin |
| `redirect_uri` | URL exacta | Debe estar en tu allowlist |
| `response_type` | `code` | Único valor soportado |
| `scope` | `openid` o `openid profile` | `openid` es obligatorio |
| `state` | Cadena aleatoria | Tu defensa contra CSRF, verifica que vuelva igual |
| `nonce` | Cadena aleatoria | Anti-replay, debe aparecer en el `id_token` |
| `code_challenge` | Hash SHA-256 del verifier | Protección PKCE |
| `code_challenge_method` | `S256` | `plain` se rechaza |

**Parámetros opcionales:**

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `max_age` | Segundos | Frescura máxima de la autenticación (acotado a 300s por servidor) |
| `prompt` | `login` | Fuerza re-autenticación; `none` siempre devuelve `login_required` |

### Paso 3: Usuario verifica su cara

facelogin muestra:
1. Nombre de tu aplicación
2. Qué datos solicitas (openid, profile)
3. Interfaz de verificación facial

El usuario completa:
- Liveness (parpadeo, giro de cabeza)
- Firma con dispositivo de confianza o passkey

Si tiene éxito, facelogin redirige a tu `redirect_uri`:

```
https://miapp.com/auth/callback?code=CODIGO_AUTORIZACION&state=xyz
```

Si falla:
```
https://miapp.com/auth/callback?error=access_denied&error_description=...&state=xyz
```

### Paso 4: Tu backend canjea el código

**Tu backend** (no el frontend) hace:

```javascript
// 1. Verificar que state coincida (protección CSRF)
const estadoRecibido = req.query.state;
const estadoGuardado = req.session.oauthState;
if (estadoRecibido !== estadoGuardado) {
  throw new Error('CSRF: state no coincide');
}

// 2. Verificar que no hubo error
if (req.query.error) {
  throw new Error(`Autorización rechazada: ${req.query.error}`);
}

// 3. Canjear código por tokens
const tokenResponse = await fetch('https://facelogin.theclubsuperbroker.com/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    // Cliente confidencial: autenticación Basic
    'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
    // Cliente público: omitir Authorization header
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: 'https://miapp.com/auth/callback',  // Exactamente la misma
    code_verifier: req.session.codeVerifier           // El original
    // Cliente público también pasa client_id en el cuerpo:
    // client_id: CLIENT_ID
  })
});

if (!tokenResponse.ok) {
  const error = await tokenResponse.json();
  throw new Error(`Token exchange falló: ${error.error}`);
}

const tokens = await tokenResponse.json();
// tokens = {
//   access_token: "eyJ...",
//   token_type: "Bearer",
//   expires_in: 900,
//   id_token: "eyJ...",
//   scope: "openid profile"
// }
```

**Autenticación de cliente:**

- **Confidencial** (con `client_secret`):
  - Método 1 (recomendado): `Authorization: Basic base64(client_id:client_secret)`
  - Método 2: `client_id` y `client_secret` en el cuerpo

- **Público** (sin `client_secret`):
  - Solo `client_id` en el cuerpo
  - PKCE es la única defensa

**Características del código:**
- Vive **60 segundos**
- Es de **un solo uso**: el segundo intento falla y revoca tokens emitidos
- Está atado al `client_id` y `redirect_uri` originales

### Paso 5: Verificar el `id_token`

**NUNCA confíes en el token sin verificarlo.** Usa una biblioteca OIDC:

**Con `jose` (Node.js):**

```javascript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://facelogin.theclubsuperbroker.com';
const CLIENT_ID = 'mi-app-web';

// Cachea el JWKS (se actualiza automáticamente cuando cambia kid)
const jwks = createRemoteJWKSet(
  new URL(`${ISSUER}/.well-known/jwks.json`)
);

const { payload } = await jwtVerify(tokens.id_token, jwks, {
  issuer: ISSUER,                // Verifica iss
  audience: CLIENT_ID,           // Verifica aud
  algorithms: ['RS256']          // Fija el algoritmo (no confíes en el header)
});

// Verificar nonce (anti-replay)
const nonceGuardado = req.session.oauthNonce;
if (payload.nonce !== nonceGuardado) {
  throw new Error('Nonce no coincide: posible replay attack');
}

// payload contiene los claims del usuario
```

**¿Por qué fijar `algorithms`?**

Sin ello, un token con `alg: "none"` o con HMAC sobre la clave pública podría colarse en implementaciones vulnerables.

### Paso 6: Extraer identidad del usuario

**Claims del `id_token`:**

```json
{
  "iss": "https://facelogin.theclubsuperbroker.com",
  "sub": "zevZFyu4sCB5vhH_P8YugGdG5ZW3rCa9j3yI6XZTi8o",
  "aud": "mi-app-web",
  "exp": 1788075747,
  "iat": 1788075447,
  "auth_time": 1788075432,
  "nonce": "abc123",
  "amr": ["face", "hwk"],
  "name": "Ana García"
}
```

| Claim | Descripción |
|-------|-------------|
| `sub` | **Identidad única del usuario** (pairwise, ver abajo) |
| `name` | Nombre visible (solo si pediste scope `profile`) |
| `auth_time` | Cuándo se verificó la cara (timestamp Unix) |
| `amr` | Métodos: `["face", "hwk"]` (dispositivo) o `["face", "passkey"]` (WebAuthn) |
| `exp` | Expiración del token |
| `iat` | Cuándo se emitió |
| `nonce` | Tu nonce original (verifica que coincida) |

#### Sobre el `sub` (pairwise)

**🔑 IMPORTANTE:** El `sub` es la identidad primaria del usuario.

**Características:**
- Es **estable** para tu aplicación entre sesiones → úsalo como clave primaria
- Es **distinto en cada cliente** para la misma persona (privacidad)
- No es reversible sin el secreto del servidor facelogin
- Se calcula como: `HMAC-SHA256(secreto_del_servidor, sector || identidad_interna)`

**Consecuencias prácticas:**
- ✅ Usa `sub` como PK en tu tabla de usuarios
- ✅ Es estable: la misma persona siempre tiene el mismo `sub` en tu app
- ❌ NO compartas `sub` con otras apps: no significan lo mismo
- ❌ NO asumas que tu `sub=X` es el mismo `sub=X` de otra app
- ⚠️ Si el operador de facelogin cambia su secreto pairwise, todos los `sub` cambian (es una migración masiva)

### Paso 7: Asociar con usuario local

Dos estrategias comunes:

**Estrategia A: Login alternativo (existente)**

El usuario ya existe en tu sistema con email/contraseña. Ahora añades "también puede entrar con su cara":

```javascript
// Primera vez que el usuario usa facelogin
const user = await db.findByEmail(payload.email); // Si tienes email
if (!user) {
  throw new Error('Usuario no encontrado. Primero regístrate en la app.');
}

// Asociar sub de facelogin con usuario existente
await db.updateUser(user.id, {
  facelogin_sub: payload.sub
});

// Abrir sesión
req.session.userId = user.id;
```

**Estrategia B: Sign-up con cara**

facelogin es el método principal de registro:

```javascript
// Buscar usuario por sub
let user = await db.findByFaceloginSub(payload.sub);

if (!user) {
  // Primera vez: crear usuario
  user = await db.createUser({
    facelogin_sub: payload.sub,
    name: payload.name,
    created_at: new Date()
  });
}

// Abrir sesión
req.session.userId = user.id;
```

### Paso 8: Opcional - Llamar a `/userinfo`

Si necesitas claims actualizados (o no verificaste el `id_token`):

```javascript
const userinfoResponse = await fetch(
  'https://facelogin.theclubsuperbroker.com/userinfo',
  {
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`
    }
  }
);

const userinfo = await userinfoResponse.json();
// { "sub": "zevZ...", "name": "Ana García" }
```

**Notas:**
- Devuelve solo los claims del scope concedido
- Sin `profile`: solo `sub`
- `access_token` expira en 900s (15 min)
- Token revocado → `401 invalid_token`

## Añadir "Continuar con tu cara" sin quitar login existente

Muchas apps ya tienen email/contraseña o Google/GitHub SSO. Así añades facelogin como **opción adicional**:

### 1. En tu UI de login

```html
<!-- Login.tsx o Login.html -->
<div class="login-options">
  <!-- Método existente -->
  <form method="post" action="/auth/password">
    <input type="email" name="email" />
    <input type="password" name="password" />
    <button type="submit">Entrar</button>
  </form>

  <div class="separator">o</div>

  <!-- Opción nueva: facelogin -->
  <button onclick="loginConCara()">
    Continuar con tu cara
  </button>

  <!-- Otros SSO existentes -->
  <button onclick="loginConGoogle()">Google</button>
</div>

<script>
function loginConCara() {
  // Inicia flujo OIDC (paso 1-2 de arriba)
  window.location.href = '/auth/facelogin/start';
}
</script>
```

### 2. En tu backend: ruta `/auth/facelogin/start`

```javascript
app.get('/auth/facelogin/start', (req, res) => {
  // Generar PKCE y state/nonce
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');

  // Guardar en sesión
  req.session.faceloginState = { codeVerifier, state, nonce };

  // Construir URL de autorización
  const authUrl = new URL('https://facelogin.theclubsuperbroker.com/authorize');
  authUrl.searchParams.set('client_id', process.env.FACELOGIN_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', 'https://miapp.com/auth/facelogin/callback');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(authUrl.toString());
});
```

### 3. Callback: asociar o crear

```javascript
app.get('/auth/facelogin/callback', async (req, res) => {
  // Verificar state, canjear código, verificar id_token (pasos 4-5)
  const { sub, name } = payload; // Del id_token verificado

  // Buscar usuario existente
  let user = await db.query(
    'SELECT * FROM users WHERE facelogin_sub = $1',
    [sub]
  );

  if (!user && req.session.userId) {
    // Usuario ya logueado con otro método → vincular
    await db.query(
      'UPDATE users SET facelogin_sub = $1 WHERE id = $2',
      [sub, req.session.userId]
    );
  } else if (!user) {
    // Usuario nuevo → crear (o mostrar "regístrate primero" según tu política)
    user = await db.query(
      'INSERT INTO users (facelogin_sub, name) VALUES ($1, $2) RETURNING *',
      [sub, name]
    );
  }

  // Abrir sesión
  req.session.userId = user.id;
  res.redirect('/dashboard');
});
```

### 4. Schema de base de datos

```sql
ALTER TABLE users ADD COLUMN facelogin_sub VARCHAR(255) UNIQUE;
CREATE INDEX idx_facelogin_sub ON users(facelogin_sub);
```

Así los usuarios pueden:
- Registrarse con email/contraseña
- Luego vincular su cara desde configuración
- Y después elegir email **o** cara al entrar

## Manejo de errores

### Errores en `/authorize`

Si `client_id` o `redirect_uri` son inválidos, facelogin **no redirige** (sería un redirector abierto):

```html
<!-- Página de error mostrada por facelogin -->
<h1>No se puede continuar</h1>
<p>El cliente no se pudo verificar.</p>
<code>invalid_client</code>
```

Otros errores sí redirigen a tu `redirect_uri`:

```
https://miapp.com/callback?error=invalid_request&error_description=...&state=xyz
```

| Error | Causa |
|-------|-------|
| `invalid_request` | Falta parámetro obligatorio o formato malo |
| `unsupported_response_type` | `response_type` distinto de `code` |
| `invalid_scope` | Scope desconocido o sin `openid` |
| `access_denied` | Usuario canceló o no se verificó |
| `temporarily_unavailable` | Rate limit excedido |

### Errores en `/token`

```json
{
  "error": "invalid_grant",
  "error_description": "El código ya se usó o expiró."
}
```

| Error | Causa |
|-------|-------|
| `invalid_request` | Faltan parámetros o formato incorrecto |
| `invalid_client` | `client_id` o `client_secret` inválidos |
| `invalid_grant` | Código expirado, usado, o `code_verifier` malo |
| `unauthorized_client` | Cliente no autorizado para este grant |

### Errores en identificación facial

Si el usuario no se puede verificar (no está enrolado, no pasa liveness, etc.), facelogin redirige con `error=access_denied`.

**Casos específicos:**

1. **Usuario no enrolado**: El usuario nunca se registró en facelogin
   - Tu app debe mostrar: "Primero debes enrolar tu cara en [link]"
   - O redirigir a flujo de enroll (si tienes `FACELOGIN_ENROLL_TOKEN`)

2. **Token de enroll requerido**: Si facelogin tiene `FACELOGIN_ENROLL_TOKEN` configurado
   - El enroll requiere un token de invitación
   - Coordina con el operador de facelogin para obtener tokens

3. **`PASSKEY_REQUIRED`**: El descriptor facial solo no abre sesión
   - Usuario debe tener dispositivo de confianza vinculado o passkey
   - Es una protección adicional de facelogin

## Ejemplo completo (Next.js)

```typescript
// app/auth/facelogin/route.ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';

const ISSUER = process.env.FACELOGIN_ISSUER!;
const CLIENT_ID = process.env.FACELOGIN_CLIENT_ID!;
const CLIENT_SECRET = process.env.FACELOGIN_CLIENT_SECRET!;
const REDIRECT_URI = `${process.env.NEXT_PUBLIC_URL}/auth/facelogin/callback`;

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
  return crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
}

// GET /auth/facelogin - Inicia flujo
export async function GET() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  // Guardar en cookie firmada (en producción usa sesión de servidor)
  const cookieStore = cookies();
  cookieStore.set('facelogin_state', JSON.stringify({
    codeVerifier,
    state,
    nonce
  }), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600 // 10 min
  });

  const authUrl = new URL(`${ISSUER}/authorize`);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return NextResponse.redirect(authUrl);
}

// app/auth/facelogin/callback/route.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      `/login?error=${encodeURIComponent(error)}`
    );
  }

  // Recuperar estado guardado
  const cookieStore = cookies();
  const stateCookie = cookieStore.get('facelogin_state');
  if (!stateCookie) {
    return new NextResponse('Estado ausente', { status: 400 });
  }

  const { codeVerifier, state: savedState, nonce } = JSON.parse(stateCookie.value);

  // Verificar state (CSRF)
  if (state !== savedState) {
    return new NextResponse('State no coincide', { status: 400 });
  }

  // Canjear código por tokens
  const tokenResponse = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier
    })
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.json();
    return new NextResponse(`Token error: ${errorData.error}`, {
      status: tokenResponse.status
    });
  }

  const tokens = await tokenResponse.json();

  // Verificar id_token
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: ISSUER,
    audience: CLIENT_ID,
    algorithms: ['RS256']
  });

  // Verificar nonce
  if (payload.nonce !== nonce) {
    return new NextResponse('Nonce no coincide', { status: 400 });
  }

  // Buscar o crear usuario
  const { sub, name } = payload;
  let user = await db.findByFaceloginSub(sub as string);

  if (!user) {
    user = await db.createUser({
      facelogin_sub: sub as string,
      name: name as string
    });
  }

  // Crear sesión
  await createSession(user.id);

  // Limpiar cookie temporal
  cookieStore.delete('facelogin_state');

  return NextResponse.redirect('/dashboard');
}
```

## Lista de verificación de seguridad

Antes de desplegar a producción:

- [ ] **HTTPS**: Tu `redirect_uri` usa HTTPS (excepto localhost en dev)
- [ ] **State verificado**: Verificas que el `state` recibido coincida con el guardado
- [ ] **Nonce verificado**: Verificas que el `nonce` del `id_token` coincida con el guardado
- [ ] **Firma del token**: Verificas el `id_token` contra JWKS con `issuer`, `audience` y `algorithms: ['RS256']`
- [ ] **`client_secret` protegido**: El secret está solo en el backend, nunca en frontend o repo
- [ ] **`redirect_uri` exacta**: La URI en tu allowlist es exactamente la que usas (incluyendo query params si los hay)
- [ ] **`sub` como PK**: Usas `sub` como clave primaria, no `name` ni otro claim mutable
- [ ] **Manejo de errores**: Tu app maneja errores de `access_denied`, `invalid_grant`, etc.
- [ ] **Rate limits**: No haces reintentos sin backoff exponencial
- [ ] **Sesión segura**: Los valores de `codeVerifier`, `state`, `nonce` viven en sesión de servidor (no localStorage ni cookies accesibles desde JS)

## Demo de producción

**URL:** https://facelogin.theclubsuperbroker.com

**Restricciones:**
- Puede requerir token de enroll (`FACELOGIN_ENROLL_TOKEN`) para crear cuentas
- Si el enroll requiere invitación, contacta al operador del servidor
- El liveness está activo (parpadeo + giro obligatorios)
- Se requiere firma de dispositivo o passkey además del descriptor facial

## Recursos adicionales

- **Documentación técnica OIDC completa**: [`docs/integracion-oidc.md`](./integracion-oidc.md)
- **Ejemplo funcional mínimo**: El doc técnico incluye un cliente Node.js completo de ~100 líneas
- **Configuración de clientes**: [`backend/config/clients.example.json`](../backend/config/clients.example.json)
- **Límites y threat model**: [`docs/estado-seguridad.md`](./estado-seguridad.md)

## Soporte y preguntas

Para problemas técnicos o preguntas sobre la integración:

1. Revisa la documentación técnica completa en `docs/integracion-oidc.md`
2. Verifica que tu `client_id` esté registrado correctamente
3. Revisa los logs del servidor facelogin (el operador tiene acceso)
4. Abre un issue en el repositorio: https://github.com/victoMR/facelogin/issues

Para problemas de verificación facial (usuarios que no pueden entrar):

1. Verifica que el usuario esté enrolado en facelogin
2. Confirma que el usuario tenga dispositivo vinculado o passkey configurado
3. Prueba el flujo de enroll/login directo en la UI de facelogin antes de culpar a la integración OIDC
