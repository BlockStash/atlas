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
  const message =
    error.shortMessage || error.reason || error.message || "Deployment failed.";
  const upstream = error.info?.error?.message;
  return upstream && !message.includes(upstream)
    ? `${message}: ${upstream}`
    : message;
}

// RPC estimates can understate proxy calls. Verify a padded budget with eth_call
// and increase it only after a larger simulation proves the operation can succeed.
// This never broadcasts or retries an already submitted transaction.
export async function deploymentGasLimit(provider, transaction, options = {}) {
  const {
    maxGasLimit: requestedCeiling,
    onGasIncrease = () => {},
    ...estimateOptions
  } = options;
  const block = await provider.getBlock("latest");
  if (!block || block.gasLimit <= 0n)
    throw new Error("Could not read the current block gas allowance.");
  // Current Sepolia meters state creation separately from execution gas. A
  // transaction's total budget can exceed the old 2^24 execution-gas ceiling.
  // Keep an application ceiling and never exceed the live block allowance.
  const applicationCeiling = requestedCeiling ?? 50000000n;
  const maxGasLimit =
    block.gasLimit < applicationCeiling ? block.gasLimit : applicationCeiling;
  const estimate = await estimateDeployment(
    provider,
    transaction,
    estimateOptions,
  );
  if (estimate <= 0n || maxGasLimit <= 0n)
    throw new Error("Invalid deployment gas budget.");
  const padded = (estimate * 125n + 99n) / 100n;
  let limit = padded < maxGasLimit ? padded : maxGasLimit;
  try {
    await provider.call({ ...transaction, gasLimit: limit });
    return limit;
  } catch (initialError) {
    if (limit === maxGasLimit) throw initialError;
    // Decoded revert data is a contract validation failure, not out-of-gas.
    if (typeof initialError.data === "string" && initialError.data.length > 2)
      throw initialError;
    while (limit < maxGasLimit) {
      limit = limit * 2n < maxGasLimit ? limit * 2n : maxGasLimit;
      onGasIncrease(limit);
      try {
        await provider.call({ ...transaction, gasLimit: limit });
        return limit;
      } catch (error) {
        if (limit === maxGasLimit) throw error;
      }
    }
    throw initialError;
  }
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
  const gasLimit = await deploymentGasLimit(
    provider,
    { ...request, from },
    estimateOptions,
  );
  const transaction = await fn(...args, { gasLimit });
  onSubmitted(transaction.hash);
  let receipt;
  try {
    receipt = await transaction.wait();
  } catch (error) {
    const details = error.receipt
      ? ` Gas used: ${error.receipt.gasUsed}/${gasLimit}.`
      : "";
    throw new Error(
      `${method}: ${transaction.hash} failed or was not confirmed.${details} ${deploymentError(error)}`,
    );
  }
  if (receipt.status !== 1) throw new Error("Deployment transaction reverted.");
  onConfirmed(receipt);
  return receipt;
}

// Keep market status below the one-day upper boundary even when RPC heads differ.
export const marketExpiry = (timestamp) => timestamp + 23 * 3600;
