# Integrar un servicio con facelogin (OpenID Connect)

facelogin actúa como **proveedor de identidad OIDC**: tu servicio delega el login y recibe un `id_token` firmado que dice quién es la persona. El flujo es *authorization code* con **PKCE obligatorio (solo S256)** y firma **RS256**.

Lo primero, porque condiciona todo lo demás:

---

## Antes de integrar: lee esto

**El liveness sigue siendo del lado cliente.** El parpadeo, el giro y las palabras dichas no autorizan el JWT. `POST /api/identify` exige la cara **y** una firma de la llave del aparato o una aserción WebAuthn verificada. Un descriptor solo, o un `transcript` con las palabras del challenge, responde `403 PASSKEY_REQUIRED`.

Eso cierra el acceso con solo 128 floats. No cierra un portátil robado con la llave local, ni un replay de vídeo ante una webcam real. **Sigue siendo un IdP interno o de demostración, no un proveedor público.** No lo pongas delante de dinero, de datos de terceros ni de nada que no puedas revertir.

Un integrador tiene que poder tomar esa decisión con la información delante; por eso está aquí arriba y no en una nota al pie.

> Para integración masiva, la alternativa estándar de la industria son **passkeys / WebAuthn**, donde la biometría nunca sale del dispositivo del usuario y lo que viaja es una firma de clave pública.

---

## Lo que tu servicio NO recibe

Recibes un token firmado que dice **quién** es el usuario. No recibes:

- ningún descriptor facial,
- ninguna parte del vault,
- ninguna clave para descifrar plantillas.

Esto no es una omisión: es el diseño. Repartir la tabla cifrada y su clave entre N servicios convierte cualquier filtración en uno solo de ellos en el descifrado de **todas** las plantillas de **todos** los usuarios. Una contraseña filtrada se rota; una cara no.

---

## 1. Darte de alta como cliente

El registro vive en configuración del servidor, no en el vault de rostros. El operador de facelogin añade una entrada en `FACELOGIN_OIDC_CLIENTS` (JSON en línea) o en el archivo de `FACELOGIN_OIDC_CLIENTS_FILE` (ver `backend/config/clients.example.json`):

```json
[
  {
    "client_id": "panel-demo",
    "name": "Panel de demostración",
    "redirect_uris": ["https://panel.example/callback"],
    "client_secret": "32 bytes aleatorios, solo si eres confidencial",
    "scopes": ["openid", "profile"]
  }
]
```

| campo | qué significa |
| --- | --- |
| `client_id` | identificador público de tu servicio |
| `name` | lo que ve el usuario en la pantalla de verificación |
| `redirect_uris` | **allowlist exacta**. Se compara por igualdad de cadena: ni comodines, ni prefijos, ni "cualquier ruta bajo este dominio". `https://panel.example/callback?x=1` es *otra* URI |
| `client_secret` | presente ⇒ cliente **confidencial** (backend). Ausente ⇒ cliente **público** (SPA, móvil), cuya única prueba en `/token` es PKCE |
| `scopes` | tope de lo que puedes pedir. `openid` es obligatorio |
| `sector_identifier` | opcional: agrupa varios `client_id` bajo el mismo `sub` (varias apps del mismo equipo). Por omisión cada cliente es su propio sector |

Un `redirect_uri` `http://` fuera de loopback se rechaza al arrancar salvo que se marque `allow_insecure_redirect`. El código de autorización viaja en esa URL.

## 2. Descubrimiento

```
GET {issuer}/.well-known/openid-configuration
GET {issuer}/.well-known/jwks.json
```

