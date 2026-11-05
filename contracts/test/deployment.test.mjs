import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateDeployment,
  deploymentGasLimit,
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
    assert.deepEqual(args, ["region", { gasLimit: 250000n }]);
    return { wait: async () => ({ status: 1 }) };
  };
  fn.populateTransaction = async (...args) => {
    assert.deepEqual(args, ["region"]);
    return { data: "0x1234" };
  };
  const provider = {
    getBlock: async () => ({ gasLimit: 30000000n }),
    async call(tx) {
      assert.equal(tx.gasLimit, 250000n);
      return "0x";
    },
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
        {
          getBlock: async () => ({ gasLimit: 30000000n }),
          estimateGas: async () => 100n,
          call: async () => "0x",
        },
        { getFunction: () => fn },
        "deployer",
        "grantRole",
      ),
      /failed/,
    );
    assert.equal(sends, 1);
  }
});

test("underestimated proxy gas is increased and simulated before a transaction is sent", async () => {
  const simulations = [];
  const provider = {
    getBlock: async () => ({ gasLimit: 30000000n }),
    estimateGas: async () => 100n,
    call: async (tx) => {
      simulations.push(tx.gasLimit);
      if (tx.gasLimit < 450n)
        throw Object.assign(new Error("out of gas"), {
          code: "CALL_EXCEPTION",
          data: "0x",
        });
      return "0x";
    },
  };
  const gas = await deploymentGasLimit(
    provider,
    { to: "proxy", data: "0x1234" },
    { maxGasLimit: 1000n },
  );
  assert.equal(gas, 500n);
  assert.deepEqual(simulations, [125n, 250n, 500n]);
});

test("real validation failures remain failures even with a larger gas allowance", async () => {
  const failure = Object.assign(new Error("DuplicateStock"), {
    code: "CALL_EXCEPTION",
    data: "0xduplicate",
  });
  let calls = 0;
  await assert.rejects(
    deploymentGasLimit(
      {
        getBlock: async () => ({ gasLimit: 30000000n }),
        estimateGas: async () => 100n,
        call: async () => {
          calls++;
          throw failure;
        },
      },
      {},
      { maxGasLimit: 1000n },
    ),
    (e) => e === failure,
  );
  assert.equal(calls, 1);
});

test("padded gas never exceeds the configured ceiling", async () => {
  let budget;
  assert.equal(
    await deploymentGasLimit(
      {
        getBlock: async () => ({ gasLimit: 30000000n }),
        estimateGas: async () => 950n,
        call: async (tx) => {
          budget = tx.gasLimit;
          return "0x";
        },
      },
      {},
      { maxGasLimit: 1000n },
    ),
    1000n,
  );
  assert.equal(budget, 1000n);
});

test("state-creation transactions can use a verified total budget above 16M", async () => {
  let verified;
  const gas = await deploymentGasLimit(
    {
      getBlock: async () => ({ gasLimit: 200000000n }),
      estimateGas: async () => 17673991n,
      call: async (tx) => {
        verified = tx.gasLimit;
        if (tx.gasLimit < 17673991n) throw new Error("out of gas");
        return "0x";
      },
    },
    {},
  );
  assert.equal(gas, 22092489n);
  assert.equal(verified, gas);
});

test("default gas budget is bounded by the current block allowance", async () => {
  const gas = await deploymentGasLimit(
    {
      getBlock: async () => ({ gasLimit: 18000000n }),
      estimateGas: async () => 16000000n,
      call: async (tx) => {
        assert.ok(tx.gasLimit <= 18000000n);
        return "0x";
      },
    },
    {},
  );
  assert.equal(gas, 18000000n);
});

test("node errors include the upstream reason instead of only missing revert data", () => {
  assert.match(
    deploymentError({
      shortMessage: "missing revert data",
      info: {
        error: { message: "out of gas: gas required exceeds: 16000000" },
      },
    }),
    /gas required exceeds/,
  );
});

test("deployment estimation recovers from temporary RPC state lag without submitting", async () => {
  let calls = 0;
  const waits = [];
  const provider = {
    getBlock: async () => ({ gasLimit: 30000000n }),
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
