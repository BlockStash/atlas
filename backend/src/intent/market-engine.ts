import type { MarketState } from "./types.js";

export interface ExchangeSpec {
  timezone: string; // IANA identifier; offsets and DST are never computed by hand
  open: [number, number];
  close: [number, number];
  /** Full-day closures, YYYY-MM-DD in exchange-local time. Partial table: see README. */
  holidays: string[];
}
const H = (...d: string[]) => d;
const EU_COMMON = H(
  "2026-01-01",
  "2026-04-03",
  "2026-04-06",
  "2026-05-01",
  "2026-12-25",
);
export const EXCHANGES: Record<string, ExchangeSpec> = {
  NASDAQ: us(),
  NYSE: us(),
  NSE: {
    timezone: "Asia/Kolkata",
    open: [9, 15],
    close: [15, 30],
    holidays: H("2026-01-26", "2026-10-02", "2026-12-25"),
  },
  LSE: {
    timezone: "Europe/London",
    open: [8, 0],
    close: [16, 30],
    holidays: H(
      "2026-01-01",
      "2026-04-03",
      "2026-04-06",
      "2026-05-04",
      "2026-05-25",
      "2026-08-31",
      "2026-12-25",
      "2026-12-28",
    ),
  },
  SGX: {
    timezone: "Asia/Singapore",
    open: [9, 0],
    close: [17, 0],
    holidays: H("2026-01-01", "2026-04-03", "2026-05-01", "2026-12-25"),
  },
  XETRA: {
    timezone: "Europe/Berlin",
    open: [9, 0],
    close: [17, 30],
    holidays: [...EU_COMMON, "2026-12-24", "2026-12-31"],
  },
  "Euronext Amsterdam": {
    timezone: "Europe/Amsterdam",
    open: [9, 0],
    close: [17, 30],
    holidays: EU_COMMON,
  },
  "Euronext Paris": {
    timezone: "Europe/Paris",
    open: [9, 0],
    close: [17, 30],
    holidays: EU_COMMON,
  },
};
function us(): ExchangeSpec {
  return {
    timezone: "America/New_York",
    open: [9, 30],
    close: [16, 0],
    holidays: H(
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ),
  };
}

interface Local {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
}
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, ms: number): Local {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(ms).map((x) => [x.type, x.value]),
  );
  return {
    y: +p.year!,
    mo: +p.month!,
    d: +p.day!,
    h: +p.hour!,
    mi: +p.minute!,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!),
  };
}
/** Convert a local wall-clock time in `tz` to a UTC instant (ms) using Intl only. */
function zonedToUtc(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const l = local(tz, guess);
    const seen = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
    guess += wall - seen;
  }
  return guess;
}
const iso = (l: Local) =>
  `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
const tradingDay = (spec: ExchangeSpec, l: Local) =>
  l.dow !== 0 && l.dow !== 6 && !spec.holidays.includes(iso(l));

export function marketState(exchange: string, nowS: number): MarketState {
  const spec = EXCHANGES[exchange];
  if (!spec)
    return {
      open: false,
      nextOpen: null,
      nextClose: null,
      reason: "OUTSIDE_HOURS",
      timezone: "UTC",
      exchange,
    };
  const nowMs = nowS * 1000;
  const l = local(spec.timezone, nowMs);
  const mins = l.h * 60 + l.mi;
  const openM = spec.open[0] * 60 + spec.open[1];
  const closeM = spec.close[0] * 60 + spec.close[1];
  const day = tradingDay(spec, l);
  const base = { timezone: spec.timezone, exchange };
  if (day && mins >= openM && mins < closeM) {
    const close = zonedToUtc(
      spec.timezone,
      l.y,
      l.mo,
      l.d,
      spec.close[0],
      spec.close[1],
    );
    return {
      ...base,
      open: true,
      nextOpen: null,
      nextClose: Math.floor(close / 1000),
      reason: "OPEN",
    };
  }
  // Find the next session open, scanning forward at most two weeks.
  let nextOpen: number | null = null;
  for (let i = 0; i < 15 && nextOpen === null; i++) {
    const probe = local(spec.timezone, nowMs + i * 86_400_000);
    if (!tradingDay(spec, probe)) continue;
    const t = zonedToUtc(
      spec.timezone,
      probe.y,
      probe.mo,
      probe.d,
      spec.open[0],
      spec.open[1],
    );
    if (t > nowMs) nextOpen = Math.floor(t / 1000);
  }
  const reason = !day
    ? l.dow === 0 || l.dow === 6
      ? ("WEEKEND" as const)
      : ("HOLIDAY" as const)
    : ("OUTSIDE_HOURS" as const);
  return { ...base, open: false, nextOpen, nextClose: null, reason };
}
export const isMarketOpen = (exchange: string, nowS: number) =>
  marketState(exchange, nowS).open;

/** End (unix s) of the current or next trading session; used for "valid today". */
export function sessionEnd(exchange: string, nowS: number): number | null {
  const spec = EXCHANGES[exchange];
  if (!spec) return null;
  const st = marketState(exchange, nowS);
  if (st.open) return st.nextClose;
  if (st.nextOpen === null) return null;
  const l = local(spec.timezone, st.nextOpen * 1000);
  return Math.floor(
    zonedToUtc(spec.timezone, l.y, l.mo, l.d, spec.close[0], spec.close[1]) /
      1000,
  );
}
