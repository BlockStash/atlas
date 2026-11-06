import { load } from "cheerio";
import { formatUnits } from "viem";
import { scaledPrice } from "./price-service.js";
import { readSessionSnapshot } from "./stock-sessions.js";
export type SessionRow = ReturnType<
  typeof readSessionSnapshot
>["stocks"][number];
const agent = "AtlasDevelopmentReference/0.1";
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
export function sourceUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "stockanalysis.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:stocks\/[a-z0-9.-]+|quote\/[a-z]+\/[A-Za-z0-9.-]+)\/history\/$/.test(
      url.pathname,
    )
  )
    throw Error(
      "Only the saved public Stock Analysis history pages are supported.",
    );
  return url;
}
export function robotsAllow(robots: string, path: string) {
  const groups = robots.split(/\n\s*\n/).map((group) =>
    group
      .split("\n")
      .map((l) => l.split("#")[0]!.trim())
      .filter(Boolean),
  );
  const specific = groups.filter((g) =>
    g.some((l) => /^user-agent:\s*atlasdevelopmentreference/i.test(l)),
  );
  const selected = specific.length
    ? specific
    : groups.filter((g) => g.some((l) => /^user-agent:\s*\*$/i.test(l)));
  const rules = selected
    .flatMap((g) =>
      g.flatMap((l) => {
        const m = /^(allow|disallow):\s*(\S+)/i.exec(l);
        if (!m) return [];
        const pattern = m[2]!
          .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*");
        return new RegExp(`^${pattern}`).test(path)
          ? [{ allow: m[1]!.toLowerCase() === "allow", length: m[2]!.length }]
          : [];
      }),
    )
    .sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return !rules.length || rules[0]!.allow;
}
export async function publicText(url: string, html = true) {
  const response = await fetch(url, {
    headers: { "User-Agent": agent, Accept: html ? "text/html" : "text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      `Public source returned HTTP ${response.status}; keeping the saved snapshot.`,
    );
  const text = await response.text();
  if (Buffer.byteLength(text) > 2_000_000)
    throw Error("Source document exceeds the expected size.");
  if (html && !response.headers.get("content-type")?.includes("text/html"))
    throw Error("Source did not return HTML.");
  return text;
}
export function parseHistory(html: string, reference: SessionRow) {
  const $ = load(html);
  const title = $("title").text();
  const ticker = reference.ticker
    .replace(/\.$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(?:\\(|:)${ticker}\\)`, "i").test(title))
    throw Error(`Listing identity mismatch for ${reference.ticker}.`);
  const text = clean($("body").text());
  const currency =
    /Currency is ([A-Z]{3})/.exec(text)?.[1] ??
    (/\b(?:Real-Time|Delayed) Price\s*·\s*USD\b/.test(text)
      ? "USD"
      : undefined);
  const unit = /Price in ([A-Z]{3})/.exec(text)?.[1] ?? currency;
  if (currency !== reference.currency || unit !== reference.sourceUnit)
    throw Error(`Quote currency/unit changed for ${reference.ticker}.`);
  const table = $("table")
    .filter(
      (_, e) =>
        $(e)
          .find("thead th")
          .map((_, h) => clean($(h).text()))
          .get()
          .slice(0, 5)
          .join("|") === "Date|Open|High|Low|Close",
    )
    .first();
  if (!table.length)
    throw Error(
      `Historical price columns are unavailable for ${reference.ticker}.`,
    );
  const rows = table
    .find("tbody tr")
    .toArray()
    .map((tr) => {
      const cells = $(tr)
        .find("td")
        .map((_, td) => clean($(td).text()))
        .get();
      if (!cells.length) return null;
      if (!/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(cells[0]!))
        throw Error("Unexpected historical date format.");
      const date = new Date(`${cells[0]} 00:00:00 UTC`)
        .toISOString()
        .slice(0, 10);
      const open = cells[1]!.replaceAll(",", ""),
        close = cells[4]!.replaceAll(",", "");
      scaledPrice(open);
      scaledPrice(close);
      return { date, open, close };
    })
    .filter((r) => r !== null);
  if (
    rows.length < 2 ||
    rows.some((row, i) => i > 0 && row.date >= rows[i - 1]!.date)
  )
    throw Error("Historical rows must be distinct and descending.");
  return rows;
}
export function normalizeHistoricalRows(
  reference: SessionRow,
  rows: ReturnType<typeof parseHistory>,
  date: string,
): SessionRow {
  const i = rows.findIndex((r) => r.date === date),
    current = rows[i],
    previous = rows[i + 1];
  if (i < 0 || !current || !previous)
    throw Error(
      `Missing a completed session and preceding close for ${reference.ticker}.`,
    );
  const value = (v: string) =>
    formatUnits(
      scaledPrice(v) / (reference.sourceUnit === "GBX" ? 100n : 1n),
      8,
    );
  return {
    ...reference,
    sessionDate: current.date,
    sessionOpen: value(current.open),
    sessionClose: value(current.close),
    previousSessionDate: previous.date,
    previousClose: value(previous.close),
    sourceSessionOpen: current.open,
    sourceSessionClose: current.close,
    sourcePreviousClose: previous.close,
    sourceAsOf: `Historical session ${date}; source table refresh`,
  };
}
