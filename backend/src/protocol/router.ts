import { Router } from "express";
import { resolve } from "node:path";
import { z } from "zod";
import catalog from "./catalog.json" with { type: "json" };
import { PriceHistoryStore } from "./price-service.js";
import { readCountryManifest, loadCountryCatalog } from "./country-catalog.js";
import { observePrice } from "./observe-prices.js";
import { referencePrices } from "./market-feed.js";
import {
  MarketStatusService,
  readSessionSnapshot,
  stockMarketStatus,
} from "./stock-sessions.js";
export function protocolRouter() {
  const router = Router();
  let history: PriceHistoryStore | undefined;
  const marketStatus = new MarketStatusService();
  router.get("/stock-sessions", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const data = readSessionSnapshot();
      const status = await marketStatus.snapshot();
      res.json({
        ...data,
        stocks: data.stocks.map((s) => ({
          ...s,
          market: stockMarketStatus(s.exchange, status),
        })),
      });
    } catch {
      res
        .status(503)
        .json({
          error: {
            code: "SESSION_REFERENCES_UNAVAILABLE",
            message: "Historical stock references are temporarily unavailable.",
          },
        });
    }
  });
  router.get("/market-prices", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json({
        prices: referencePrices(
          resolve(
            process.env.MARKET_FEED_CACHE_FILE || "data/market-feed.json",
          ),
        ),
      });
    } catch {
      res.json({
        prices: [],
        warning:
          "Provider reference prices are unavailable. Check the price-feed worker.",
      });
    }
  });
  router.get("/config", async (_req, res) => {
    try {
      const config = await readCountryManifest();
      res
        .set("Cache-Control", "no-store")
        .json({ configured: true, ...config });
    } catch {
      res.json({
        configured: false,
        chainId: 11155111,
        message:
          "Atlas protocol contracts have not been configured for Sepolia. Deploy the five country markets and select the v2 deployment manifest.",
      });
    }
  });
  router.get("/catalog", async (_req, res) => {
    let manifest;
    try {
      manifest = await readCountryManifest();
    } catch {
      res.json({ ...catalog, configured: false });
      return;
    }
    res.json({ ...(await loadCountryCatalog(manifest)), configured: true });
  });
  router.get("/history/:stockId", async (req, res) => {
    const id = z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .parse(req.params.stockId);
    history ??= new PriceHistoryStore(
      resolve(process.env.PRICE_HISTORY_FILE || "data/prices.sqlite"),
    );
    let observationWarning: string | undefined;
    let manifest;
    try {
      manifest = await readCountryManifest();
    } catch {
      /* Stored history is available before deployment too. */
    }
    if (manifest)
      try {
        await observePrice(manifest, id, history);
      } catch {
        observationWarning =
          "Could not refresh the latest onchain observation; showing stored history.";
      }
    res.json({
      observationWarning,
      scale: "100000000",
      history: history.history(id, Number(req.query.limit) || 100),
    });
  });
  return router;
}
