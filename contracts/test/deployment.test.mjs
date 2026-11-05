import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateDeployment,
  deploymentError,
  sendSetupTransaction,
  marketExpiry,
} from "../scripts/deployment-utils.mjs";

test("market expiry leaves headroom for RPC block timestamp skew", () => {
  const head = 1800000000;
  assert.ok(marketExpiry(head) < head + 86400);
  assert.ok(marketExpiry(head) <= head - 120 + 86400);
  assert.ok(marketExpiry(head) > head + 120);
});

test("setup transactions estimate before sending and retry only estimates", async () => {
  let estimates = 0,
    sends = 0;
  const fn = async (...args) => {
    sends++;
    assert.deepEqual(args, ["region", { gasLimit: 200000n }]);
    return { wait: async () => ({ status: 1 }) };
  };
  fn.populateTransaction = async (...args) => {
    assert.deepEqual(args, ["region"]);
    return { data: "0x1234" };
  };
  const provider = {
    async estimateGas(tx) {
      assert.equal(tx.from, "deployer");
      assert.equal(tx.data, "0x1234");
      if (++estimates < 3)
        throw Object.assign(new Error("RPC lag"), { code: "CALL_EXCEPTION" });
      return 200000n;
    },
  };
  await sendSetupTransaction(
    provider,
    { getFunction: () => fn },
    "deployer",
    "setMarket",
    ["region"],
    { sleep: async () => {} },
  );
  assert.equal(estimates, 3);
  assert.equal(sends, 1);
});

test("a failed send or receipt never triggers duplicate submission", async () => {
  for (const phase of ["send", "receipt"]) {
    let sends = 0;
    const fn = async () => {
      sends++;
      if (phase === "send") throw new Error("send failed");
      return {
        wait: async () => {
          throw new Error("receipt failed");
        },
      };
    };
    fn.populateTransaction = async () => ({ data: "0x1234" });
    await assert.rejects(
      sendSetupTransaction(
        { estimateGas: async () => 100n },
        { getFunction: () => fn },
        "deployer",
        "grantRole",
      ),
      /failed/,
    );
    assert.equal(sends, 1);
  }
});

test("deployment estimation recovers from temporary RPC state lag without submitting", async () => {
  let calls = 0;
  const waits = [];
  const provider = {
    async estimateGas(request) {
      assert.equal(request.from, "deployer");
      if (++calls < 3)
        throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION" });
      return 2000000n;
    },
  };
  assert.equal(
    await estimateDeployment(
      provider,
      { from: "deployer" },
      { sleep: async (ms) => waits.push(ms) },
    ),
    2000000n,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test("persistent constructor rejection stops after the bounded attempts", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("invalid token"), {
    code: "CALL_EXCEPTION",
    data: "0xa790f950",
  });
  await assert.rejects(
    estimateDeployment(
      {
        async estimateGas() {
          calls++;
          throw failure;
        },
      },
      {},
      { sleep: async () => {} },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 4);
  assert.match(deploymentError(failure), /InvalidSettlementToken/);
});

test("non-revert errors stop immediately", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("insufficient funds"), {
    code: "INSUFFICIENT_FUNDS",
  });
  await assert.rejects(
    estimateDeployment(
      {
        async estimateGas() {
          calls++;
          throw failure;
        },
      },
      {},
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});
