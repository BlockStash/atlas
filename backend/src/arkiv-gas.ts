import {
  createWalletClient,
  type PublicArkivClient,
  type TxParams,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { custom, type Chain, type LocalAccount, type Transport } from "viem";

/**
 * Gas guard for Arkiv writes on Rabdi.
 *
 * Rabdi gas estimates can come out too low, and the SDK only adds 25% headroom. Arkiv's
 * known-issues guidance for SDK 1.0.1 requires, before every signature for N operations:
 *
 *   gas >= max(1_000_000 + 400_000 × (N − 1), 2 × estimate at latest)
 *   gas <= latest block gasLimit / 2
 *
 * with a fresh `latest` nonce and the current gasPrice, and no automatic resend.
 *
 * The SDK's operation encoders are internal, so the exact calldata is estimated by a dry run of
 * the same SDK call: a probe client forwards reads, captures the SDK's own `eth_estimateGas`
 * result and aborts before anything is signed. The real call then runs with explicit
 * `{ gas, nonce, gasPrice }`, so the SDK skips its own estimate. The SDK waits for the receipt
 * and throws on `status: "reverted"`, including out-of-gas.
 */

/** Fixed, non-sensitive failure reasons. Never carries provider text, which can contain the keyed RPC URL. */
export class ArkivGasGuardError extends Error {
  override name = "ArkivGasGuardError";
}

class EstimateCaptured extends Error {}

/** Default ceiling for one write's maximum fee: 0.02 tGLM (15M gas at 1 gwei is 0.015). */
export const DEFAULT_MAX_TX_FEE_WEI = 20_000_000_000_000_000n;

export const gasFloor = (operations: number) =>
  1_000_000n + 400_000n * BigInt(Math.max(1, operations) - 1);

/** Pure bound check, exported for tests. */
export function guardedGas(
  estimate: bigint,
  operations: number,
  blockGasLimit: bigint,
) {
  if (estimate <= 0n)
    throw new ArkivGasGuardError("Arkiv gas estimate was not positive.");
  const floor = gasFloor(operations),
    doubled = estimate * 2n,
    gas = doubled > floor ? doubled : floor;
  if (blockGasLimit <= 0n || gas * 2n > blockGasLimit)
    throw new ArkivGasGuardError(
      "Arkiv write needs more than half the block gas limit; split the batch.",
    );
  return gas;
}

export function arkivGasGuard(options: {
  chain: Chain;
  transport: Transport;
  account: LocalAccount;
  publicClient: PublicArkivClient;
  maxFeeWei?: bigint;
}) {
  const { chain, transport, account, publicClient } = options;
  const maxFeeWei = options.maxFeeWei ?? DEFAULT_MAX_TX_FEE_WEI;
  const rpc = transport({ chain, retryCount: 0 });

  /** Runs `write` against a probe client and returns the SDK's raw estimate for its calldata. */
  async function estimate(
    write: (client: WalletArkivClient) => Promise<unknown>,
  ): Promise<bigint> {
    let captured: bigint | undefined;
    const probe = createWalletClient({
      chain,
      account,
      transport: custom(
        {
          async request({ method, params }) {
            if (
              method === "eth_sendRawTransaction" ||
              method === "eth_sendTransaction"
            )
              throw new ArkivGasGuardError(
                "Gas probe attempted to send a transaction.",
              );
            const result = await rpc.request({ method, params });
            if (method === "eth_estimateGas") {
              captured = BigInt(result as string);
              throw new EstimateCaptured();
            }
            return result;
          },
        },
        { retryCount: 0 },
      ),
    });
    try {
      await write(probe);
    } catch (error) {
      if (captured === undefined) throw error; // Validation or simulation failure: surface it.
    }
    if (captured === undefined)
      throw new ArkivGasGuardError("Arkiv gas estimate was unavailable.");
    return captured;
  }

  return {
    /**
     * Estimate, bound and send one Arkiv transaction carrying `operations` operations.
     * `write` must issue exactly one SDK write call with the given client and txParams.
     * Never retried: a failure after submission must be reconciled, not resent.
     */
    async send<T>(
      operations: number,
      client: WalletArkivClient,
      write: (client: WalletArkivClient, txParams?: TxParams) => Promise<T>,
    ): Promise<T> {
      const raw = await estimate((probe) => write(probe));
      const head = await publicClient.getBlock({ blockTag: "latest" });
      const gas = guardedGas(raw, operations, head.gasLimit);
      const [nonce, gasPrice, balance] = await Promise.all([
        publicClient.getTransactionCount({
          address: account.address,
          blockTag: "latest",
        }),
        rpc
          .request({ method: "eth_gasPrice" })
          .then((value) => BigInt(value as string)),
        publicClient.getBalance({
          address: account.address,
          blockTag: "latest",
        }),
      ]);
      if (gasPrice <= 0n)
        throw new ArkivGasGuardError("Arkiv gas price was not positive.");
      const maxFee = gas * gasPrice;
      if (maxFee > maxFeeWei)
        throw new ArkivGasGuardError(
          "Arkiv write exceeds ARKIV_MAX_TX_FEE_WEI; raise the cap or reduce the payload.",
        );
      if (balance < maxFee)
        throw new ArkivGasGuardError(
          "Arkiv signer balance cannot cover the maximum fee; fund it with Rabdi tGLM.",
        );
      return write(client, { gas, nonce, gasPrice });
    },
  };
}
