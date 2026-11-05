import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";

export interface ArkivConnectionOptions {
  rpcUrl?: string;
  accessKey?: string;
}

export function arkivConnection(options: ArkivConnectionOptions) {
  const configured = options.rpcUrl?.trim();
  const url = configured ? new URL(configured) : undefined;
  const official =
    url?.origin === "https://rpc.rabdi.db-chain.testnet.arkiv.network";
  // Accept either an access key or an explicitly keyed official RPC URL.
  const embeddedKey =
    official && url.pathname !== "/"
      ? decodeURIComponent(url.pathname.slice(1))
      : "";
  const chain = rabdi({ accessKey: options.accessKey?.trim() || embeddedKey });
  // .env.example contains the bare public URL. Do not let that override the
  // authenticated chain URL when an access key is configured.
  const rpcUrl =
    !configured || (official && url.pathname === "/" && !url.search)
      ? chain.rpcUrls.default.http[0]
      : configured;
  return {
    chain,
    // Login performs chain identification + one profile query. Keep both
    // bounded below the frontend proxy timeout; do not multiply waits via retries.
    transport: http(rpcUrl, { timeout: 6000, retryCount: 0 }),
  };
}
