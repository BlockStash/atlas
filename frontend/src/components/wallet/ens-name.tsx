"use client";
import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { useAtlas } from "@/components/atlas/provider";
import { lookupPrimaryName, resolveRecipient } from "@/lib/ens";
import { shortAddress } from "@/lib/data";
export function ENSName({ address }: { address: string }) {
  const { state } = useAtlas();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setName(null);
    if (isAddress(address))
      (state.ensName
        ? resolveRecipient(state.ensName).then((result) =>
            result.address.toLowerCase() === address.toLowerCase()
              ? result.name
              : lookupPrimaryName(address),
          )
        : lookupPrimaryName(address)
      )
        .then((n) => {
          if (active) setName(n);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [address, state.ensName]);
  return (
    <span title={`${name ? `${name} · ` : ""}${address} · Sepolia ENS`}>
      {name || shortAddress(address)}
    </span>
  );
}
