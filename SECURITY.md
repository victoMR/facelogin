# Seguridad

facelogin apuesta a cero passwords y a que la foto nunca viaje.
La seguridad es el producto, no un anexo.

Hoy: plantillas cifradas, sin persistir fotos, OIDC con PKCE.
En camino: attestation verificable en servidor, honeypots/canaries,
threat model público y métricas FAR/FPIR medidas.

¿Hallazgo? Abre un advisory privado. No publiques exploits en issues abiertos.

## Roadmap de confianza (issues)

Títulos listos para cuando el repo sea público:

1. Threat model v0 (público)
2. Cerrar bypass de `/identify` (attestation)
3. Honeypots + canaries en vault/API
4. Publicar eval FAR/FPIR
5. Rotación de llaves + runbook de incidente

Detalle de producto/ambición: [`docs/norte.md`](docs/norte.md).
