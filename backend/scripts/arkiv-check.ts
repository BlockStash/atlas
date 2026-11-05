import "dotenv/config";
import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
} from "@arkiv-network/sdk";
import { arkivConnection } from "../src/arkiv-connection.js";
import { defineSchema, str, bytes } from "@arkiv-network/sdk/schema";
import { eq } from "@arkiv-network/sdk/query";
import { formatEther, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import { profileCrypto } from "../src/profile-crypto.js";
async function main() {
  const { chain, transport } = arkivConnection({
    rpcUrl: process.env.ARKIV_RPC_URL,
    accessKey: process.env.ARKIV_ACCESS_KEY,
  });
  const reader = createPublicClient({ chain, transport });
  assert.equal(await reader.getChainId(), Number(process.env.ARKIV_CHAIN_ID));
  const expected = process.env.ARKIV_SIGNER_ADDRESS as Hex;
  const balance = await reader.getBalance({ address: expected });
  console.log(`Arkiv network: Rabdi (${chain.id})`);
  console.log(`Expected signer: ${expected}`);
  console.log(`Signer balance: ${formatEther(balance)} tGLM`);
  const secret = process.env.ARKIV_PRIVATE_KEY || "";
  const account = /^(0x)?[0-9a-fA-F]{64}$/.test(secret)
    ? privateKeyToAccount(
        (secret.startsWith("0x") ? secret : `0x${secret}`) as Hex,
      )
    : null;
  const matches = account?.address.toLowerCase() === expected.toLowerCase();
  console.log(
    `Signing key matches expected address: ${matches ? "yes" : "no; update ARKIV_PRIVATE_KEY in backend/.env"}`,
  );
  const Schema = defineSchema("atlas.storage-check.v1", {
    probe: str().indexed(),
    payload: bytes(),
  });
  const probe = randomUUID();
  await reader
    .select({ $key: true })
    .from(Schema)
    .where(eq("probe", probe))
    .ownedBy(expected)
    .createdBy(expected)
    .limit(1)
    .fetch();
  console.log("Arkiv typed entity queries: working");
  if (!process.argv.includes("--write")) {
    console.log(
      "Read-only check complete. Run with --write for an encrypted create/read/update/delete check.",
    );
    return;
  }
  if (!matches || !account)
    throw new Error(
      "ARKIV_PRIVATE_KEY must match ARKIV_SIGNER_ADDRESS before testing writes.",
    );
  if (balance === 0n)
    throw new Error(
      "Fund the signer with Rabdi test tGLM before testing writes.",
    );
  const writer = createWalletClient({ chain, transport, account }),
    crypto = profileCrypto(
      process.env.ARKIV_ENCRYPTION_KEY || "",
      "atlas-storage-check",
    );
  const result = await writer.createEntity(
    Schema,
    { probe, payload: crypto.encrypt(expected, { probe, value: 1 }) },
    { expiration: ExpirationTime.fromMinutes(10) },
  );
  console.log(`Temporary encrypted entity created: ${result.entityKey}`);
  try {
    let row = await reader.getEntity(result.entityKey, Schema);
    assert.equal(
      crypto.decrypt<{ value: number }>(expected, hexToBytes(row.payload.value))
        .value,
      1,
    );
    await writer.patchEntity(Schema, result.entityKey, {
      set: { payload: crypto.encrypt(expected, { probe, value: 2 }) },
    });
    row = await reader.getEntity(result.entityKey, Schema);
    assert.equal(
      crypto.decrypt<{ value: number }>(expected, hexToBytes(row.payload.value))
        .value,
      2,
    );
    console.log("Encrypted create, read and update: passed");
  } finally {
    await writer.deleteEntity({ entityKey: result.entityKey });
    console.log("Temporary entity deleted.");
  }
}
main().catch((error) => {
  console.error(
    "Arkiv check failed. Check ARKIV_ACCESS_KEY, RPC connectivity and signer configuration.",
  );
  process.exitCode = 1;
});
