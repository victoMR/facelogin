import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  passkeyAuthenticateOptions,
  passkeyRegister,
  passkeyRegisterOptions,
  type PasskeyAssertion,
} from "./api";

export function passkeySupported(): boolean {
  return typeof window.PublicKeyCredential === "function";
}

export async function registerPasskey(token: string): Promise<void> {
  const { ticket, options } = await passkeyRegisterOptions(token);
  const credential = await startRegistration({ optionsJSON: options as never });
  await passkeyRegister(token, { ticket, credential });
}

export async function authenticatePasskey(): Promise<PasskeyAssertion> {
  const { ticket, options } = await passkeyAuthenticateOptions();
  const assertion = await startAuthentication({ optionsJSON: options as never });
  return { ticket, assertion };
}
