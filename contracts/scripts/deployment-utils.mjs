// Retry only gas estimation: a submitted transaction must never be retried here.
export async function estimateDeployment(
  provider,
  transaction,
  {
    attempts = 4,
    delayMs = 2000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {},
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.estimateGas(transaction);
    } catch (error) {
      if (error.code !== "CALL_EXCEPTION" || attempt >= attempts) throw error;
      onRetry(attempt);
      await sleep(delayMs);
    }
  }
}

export function deploymentError(error) {
  const selector =
    typeof error.data === "string" ? error.data.slice(0, 10) : null;
  if (selector === "0xa790f950")
    return "InvalidSettlementToken(): the vault could not see a deployed six-decimal settlement token. Check the token address and RPC synchronization, then rerun with the existing checkpoint.";
  return (
    error.shortMessage || error.reason || error.message || "Deployment failed."
  );
}

export async function sendSetupTransaction(
  provider,
  contract,
  from,
  method,
  args = [],
  options = {},
) {
  const {
    onSubmitted = () => {},
    onConfirmed = () => {},
    ...estimateOptions
  } = options;
  const fn = contract.getFunction(method);
  const request = await fn.populateTransaction(...args);
  const gasLimit = await estimateDeployment(
    provider,
    { ...request, from },
    estimateOptions,
  );
  const transaction = await fn(...args, { gasLimit });
  onSubmitted(transaction.hash);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error("Deployment transaction reverted.");
  onConfirmed(receipt);
  return receipt;
}

// Keep market status below the one-day upper boundary even when RPC heads differ.
export const marketExpiry = (timestamp) => timestamp + 23 * 3600;
