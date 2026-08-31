/**
 * `sub` pairwise: un identificador distinto por cliente para la misma persona.
 *
 * Si el `sub` fuera el id de la identidad, dos servicios que comparen sus bases
 * de usuarios sabrían al instante que su usuario A y su usuario B son la misma
 * cara. Con un HMAC de (sector, identidad) bajo un secreto que solo conoce este
 * servidor, cada cliente recibe un opaco que:
 *
 * - es **estable** para ese cliente entre sesiones (se puede usar como clave primaria),
 * - es **distinto** en otro cliente,
 * - no se puede invertir ni relacionar sin el secreto.
 *
 * El secreto es propio (`FACELOGIN_OIDC_PAIRWISE_SALT`) y NO se reutiliza el de
 * sesión: rotar el secreto de sesión es una operación rutinaria, y rotar este
 * cambia el `sub` de todos los usuarios en todos los clientes, que es una
 * migración. Cosas con vidas distintas, secretos distintos.
 */
import { createHmac } from "node:crypto";

export function pairwiseSubject(saltBase64: string, sector: string, identityId: string): string {
  // Prefijo de longitud: sin él, (sector "ab", id "c") y (sector "a", id "bc")
  // producirían el mismo HMAC.
  const message = `oidc-pairwise:v1:${sector.length}:${sector}:${identityId}`;
  return createHmac("sha256", Buffer.from(saltBase64, "base64")).update(message).digest("base64url");
}
