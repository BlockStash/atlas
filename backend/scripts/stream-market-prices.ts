import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RestBudget, twelveRestQuote } from "../src/protocol/twelve-rest.js";
import {
  loadCountryCatalog,
  readCountryManifest,
} from "../src/protocol/country-catalog.js";
import {
  marketFeedConfig,
  MarketFeedCache,
} from "../src/protocol/market-feed.js";

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey)
    throw Error(
      "Set TWELVE_DATA_API_KEY in backend/.env; never put it in frontend variables.",
    );
  const config = marketFeedConfig.parse(
    JSON.parse(
      readFileSync(
        resolve(process.env.MARKET_FEED_CONFIG || "config/market-feed.json"),
        "utf8",
      ),
    ),
  );
  const catalog = await loadCountryCatalog(await readCountryManifest());
  const cache = new MarketFeedCache(config, catalog.stocks);
  const file = resolve(
    process.env.MARKET_FEED_CACHE_FILE || "data/market-feed.json",
  );
  cache.save(file);
  let stopped = false,
    dirty = false;
  const cleanups: (() => void)[] = [];
  const abort = new AbortController();
  const budget = new RestBudget(`${file}.rest-budget.json`);
  const due = new Map<string, number>();
  async function pollRest() {
    while (!stopped) {
      let delay = 9000; // At most 7 requests/minute on the 8-credit Basic plan.
      try {
        const now = Math.floor(Date.now() / 1000);
        const stock = config.stocks.find(
          (s) => (due.get(s.stockId) ?? 0) <= now,
        );
        if (stock) {
          due.set(stock.stockId, now + 600);
          const latest = cache.latest(stock.stockId);
          // A recent WebSocket tick already supplies this instrument.
          if (!latest || now - latest >= 300) {
            if (!budget.take()) {
              console.error(
                "REST daily budget reached or unavailable; WebSocket feeds continue.",
              );
              delay = 15 * 60000;
            } else {
              const result = await twelveRestQuote(
                apiKey!,
                stock,
                abort.signal,
              );
              if (result.rateLimited) {
                console.error(
                  "Twelve Data REST quota reached; pausing REST polling for 15 minutes.",
                );
                delay = 15 * 60000;
              } else {
                if (cache.twelveQuote(result.quote)) dirty = true;
                due.set(
                  stock.stockId,
                  now + (result.quote.is_market_open ? 600 : 3600),
                );
                console.log(
                  `Twelve Data REST: ${stock.symbol} quote received${result.quote.is_market_open ? "" : " (market closed; original timestamp preserved)"}.`,
                );
              }
            }
          }
        }
      } catch {
        if (stopped) return;
        console.error(
          "Twelve Data REST: quote unavailable; check symbol, currency and plan access.",
        );
      }
      try {
        await sleep(delay, undefined, { signal: abort.signal });
      } catch {
        return;
      }
    }
  }
  void pollRest();
  const flush = setInterval(() => {
    if (!dirty) return;
    try {
      cache.save(file);
      dirty = false;
    } catch {
      console.error(
        "Cannot write market feed cache; check the backend data directory.",
      );
    }
  }, 1000);
  function connect(
    name: string,
    url: string,
    subscribe: object,
    accept: (message: unknown) => boolean,
  ) {
    let socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0,
      lastMessage = Date.now(),
      connectedAt = Date.now(),
      lastPriceLog = 0;
    const open = () => {
      if (stopped) return;
      lastMessage = Date.now();
      connectedAt = Date.now();
      const ws = new WebSocket(url);
      socket = ws;
      ws.addEventListener("open", () => {
        console.log(`${name}: connected; requesting subscriptions.`);
        ws.send(JSON.stringify(subscribe));
      });
      ws.addEventListener("message", (event) => {
        lastMessage = Date.now();
        try {
          const message = JSON.parse(String(event.data));
          if (message.event === "subscribe-status") {
            console.log(
              `${name}: ${message.success?.length ?? 0} accepted, ${message.fails?.length ?? 0} rejected subscriptions.`,
            );
            if (message.fails?.length)
              console.error(
                "Twelve Data rejected instruments. Check configured exchange symbols and plan entitlements.",
              );
          }
          if (
            message.event === "error" ||
            message.status === "error" ||
            message.success === false
          )
            console.error(
              `${name}: provider rejected the request. Check account access and configured symbols.`,
            );
          if (accept(message)) {
            if (Date.now() - lastPriceLog > 60000) {
              console.log(`${name}: received a price observation.`);
              lastPriceLog = Date.now();
            }
            dirty = true;
          }
        } catch {
          // Do not log raw responses or WebSocket errors: they may contain credentials.
          console.error(
            `${name}: ignored an invalid or mismatched price message.`,
          );
        }
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        if (Date.now() - connectedAt > 60000) failures = 0;
        const delay = Math.min(30000, 2000 * 2 ** Math.min(failures++, 4));
        console.log(`${name}: disconnected; retrying in ${delay / 1000}s.`);
        retry = setTimeout(open, delay);
      });
    };
    const heartbeat = setInterval(() => {
      if (!socket) return;
      if (Date.now() - lastMessage > 90000) {
        socket.close();
        return;
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify(
            name === "Twelve Data"
              ? { action: "heartbeat" }
              : { method: "ping" },
          ),
        );
    }, 10000);
    cleanups.push(() => {
      clearInterval(heartbeat);
      clearTimeout(retry);
      socket?.close();
    });
    open();
  }
  connect(
    "Twelve Data",
    `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(apiKey)}`,
    { action: "subscribe", params: { symbols: cache.subscriptions() } },
    (message) => cache.twelve(message),
  );
  connect(
    "Kraken",
    "wss://ws.kraken.com/v2",
    {
      method: "subscribe",
      params: { channel: "trade", symbol: ["USDT/USD"], snapshot: true },
    },
    (message) => cache.kraken(message),
  );
  console.log(
    `Streaming ${config.stocks.length} configured stock(s). Cache: ${file}. No transactions are sent by this process.`,
  );
  const stop = () => {
    stopped = true;
    abort.abort();
    clearInterval(flush);
    for (const cleanup of cleanups) cleanup();
    if (dirty) cache.save(file);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(() => {
  // Startup failures can include key-bearing provider URLs; expose only safe configuration guidance.
  console.error(
    "Market feed could not start. Check TWELVE_DATA_API_KEY, MARKET_FEED_CONFIG and the v2 deployment/RPC configuration.",
  );
  process.exitCode = 1;
});