El discovery anuncia exactamente lo que hay: `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `subject_types_supported: ["pairwise"]`, `id_token_signing_alg_values_supported: ["RS256"]`.

El JWKS publica **solo la clave pública**, con `kid`. Cachéalo, pero refréscalo cuando te llegue un `kid` que no conozcas: así el operador puede rotar la clave (poniendo la nueva delante y dejando la anterior publicada) sin coordinarse contigo.

## 3. `GET /authorize`

| parámetro | obligatorio | valor |
| --- | --- | --- |
| `client_id` | sí | el tuyo |
| `redirect_uri` | sí | **idéntica** a una de tu allowlist |
| `response_type` | sí | `code` |
| `scope` | sí | debe incluir `openid`; opcionalmente `profile` |
| `state` | recomendado | opaco tuyo; vuelve intacto. Es tu defensa contra CSRF |
| `nonce` | **sí** | opaco de un solo uso; aparece en el `id_token`. Guárdalo en la sesión y compáralo |
| `code_challenge` | **sí** | `BASE64URL(SHA256(code_verifier))` |
| `code_challenge_method` | **sí** | `S256`. `plain` se rechaza |
| `max_age` | no | segundos. Se acota al máximo del servidor (300 s por defecto) |
| `prompt` | no | `login` fuerza reautenticación. `prompt=none` siempre devuelve `login_required`: aquí no hay login silencioso |

Errores:

- `client_id` desconocido o `redirect_uri` fuera de la allowlist ⇒ **no hay redirección**: se muestra una página de error. Reenviar un error a una URI sin verificar sería un redirector abierto.
- Cualquier otro error ⇒ redirección a tu `redirect_uri` con `error`, `error_description` y tu `state`.

Éxito: el usuario pasa por la verificación facial y vuelve a tu `redirect_uri` con `?code=…&state=…`. Verifica el `state` **antes** de canjear nada.

## 4. `POST /token`

`Content-Type: application/x-www-form-urlencoded`. Rate limit por IP.

```
grant_type=authorization_code
code=…
redirect_uri=…        # exactamente la del /authorize
code_verifier=…       # el original, 43–128 caracteres [A-Za-z0-9-._~]
```

Autenticación de cliente:

- **confidencial**: `Authorization: Basic base64(client_id:client_secret)` (`client_secret_basic`) o `client_id`+`client_secret` en el cuerpo (`client_secret_post`). El secreto se compara en tiempo constante.
- **público**: `client_id` en el cuerpo y nada más. Mandar un secreto siendo público es un error.

El código:

- vive **60 segundos**,
- es de **un solo uso**: el segundo canje devuelve `invalid_grant` **y revoca los tokens que salieron del primero** (un código repetido significa que alguien más lo tenía),
- está atado al `client_id` y a la `redirect_uri` con los que se pidió.

Respuesta:

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs…",
  "token_type": "Bearer",
  "expires_in": 900,
  "id_token": "eyJhbGciOiJSUzI1NiIs…",
  "scope": "openid profile"
}
```

## 5. Verificar el `id_token`

Nunca lo aceptes sin verificar. Con `jose`:

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://facelogin.example";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

const { payload } = await jwtVerify(idToken, jwks, {
  issuer: ISSUER,          // iss
  audience: "panel-demo",  // aud == tu client_id
  algorithms: ["RS256"],   // fija el algoritmo: no dejes que lo elija el token
});
if (payload.nonce !== nonceGuardadoEnLaSesion) throw new Error("nonce no coincide");
```

Fijar `algorithms` no es cosmético: sin ello un token con `alg: "none"` o con un HMAC sobre la clave pública podría colarse en implementaciones descuidadas.

### Claims

```json
{
  "iss": "https://facelogin.example",
  "sub": "zevZFyu4sCB5vhH_P8YugGdG5ZW3rCa9j3yI6XZTi8o",
  "aud": "panel-demo",
  "exp": 1788075747,
  "iat": 1788075447,
  "auth_time": 1788075432,
  "nonce": "n-abc",
  "amr": ["face", "hwk"],
  "name": "Ana Prueba"
}
```

- `name` solo aparece con el scope `profile`.
- `auth_time` es cuándo se verificó la cara de verdad, no cuándo se firmó el token. Úsalo si tu operación necesita frescura.
- `amr` distingue el factor vinculante: `["face", "hwk"]` si firmó el aparato de confianza, `["face", "passkey"]` si usó WebAuthn.

### `sub` pairwise

El `sub` es `HMAC-SHA256(secreto_del_servidor, sector ‖ identidad)` en base64url. Consecuencias prácticas:

- **Es estable** para tu cliente entre sesiones: úsalo como clave primaria de tu tabla de usuarios.
- **Es distinto en cada cliente** para la misma persona. Si tú y otro servicio cruzáis vuestras bases de usuarios, no podéis deducir que vuestro usuario A y su usuario B son la misma cara.
- **No es el identificador interno** de facelogin y no se puede invertir sin el secreto del servidor.
- Cambiar el secreto pairwise en el servidor **cambia el `sub` de todos los usuarios en todos los clientes**. Es una migración, no mantenimiento.

## 6. `GET /userinfo`

```
Authorization: Bearer {access_token}
```

Devuelve los claims **del scope concedido**, no de lo que pida quien presente el token:

```json
{ "sub": "zevZ…", "name": "Ana Prueba" }
```

Sin `profile`, solo `sub`. Un token revocado o caducado devuelve `401 invalid_token`.

---

## Ejemplo funcional mínimo

Cliente confidencial completo, sin dependencias más allá de `jose`. Levántalo en `http://localhost:4000` con el `client_id`/`client_secret` que te dé el operador.

