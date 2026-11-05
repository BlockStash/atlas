import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSepoliaWallet,
  parseTestAmount,
} from "../src/lib/transaction-validation";
const address = "0x71F40000000000000000000000000000000092aC";
test("transfer validation refuses mainnet, other networks, disconnected or changed accounts", () => {
  assert.doesNotThrow(() =>
    assertSepoliaWallet("0xaa36a7", [address.toLowerCase()], address),
  );
  for (const chain of ["0x1", "0x89", "0xaa37dc", undefined])
    assert.throws(
      () => assertSepoliaWallet(chain, [address], address),
      /Sepolia/,
    );
  assert.throws(
    () => assertSepoliaWallet("0xaa36a7", [], address),
    /account changed/,
  );
  assert.throws(
    () =>
      assertSepoliaWallet(
        "0xaa36a7",
        ["0x1111111111111111111111111111111111111111"],
        address,
      ),
    /account changed/,
  );
});
test("test ETH amount preserves wei precision and rejects invalid or rounded amounts", () => {
  assert.equal(parseTestAmount("0.001"), 1000000000000000n);
  assert.equal(parseTestAmount("0.000000000000000001"), 1n);
  assert.equal(parseTestAmount("1.123456789123456789"), 1123456789123456789n);
  for (const amount of [
    "0",
    "0.0",
    "-1",
    "1e-3",
    "NaN",
    "Infinity",
    "0.0000000000000000001",
    "",
    "01",
    " 1",
  ])
    assert.throws(() => parseTestAmount(amount));
});

test("ENS registration normalizes labels and rejects subnames or ambiguous registration inputs", async () => {
  const { registrationName } = await import("../src/lib/ens-validation");
  assert.equal(registrationName("ATLAS-Test"), "atlas-test.eth");
  assert.equal(registrationName("atlas-test.eth"), "atlas-test.eth");
  for (const invalid of [
    "ab",
    "a.b.eth",
    "alice.com",
    "-name",
    "name-",
    "name with space",
  ])
    assert.throws(() => registrationName(invalid));
});
