# Norte — el auth open source sin password

> Estamos construyendo el auth open source sin password: elegante como Face ID, obsesivo con la seguridad, y diseñado para que olvidar contraseñas deje de ser un problema humano.

## Tesis
Auth open source sin password. Tu cara es la llave. Seguridad obsesiva: si alguien entra a robar, se quema.

## Pilares (en este orden)
1. **Cero password** — se acabó “¿cuál era mi usuario?”
2. **Privacidad radical** — la foto no viaja; datos del cliente nunca en claro
3. **Seguridad ofensiva** — honeypots, canaries, threat model público
4. **Elegante y universal** — lindo, rápido, usable en todo

## Roadmap de confianza

| Ahora (honesto) | Cuando cierre el bypass (attestation) |
|---|---|
| El auth open source sin password | Auth sin password a prueba de intrusos |
| La foto no viaja | Nivel banco: verificable en servidor |
| IdP listo para demos e internos | Listo para productos reales |
| Amenaza modelo público en construcción | Amenaza modelo + FAR/FPIR publicados |

## Hero
- **Hoy:** facelogin — La foto no viaja. *(promesa que ya cumplimos)*
- **Cuando 1 del roadmap técnico esté cerrado:** facelogin — Fácil para ti. Infernal para ellos.

## Roadmap técnico (pilar)
1. Cerrar el bypass — attestation / frame firmado o match en entorno confiable
2. Honeypots + canaries en vault/API
3. Zero-knowledge de datos — nunca foto, nunca template en claro, rotación de llaves, threat model público
4. Open source con threat model + eval FAR/FPIR medido

No vendemos Face ID bancario hasta que (1) esté cerrado.
