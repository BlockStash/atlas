import "dotenv/config";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readSessionSnapshot } from "../src/protocol/stock-sessions.js";
import { historicalDevelopmentMode } from "../src/protocol/historical-development.js";
import {
  sourceUrl,
  publicText,
  robotsAllow,
  parseHistory,
  normalizeHistoricalRows,
} from "../src/protocol/historical-scraper.js";
import { processLock } from "../src/protocol/process-lock.js";
async function refresh() {
  if (!historicalDevelopmentMode())
    throw Error(
      "Reference scraping is enabled only in explicit historical development mode.",
    );
  const file = resolve(
    process.env.WEB_REFERENCE_FILE || "config/web-market-reference.json",
  );
  const data = readSessionSnapshot(file);
  const robots = await publicText(
    "https://stockanalysis.com/robots.txt",
    false,
  );
  const pages: {
    reference: (typeof data.stocks)[number];
    rows: ReturnType<typeof parseHistory>;
  }[] = [];
  for (const reference of data.stocks) {
    const url = sourceUrl(reference.sourceUrl);
    if (!robotsAllow(robots, url.pathname))
      throw Error(
        "The source's crawling rules do not allow a configured historical page.",
      );
    const rows = parseHistory(await publicText(url.href), reference);
    pages.push({ reference, rows });
    console.log(
      `Historical source checked: ${reference.region}/${reference.ticker}`,
    );
    await sleep(2000);
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = pages[0]?.rows.find(
    (r) =>
      r.date < today &&
      pages.every((p) =>
        p.rows.some((v, i) => v.date === r.date && i + 1 < p.rows.length),
      ),
  )?.date;
  if (!date || data.stocks.some((s) => date < s.sessionDate))
    throw Error(
      "No newer complete common session is available. Saved historical prices were retained.",
    );
  const next = {
    ...data,
    retrievedAt: new Date().toISOString(),
    method:
      "Public historical table refresh; fixed development reference, not live prices.",
    stocks: pages.map((p) =>
      normalizeHistoricalRows(p.reference, p.rows, date),
    ),
  };
  const fxFile = resolve(
    process.env.FX_REFERENCE_FILE || "config/fx-reference.json",
  );
  let fx = JSON.parse(readFileSync(fxFile, "utf8"));
  if (fx.date !== date) {
    const url = `https://api.frankfurter.dev/v2/rates?base=USD&quotes=INR,GBP,SGD,EUR&date=${date}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok)
      throw Error("Matching dated FX is unavailable; retaining saved prices.");
    const rows = (await response.json()) as {
      date: string;
      base: string;
      quote: string;
      rate: number;
    }[];
    const nativePerUSD: Record<string, string> = { USD: "1" };
    for (const row of rows)
      if (
        row.date === date &&
        row.base === "USD" &&
        ["INR", "GBP", "SGD", "EUR"].includes(row.quote) &&
        Number.isFinite(row.rate) &&
        row.rate > 0
      )
        nativePerUSD[row.quote] = row.rate.toFixed(8);
    if (Object.keys(nativePerUSD).length !== 5)
      throw Error("FX response does not cover the stock session.");
    fx = {
      date,
      base: "USD",
      source: "Frankfurter daily reference rates",
      sourceUrl: url,
      nativePerUSD,
    };
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n");
    readSessionSnapshot(temporary); // Validate every listing and unit conversion before replacing anything.
    writeFileSync(`${fxFile}.tmp`, JSON.stringify(fx, null, 2) + "\n");
    renameSync(`${fxFile}.tmp`, fxFile);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
  console.log(
    `Saved ${next.stocks.length} historical references for ${date}. Original session dates are retained.`,
  );
}
async function main() {
  if (
    !processLock(resolve("data/historical-refresh.lock"), "Historical refresh")
  )
    return;
  do {
    const recent =
      Date.now() - Date.parse(readSessionSnapshot().retrievedAt) < 20 * 3600000;
    if (process.argv.includes("--watch") && recent) {
      await sleep(3600000);
      continue;
    }
    try {
      await refresh();
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "Historical refresh failed; retaining saved prices.",
      );
      if (!process.argv.includes("--watch")) {
        process.exitCode = 1;
        return;
      }
    }
    if (!process.argv.includes("--watch")) return;
    await sleep(86400000);
  } while (true);
}
void main();
