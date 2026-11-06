import { z } from "zod";
import { resolveAsset, knownNames } from "../intent/assets.js";
import type { ModelClient } from "../intent/parser.js";

export const paperDraftSchema = z
  .object({
    symbol: z.string().max(16),
    quantity: z
      .string()
      .regex(/^\d+(\.\d{1,8})?$/)
      .refine((v) => Number(v) > 0 && Number(v) <= 1e6),
    entryTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(80),
    maxSlippageBps: z.number().int().min(0).max(1000),
    takeProfitBps: z.number().int().min(1).max(10000),
    stopLossBps: z.number().int().min(1).max(9999),
    expiryTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();
export type PaperDraft = z.infer<typeof paperDraftSchema>;
export type ParsedPaper =
  | { status: "OK"; draft: PaperDraft; parser: "rules" | "claude" }
  | { status: "CLARIFICATION_NEEDED"; question: string };
export const EXAMPLE =
  "Buy 5 shares of AAPL at 10:30 a.m. America/New_York on the selected simulation date if estimated buy slippage is at most 0.5%. After the buy fills, sell when the price reaches 2% above or 1% below the entry fill price. Cancel the entry if it has not filled by 10:35 a.m.";
/** Search actual timezone offsets rather than guessing DST. Reject ambiguous/nonexistent local times. */
export function wallTime(date: string, time: string, timezone: string): number {
  const target = `${date} ${time}`;
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wall = Date.parse(`${date}T${time}:00Z`),
    hits: number[] = [];
  if (
    !Number.isFinite(wall) ||
    new Date(wall).toISOString().slice(0, 10) !== date
  )
    throw Error("Choose a valid simulation date.");
  for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
    const t = wall + offset * 60000,
      p = Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === target)
      hits.push(t / 1000);
  }
  if (hits.length !== 1)
    throw Error(
      "That local time is ambiguous or does not exist across a daylight-saving change. Choose another time.",
    );
  return hits[0]!;
}
function clock(raw: string) {
  const m = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(raw);
  if (!m) return undefined;
  let h = Number(m[1]);
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  }
  if (h > 23 || +m[2]! > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
export async function parsePaperPrompt(
  prompt: string,
  model?: ModelClient,
): Promise<ParsedPaper> {
  const clarification = (question: string): ParsedPaper => ({
    status: "CLARIFICATION_NEEDED",
    question,
  });
  if (
    /\b(short|leverage|options?|futures?|ignore|system prompt|trailing|rsi|sma)\b|\b(?:if|when)\s+(?:the\s+)?price\s+(?:falls|rises|drops|is\s+(?:below|above))|\blimit order\b/i.test(
      prompt,
    )
  )
    return clarification(
      "Use one long stock buy with an exact share quantity, entry time, timezone, slippage cap, take-profit, stop-loss and entry expiry.",
    );
  const quantity = /\bbuy\s+(\d+(?:\.\d+)?)\s+shares?\b/i.exec(prompt)?.[1];
  const name = knownNames.find(
    (n) =>
      n.length > 1 &&
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
        prompt,
      ),
  );
  const asset = name && resolveAsset(name);
  const times = [
    ...prompt.matchAll(/\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?/gi),
  ].map((m) => clock(m[0]));
  const timezone = /\b([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/.exec(
    prompt,
  )?.[1];
  const slip = /slippage[^%\d]{0,45}(\d+(?:\.\d+)?)\s*%/i.exec(prompt)?.[1];
  const tp =
    /(\d+(?:\.\d+)?)\s*%\s*(?:above|profit|take[- ]?profit)/i.exec(
      prompt,
    )?.[1] ??
    /take[- ]?profit[^\d]{0,15}(\d+(?:\.\d+)?)\s*%/i.exec(prompt)?.[1];
  const sl =
    /(\d+(?:\.\d+)?)\s*%\s*(?:below|loss|stop[- ]?loss)/i.exec(prompt)?.[1] ??
    /stop[- ]?loss[^\d]{0,15}(\d+(?:\.\d+)?)\s*%/i.exec(prompt)?.[1];
  if (!asset)
    return clarification(
      "Which onboarded stock should Atlas buy? Give one ticker, for example AAPL.",
    );
  const mentions = knownNames
    .filter(
      (n) =>
        n.length > 1 &&
        new RegExp(
          `\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(prompt),
    )
    .map((n) => resolveAsset(n)?.stockId);
  if (new Set(mentions).size > 1)
    return clarification("Choose one stock per paper intent.");
  if (!quantity)
    return clarification(
      "How many shares should Atlas buy? Use “Buy 5 shares of AAPL”, for example.",
    );
  if (
    times.length !== 2 ||
    !times[0] ||
    !times[1] ||
    !timezone ||
    !/\b(?:cancel|expir|until|by)\b/i.test(prompt)
  )
    return clarification(
      "Specify an entry time and entry expiry using HH:MM a.m./p.m., and an IANA timezone such as America/New_York.",
    );
  if (slip === undefined || tp === undefined || sl === undefined)
    return clarification(
      "Specify maximum slippage, take-profit and stop-loss as percentages, for example 0.5% slippage, 2% above entry and 1% below entry.",
    );
  const checked = paperDraftSchema.safeParse({
    symbol: asset.symbol,
    quantity,
    entryTime: times[0],
    expiryTime: times[1],
    timezone,
    maxSlippageBps: Number(slip) * 100,
    takeProfitBps: Number(tp) * 100,
    stopLossBps: Number(sl) * 100,
  });
  if (!checked.success)
    return clarification(
      "Use valid positive quantities and percentage limits with at most two decimal places.",
    );
  const draft = checked.data;
  // Reuse Atlas's configured Claude transport. It never evaluates a rule or sets a market price.
  // Every output field must equal the deterministic extraction, including time and timezone.
  if (model)
    try {
      const raw = await model(
        `Convert the trading instruction into this exact JSON schema: ${JSON.stringify(draft)}. Preserve all quantities, percentages (basis points), 24-hour HH:MM times and IANA timezone. Only JSON. No tools or trading.`,
        prompt,
      );
      const parsed = paperDraftSchema.parse(
        JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")),
      );
      if (
        Object.keys(draft).every(
          (k) => parsed[k as keyof PaperDraft] === draft[k as keyof PaperDraft],
        )
      )
        return { status: "OK", draft: parsed, parser: "claude" };
    } catch {
      /* Offline and provider failure use the same deterministic parser. */
    }
  return { status: "OK", draft, parser: "rules" };
}
