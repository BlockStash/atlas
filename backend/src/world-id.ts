import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { z } from "zod";
export class VerificationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export interface WorldIdConfig {
  appId: string;
  rpId: string;
  action: string;
  signingKey: string;
  environment: "production" | "staging";
}
export interface PendingProof {
  walletAddress: string;
  sessionToken: string;
  nonce: string;
  expiresAt: number;
}
export const proofSchema = z
  .object({
    protocol_version: z.enum(["3.0", "4.0"]),
    nonce: z.string().max(100),
    action: z.string().max(256),
    environment: z.enum(["production", "staging"]),
    responses: z
      .array(
        z
          .object({
            identifier: z.string(),
            signal_hash: z.string(),
            nullifier: z.string().max(100),
            issuer_schema_id: z.number().optional(),
            proof: z.union([
              z.string().max(10000),
              z.array(z.string().max(200)).length(5),
            ]),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();
export function requireWorldConfig(
  config: WorldIdConfig | undefined,
  production: boolean,
): WorldIdConfig {
  if (
    !config ||
    !/^app_\w+$/.test(config.appId) ||
    !/^rp_\w+$/.test(config.rpId) ||
    !config.action ||
    !/^(0x)?[0-9a-fA-F]{64}$/.test(config.signingKey)
  )
    throw new VerificationError(
      "WORLD_ID_UNAVAILABLE",
      "World ID setup is incomplete. Configure the app, RP, action and signing key on the Atlas server.",
      503,
    );
  if (production && config.environment !== "production")
    throw new VerificationError(
      "WORLD_ID_ENVIRONMENT",
      "Live deployments require production World ID verification.",
      503,
    );
  return config;
}
export function createWorldRequest(config: WorldIdConfig, address: string) {
  const signed = signRequest({
    signingKeyHex: config.signingKey,
    action: config.action,
    ttl: 300,
  });
  return {
    app_id: config.appId as `app_${string}`,
    action: config.action,
    environment: config.environment,
    signal: address.toLowerCase(),
    rp_context: {
      rp_id: config.rpId,
      nonce: signed.nonce,
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
    },
  };
}
export async function verifyWorldId(
  input: { demo?: boolean; proof?: unknown },
  options: {
    demoEnabled: boolean;
    production: boolean;
    config?: WorldIdConfig;
    pending?: PendingProof;
    address?: string;
    fetcher?: typeof fetch;
  },
) {
  if (input.demo) {
    if (!options.demoEnabled || options.production)
      throw new VerificationError(
        "DEMO_DISABLED",
        "Demo verification is unavailable.",
        403,
      );
    return {
      verified: true as const,
      demo: true,
      environment: null,
      nullifier: undefined,
    };
  }
  const config = requireWorldConfig(options.config, options.production);
  const proof = proofSchema.parse(input.proof);
  if (
    !options.pending ||
    options.pending.expiresAt <= Date.now() ||
    options.pending.walletAddress.toLowerCase() !==
      options.address?.toLowerCase() ||
    proof.nonce !== options.pending.nonce
  )
    throw new VerificationError(
      "WORLD_ID_EXPIRED",
      "Your verification request expired. Start World ID verification again.",
      409,
    );
  const item = proof.responses[0]!;
  if (
    proof.action !== config.action ||
    proof.environment !== config.environment ||
    item.signal_hash.toLowerCase() !==
      hashSignal(options.address!.toLowerCase()).toLowerCase()
  )
    throw new VerificationError(
      "WORLD_ID_BINDING",
      "This proof does not match your wallet or Atlas verification request.",
      400,
    );
  if (
    proof.protocol_version === "4.0"
      ? item.issuer_schema_id !== 1 || item.identifier !== "proof_of_human"
      : !["orb", "proof_of_human"].includes(item.identifier)
  )
    throw new VerificationError(
      "WORLD_ID_CREDENTIAL",
      "Atlas requires the World ID proof of human credential.",
      400,
    );
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      `https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proof),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new VerificationError(
      "WORLD_ID_NETWORK",
      "World ID could not be reached. Start verification again in a moment.",
      503,
    );
  }
  const result = (await response.json().catch(() => null)) as {
    success?: boolean;
    environment?: string;
    results?: { success?: boolean; identifier?: string; nullifier?: string }[];
  } | null;
  if (
    !response.ok ||
    result?.success !== true ||
    !result.results?.some(
      (r) =>
        r.success === true &&
        r.nullifier === item.nullifier &&
        r.identifier === item.identifier,
    ) ||
    (result.environment && result.environment !== config.environment)
  )
    throw new VerificationError(
      "WORLD_ID_INVALID",
      "World ID did not accept this proof. Start verification again with World App.",
      400,
    );
  return {
    verified: true as const,
    demo: false,
    environment: config.environment,
    nullifier: `${config.rpId}:${config.action}:${config.environment}:${BigInt(item.nullifier).toString(10)}`,
  };
}
