import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { VerificationError } from "./world-id.js";

export interface PasskeyConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

/**
 * WebAuthn RP IDs must be a registrable domain, never an IP address, so local
 * 127.0.0.1 origins are served under "localhost" (open Atlas at http://localhost:3000).
 */
export function passkeyConfig(
  frontendOrigin: string,
  rpId?: string,
): PasskeyConfig {
  const url = new URL(frontendOrigin);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const origins = local
    ? [
        url.origin,
        `${url.protocol}//localhost${url.port ? `:${url.port}` : ""}`,
      ]
    : [url.origin];
  return {
    rpId: rpId || (local ? "localhost" : url.hostname),
    rpName: "Atlas",
    origins: [...new Set(origins)],
  };
}

export function passkeyRegistrationOptions(
  config: PasskeyConfig,
  address: string,
  excludeCredentialId?: string | null,
) {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: address,
    userDisplayName: `Atlas ${address.slice(0, 6)}…${address.slice(-4)}`,
    userID: new TextEncoder().encode(address.toLowerCase()),
    attestationType: "none",
    excludeCredentials: excludeCredentialId
      ? [{ id: excludeCredentialId }]
      : [],
    authenticatorSelection: {
      residentKey: "preferred",
      // Require biometric / PIN user verification: the human-presence signal.
      userVerification: "required",
    },
  });
}

export async function verifyPasskeyRegistration(
  config: PasskeyConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (error) {
    throw new VerificationError(
      "PASSKEY_INVALID",
      error instanceof Error
        ? `Passkey could not be verified: ${error.message}`
        : "Passkey could not be verified.",
      400,
    );
  }
  if (!result.verified || !result.registrationInfo)
    throw new VerificationError(
      "PASSKEY_INVALID",
      "Passkey could not be verified.",
      400,
    );
  const { credential, credentialDeviceType, credentialBackedUp } =
    result.registrationInfo;
  return {
    passkeyCredentialId: credential.id,
    passkeyPublicKey: isoBase64URL.fromBuffer(credential.publicKey),
    passkeyCounter: credential.counter,
    passkeyDeviceType: credentialDeviceType,
    passkeyBackedUp: credentialBackedUp,
  };
}
