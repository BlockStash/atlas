import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { profileCrypto } from "../src/profile-crypto.js";
import { IdentityClaims } from "../src/identity-claims.js";
import { ArkivProfileStore } from "../src/arkiv-store.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
test("Arkiv profile encryption hides identity data and rejects tampering, wrong wallets and keys", () => {
  const key = randomBytes(32).toString("hex"),
    crypto = profileCrypto(key, "atlas-test");
  const value = {
    ensName: "alice.eth",
    worldIdNullifier: "rp:action:prod:123",
    selectedMarkets: ["india"],
  };
  const encrypted = crypto.encrypt("0xabc", value);
  assert.equal(
    Buffer.from(encrypted).includes(Buffer.from("alice.eth")),
    false,
  );
  assert.equal(Buffer.from(encrypted).includes(Buffer.from("123")), false);
  assert.deepEqual(crypto.decrypt("0xabc", encrypted), value);
  assert.equal(crypto.walletTag("0xAbC"), crypto.walletTag("0xabc"));
  assert.notEqual(crypto.walletTag("0xabc"), "0xabc");
  assert.throws(() => crypto.decrypt("0xdef", encrypted));
  assert.throws(() =>
    profileCrypto(randomBytes(32).toString("hex"), "atlas-test").decrypt(
      "0xabc",
      encrypted,
    ),
  );
  const modified = encrypted.slice();
  modified[modified.length - 1]! ^= 1;
  assert.throws(() => crypto.decrypt("0xabc", modified));
  assert.throws(() =>
    profileCrypto(key, "different-app").decrypt("0xabc", encrypted),
  );
});
test("durable World ID claims enforce full-precision uniqueness across processes and representations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-claims-"));
  const file = join(directory, "claims.sqlite");
  try {
    const first = new IdentityClaims(file),
      second = new IdentityClaims(file);
    const max = ((1n << 256n) - 1n).toString(10);
    first.claim(`rp:action:production:${max}`, "0xabc");
    second.claim(`rp:action:production:0x${BigInt(max).toString(16)}`, "0xabc");
    assert.throws(
      () => second.claim(`rp:action:production:${max}`, "0xdef"),
      /already linked/,
    );
    first.close();
    second.close();
    const reopened = new IdentityClaims(file);
    assert.throws(
      () => reopened.claim(`rp:action:production:${max}`, "0xdef"),
      /already linked/,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("Arkiv refuses a signer address that does not match its configured private key", () => {
  const privateKey = generatePrivateKey(),
    other = privateKeyToAccount(generatePrivateKey()).address;
  assert.throws(
    () =>
      new ArkivProfileStore({
        rpcUrl: "https://rpc.rabdi.db-chain.testnet.arkiv.network",
        chainId: 7794095,
        privateKey,
        signerAddress: other,
        encryptionKey: randomBytes(32).toString("hex"),
        namespace: "test",
        claimsFile: "/tmp/atlas-invalid-claims.sqlite",
      }),
    /must match/,
  );
});
