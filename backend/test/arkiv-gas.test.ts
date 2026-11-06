import { test } from "node:test";
import assert from "node:assert/strict";
import { custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rabdi } from "@arkiv-network/sdk/chains";
import type { PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk";
import {
  arkivGasGuard,
  ArkivGasGuardError,
  gasFloor,
  guardedGas,
} from "../src/arkiv-gas.js";

test("gas floor grows by 400k per extra operation", () => {
  assert.equal(gasFloor(1), 1_000_000n);
  assert.equal(gasFloor(2), 1_400_000n);
  assert.equal(gasFloor(3), 1_800_000n);
});

test("guarded gas is max(floor, 2 × estimate) and at most half a block", () => {
  assert.equal(guardedGas(100_000n, 1, 30_000_000n), 1_000_000n);
  assert.equal(guardedGas(900_000n, 2, 30_000_000n), 1_800_000n);
  assert.equal(guardedGas(7_500_000n, 1, 30_000_000n), 15_000_000n);
  assert.throws(
    () => guardedGas(7_500_001n, 1, 30_000_000n),
    ArkivGasGuardError,
  );
  assert.throws(() => guardedGas(0n, 1, 30_000_000n), ArkivGasGuardError);
});

function fakes(overrides: { gasPrice?: bigint; balance?: bigint } = {}) {
  const calls: string[] = [];
  const transport = custom({
    async request({ method }: { method: string }) {
      calls.push(method);
      if (method === "eth_estimateGas") return "0x927c0"; // 600_000
      if (method === "eth_gasPrice")
        return `0x${(overrides.gasPrice ?? 1_000_000_000n).toString(16)}`;
      if (method === "eth_chainId") return "0x76edaf";
      throw new Error(`unexpected ${method}`);
    },
  });
  const publicClient = {
    getBlock: async () => ({ gasLimit: 30_000_000n }),
    getTransactionCount: async () => 7,
    getBalance: async () => overrides.balance ?? 10n ** 19n,
  } as unknown as PublicArkivClient;
  return { calls, transport, publicClient };
}

test("send estimates via a probe, then writes once with explicit gas, nonce and gasPrice", async () => {
  const { calls, transport, publicClient } = fakes();
  const account = privateKeyToAccount(generatePrivateKey());
  const guard = arkivGasGuard({
    chain: rabdi({ accessKey: "" }),
    transport,
    account,
    publicClient,
  });
  const real = { real: true } as unknown as WalletArkivClient;
  let probeRuns = 0;
  const sent: unknown[] = [];
  const result = await guard.send(2, real, async (client, txParams) => {
    if (client !== real) {
      probeRuns++;
      // What the SDK does internally before sending.
      await client.request({
        method: "eth_estimateGas",
        params: [{}],
      } as never);
      throw new Error("unreachable: probe must stop at the estimate");
    }
    sent.push(txParams);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(probeRuns, 1);
  assert.deepEqual(sent, [
    { gas: 1_400_000n, nonce: 7, gasPrice: 1_000_000_000n },
  ]);
  assert.ok(!calls.includes("eth_sendRawTransaction"));
});

test("send refuses a write above the fee cap or the signer balance", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const write = async (client: WalletArkivClient) => {
    await client.request({ method: "eth_estimateGas", params: [{}] } as never);
    return "sent";
  };
  const real = {} as WalletArkivClient;
  const capped = fakes({ gasPrice: 100_000_000_000n }); // 1.2M gas × 100 gwei = 0.12 tGLM
  await assert.rejects(
    arkivGasGuard({ chain: rabdi({ accessKey: "" }), account, ...capped }).send(
      1,
      real,
      write,
    ),
    /ARKIV_MAX_TX_FEE_WEI/,
  );
  const poor = fakes({ balance: 1n });
  await assert.rejects(
    arkivGasGuard({ chain: rabdi({ accessKey: "" }), account, ...poor }).send(
      1,
      real,
      write,
    ),
    /balance/,
  );
});

test("send surfaces errors raised before any estimate", async () => {
  const { transport, publicClient } = fakes();
  const guard = arkivGasGuard({
    chain: rabdi({ accessKey: "" }),
    transport,
    account: privateKeyToAccount(generatePrivateKey()),
    publicClient,
  });
  await assert.rejects(
    guard.send(1, {} as WalletArkivClient, async () => {
      throw new Error("schema validation failed");
    }),
    /schema validation failed/,
  );
});
