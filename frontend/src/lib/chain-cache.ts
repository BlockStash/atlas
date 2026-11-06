/**
 * Per-wallet session cache for data read from Sepolia.
 *
 * Values live in sessionStorage, so they survive page navigation and refreshes in the same tab
 * and are dropped when the tab closes or the user logs out. Pages render the cached value
 * immediately and then refresh it from the chain (stale-while-revalidate). BigInts are kept
 * intact through serialization. Storage failures are ignored: the page just reads the chain.
 */
const PREFIX = "atlas_chain_cache:";

type Entry<T> = { savedAt: number; value: T };

const keyFor = (kind: string, address: string) =>
  `${PREFIX}${kind}:${address.toLowerCase()}`;

function replacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { __bigint: value.toString() } : value;
}
function reviver(_key: string, value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "__bigint" in value &&
    typeof (value as { __bigint: unknown }).__bigint === "string"
  )
    return BigInt((value as { __bigint: string }).__bigint);
  return value;
}

export function readChainCache<T>(
  kind: string,
  address: string | undefined | null,
): Entry<T> | null {
  if (!address) return null;
  try {
    const raw = sessionStorage.getItem(keyFor(kind, address));
    if (!raw) return null;
    const entry = JSON.parse(raw, reviver) as Entry<T>;
    return entry && typeof entry.savedAt === "number" ? entry : null;
  } catch {
    return null;
  }
}

export function writeChainCache<T>(
  kind: string,
  address: string | undefined | null,
  value: T,
) {
  if (!address) return;
  try {
    sessionStorage.setItem(
      keyFor(kind, address),
      JSON.stringify({ savedAt: Date.now(), value }, replacer),
    );
  } catch {
    /* Storage full or blocked: the next page load reads the chain again. */
  }
}

/** Removes every cached chain read (all wallets). Called on logout. */
export function clearChainCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {}
}