```js
// cliente-demo.mjs — node cliente-demo.mjs
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = process.env.ISSUER ?? "http://localhost:8787";
const CLIENT_ID = process.env.CLIENT_ID ?? "panel-demo";
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "un-secreto-de-32-bytes-para-la-demo";
const REDIRECT_URI = "http://localhost:4000/callback";

const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const b64url = (buf) => buf.toString("base64url");
// En un servicio real esto vive en la sesión del usuario, no en un Map global.
const pendientes = new Map();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:4000");

  if (url.pathname === "/") {
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    pendientes.set(state, { verifier, nonce });

    const authorize = new URL(`${ISSUER}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier, "ascii").digest()),
      code_challenge_method: "S256",
    }).toString();
    res.writeHead(302, { Location: authorize.toString() }).end();
    return;
  }

  if (url.pathname === "/callback") {
    const state = url.searchParams.get("state");
    const pendiente = pendientes.get(state);
    // Sin state conocido no se canjea nada: es la defensa contra CSRF de login.
    if (!pendiente) return res.writeHead(400).end("state desconocido");
    pendientes.delete(state);

    if (url.searchParams.get("error")) {
      return res.writeHead(400).end(`el IdP devolvió: ${url.searchParams.get("error")}`);
    }

    const respuesta = await fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        redirect_uri: REDIRECT_URI,
        code_verifier: pendiente.verifier,
      }),
    });
    if (!respuesta.ok) return res.writeHead(400).end(await respuesta.text());
    const tokens = await respuesta.json();

    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      algorithms: ["RS256"],
    });
    if (payload.nonce !== pendiente.nonce) return res.writeHead(400).end("nonce no coincide");

    const userinfo = await (
      await fetch(`${ISSUER}/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json();

    res
      .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ id_token: payload, userinfo }, null, 2));
    return;
  }

  res.writeHead(404).end();
}).listen(4000, () => console.log("cliente demo en http://localhost:4000"));
```

Abre `http://localhost:4000`, verifica tu rostro y verás los claims. La única identidad persistente que debes guardar es `id_token.sub`.

### El mismo recorrido con `curl`

Útil para depurar. Los pasos 2 y 3 los hace normalmente el navegador del usuario.

```bash
ISSUER=http://localhost:8787
VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -binary -sha256 | base64 | tr '+/' '-_' | tr -d '=')

# 1) /authorize → 302 a la interfaz facial, con un identificador opaco de la petición
curl -s -D - -o /dev/null "$ISSUER/authorize?client_id=panel-demo\
&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fcallback&response_type=code\
&scope=openid+profile&state=xyz-123&nonce=n-abc\
&code_challenge=$CHALLENGE&code_challenge_method=S256" | grep -i '^location'
# location: http://localhost:5173/app?oidc=SfE3OGkT82xzt...

# 2) el usuario se identifica en la interfaz (cara + llave del aparato o passkey)
# Un POST solo con el descriptor ya no entrega token: responde 403 PASSKEY_REQUIRED.

# 3) la interfaz canjea la sesión facial por el código
curl -s -X POST $ISSUER/api/oidc/approve -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"requestId":"SfE3OGkT82xzt..."}'
# {"redirect":"http://localhost:4000/callback?code=p1uY0R58...&state=xyz-123"}

# 4) tu backend canjea el código
curl -s -X POST $ISSUER/token -u "panel-demo:un-secreto-de-32-bytes-para-la-demo" \
  -d grant_type=authorization_code -d "code=p1uY0R58..." \
  -d 'redirect_uri=http://localhost:4000/callback' -d "code_verifier=$VERIFIER"

# 5) userinfo
curl -s $ISSUER/userinfo -H "Authorization: Bearer <access_token>"
```

---

## Lista de comprobación para el integrador

- [ ] Guardas `state` y `nonce` en la sesión del usuario y los verificas al volver.
- [ ] Verificas la firma del `id_token` contra el JWKS, con `issuer`, `audience` y `algorithms: ["RS256"]` fijados.
- [ ] Usas `sub` como clave primaria, y no asumes que el mismo `sub` significa lo mismo en otro servicio.
- [ ] Tu `redirect_uri` de producción está en la allowlist, byte a byte.
- [ ] Tu `client_secret` (si eres confidencial) no está en el navegador ni en el repositorio.
- [ ] Has leído la advertencia sobre el liveness y aceptas que esto es un IdP interno.
