import { defaultProfile, type Profile, type MarketId } from "./types.js";
export function normalizeProfile(
  address: string,
  profile?: Partial<Profile>,
): Profile {
  const markets = [
    ...new Set(
      (profile?.selectedMarkets || ["india"])
        .map((id) => (String(id) === "china" ? "singapore" : id))
        .filter((id) =>
          ["india", "usa", "uk", "singapore", "europe", "crypto"].includes(id),
        ),
    ),
  ] as MarketId[];
  return {
    ...defaultProfile(address),
    ...profile,
    selectedMarkets: markets.length ? markets : ["india"],
    walletAddress: address,
  };
}
