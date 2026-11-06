"use client";
/**
 * Strategy marketplace — client store backed by the Atlas API (/api/strategies).
 *
 * The backend owns the data and enforces the rules (visibility, ownership, clone lineage,
 * creator fees). Specs, simulated performance and labels come from the shared core, which the
 * backend runs too, so numbers shown here match the server's.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import type {
  Performance,
  Position,
  Strategy,
  StrategyIcon,
  StrategySpec,
  Visibility,
} from "./strategy-core";

export * from "./strategy-core";

interface StoreData {
  strategies: Strategy[];
  positions: Position[];
}
interface StoreState {
  /** Lower-cased wallet address, or "anon" when signed out. */
  key: string;
  data: StoreData;
  status: "loading" | "ready" | "error";
  error?: string;
  fetchedAt: number;
}
interface ListResponse extends StoreData {
  viewer: { address: string; ensName: string | null } | null;
  creatorFeeBps: number;
}

const EMPTY: StoreData = { strategies: [], positions: [] };
const SERVER_STATE: StoreState = {
  key: "",
  data: EMPTY,
  status: "loading",
  fetchedAt: 0,
};
const STALE_MS = 15_000;
let state: StoreState = SERVER_STATE;
let inflight: { key: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function set(next: StoreState) {
  state = next;
  listeners.forEach((l) => l());
}
function setData(key: string, fn: (d: StoreData) => StoreData) {
  if (state.key !== key) return; // The wallet changed while the request was in flight.
  set({ ...state, data: fn(state.data) });
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function refresh(key: string): Promise<void> {
  if (inflight?.key === key) return inflight.promise;
  const promise = api<ListResponse>("/strategies")
    .then((r) => {
      if (state.key === key)
        set({
          key,
          data: { strategies: r.strategies, positions: r.positions },
          status: "ready",
          fetchedAt: Date.now(),
        });
    })
    .catch((e: Error) => {
      if (state.key === key)
        set({ ...state, status: "error", error: e.message });
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

/** Loads the marketplace for this wallet; switching wallets never shows the previous one's data. */
function ensure(key: string) {
  if (state.key !== key) {
    set({ key, data: EMPTY, status: "loading", fetchedAt: 0 });
    void refresh(key);
  } else if (Date.now() - state.fetchedAt > STALE_MS) void refresh(key);
}

const upsert = (list: Strategy[], s: Strategy) =>
  list.some((x) => x.id === s.id)
    ? list.map((x) => (x.id === s.id ? s : x))
    : [s, ...list];

export function useStrategies(account?: string, ensName?: string | null) {
  const key = account?.toLowerCase() ?? "anon";
  const snap = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  // ENS links change the handles the server assigns, so refetch when it changes.
  useEffect(() => ensure(key), [key, ensName]);
  const current = snap.key === key;
  const data = current ? snap.data : EMPTY;
  const mineFilter = (s: Strategy) =>
    !!account && s.creator.address.toLowerCase() === key;

  const requireWallet = () => {
    if (!account) throw new Error("Connect a wallet first.");
  };
  const mutate = async <T>(run: () => Promise<T>) => {
    requireWallet();
    try {
      return await run();
    } catch (e) {
      void refresh(key); // Resync after a rejected write.
      throw e;
    }
  };

  return {
    loaded: current && snap.status !== "loading",
    error: current && snap.status === "error" ? snap.error : undefined,
    strategies: data.strategies,
    positions: data.positions,
    mine: data.strategies.filter(mineFilter),
    explore: data.strategies.filter((s) => s.visibility === "public"),
    get: (id: string) => data.strategies.find((s) => s.id === id),
    refresh: () => refresh(key),

    /** POST /strategies */
    create(input: {
      name: string;
      tagline: string;
      prompt: string;
      spec: StrategySpec;
      visibility: Visibility;
      icon?: StrategyIcon | null;
    }) {
      return mutate(async () => {
        const s = await api<Strategy>("/strategies", input);
        setData(key, (d) => ({ ...d, strategies: upsert(d.strategies, s) }));
        return s;
      });
    },

    /** POST /strategies/:id/clone — a private copy; the root author keeps earning the fee. */
    clone(id: string) {
      return mutate(async () => {
        const copy = await api<Strategy>(`/strategies/${id}/clone`, {});
        setData(key, (d) => ({
          ...d,
          strategies: [
            copy,
            ...d.strategies.map((s) =>
              s.id === id
                ? { ...s, stats: { ...s.stats, clones: s.stats.clones + 1 } }
                : s,
            ),
          ],
        }));
        return copy;
      });
    },

    /** PATCH /strategies/:id — spec changes reset the published track record. */
    update(
      id: string,
      input: Partial<
        Pick<Strategy, "name" | "tagline" | "prompt" | "spec" | "icon">
      >,
    ) {
      return mutate(async () => {
        const s = await api<Strategy>(`/strategies/${id}`, input, "PATCH");
        setData(key, (d) => ({ ...d, strategies: upsert(d.strategies, s) }));
        return s;
      });
    },

    /** PUT /strategies/:id/visibility */
    setVisibility(id: string, visibility: Visibility) {
      return mutate(async () => {
        const s = await api<Strategy>(
          `/strategies/${id}/visibility`,
          { visibility },
          "PUT",
        );
        setData(key, (d) => ({ ...d, strategies: upsert(d.strategies, s) }));
        return s;
      });
    },

    /** DELETE /strategies/:id — refused once others have deployed it. */
    remove(id: string) {
      return mutate(async () => {
        await api(`/strategies/${id}`, undefined, "DELETE");
        setData(key, (d) => ({
          strategies: d.strategies.filter((s) => s.id !== id),
          positions: d.positions.filter((p) => p.strategyId !== id),
        }));
      });
    },

    /** POST /strategies/:id/backtest — the creator's run becomes the strategy's record. */
    runBacktest(id: string, capital: number) {
      return mutate(async () => {
        const r = await api<{ performance: Performance; strategy: Strategy }>(
          `/strategies/${id}/backtest`,
          { capital },
        );
        setData(key, (d) => ({
          ...d,
          strategies: upsert(d.strategies, r.strategy),
        }));
        return r.performance;
      });
    },

    /** POST /strategies/:id/deploy — paper trade, or a live deployment paying the creator fee. */
    start(id: string, mode: "paper" | "live", amount: number) {
      return mutate(async () => {
        const r = await api<{ position: Position; strategy: Strategy }>(
          `/strategies/${id}/deploy`,
          { mode, amount },
        );
        setData(key, (d) => ({
          strategies: upsert(d.strategies, r.strategy),
          positions: [r.position, ...d.positions],
        }));
        if (r.position.creatorFee) void refresh(key); // Fee credited to the root strategy.
        return r.position;
      });
    },

    /** DELETE /strategies/positions/:id */
    stop(positionId: string) {
      return mutate(async () => {
        await api(`/strategies/positions/${positionId}`, undefined, "DELETE");
        setData(key, (d) => ({
          ...d,
          positions: d.positions.filter((p) => p.id !== positionId),
        }));
        void refresh(key);
      });
    },

    /** POST /strategies/ens/targets — the subnames the server will accept for these strategies. */
    ensTargets(ids: string[]) {
      return mutate(async () => {
        const r = await api<{ targets: { id: string; name: string }[] }>(
          "/strategies/ens/targets",
          { ids },
        );
        return r.targets;
      });
    },

    /** POST /strategies/ens — the server resolves each subname onchain before recording it. */
    confirmEns(ids: string[], txHash: string) {
      return mutate(async () => {
        const r = await api<{ strategies: Strategy[] }>("/strategies/ens", {
          ids,
          txHash,
        });
        setData(key, (d) => ({
          ...d,
          strategies: r.strategies.reduce(upsert, d.strategies),
        }));
        return r.strategies;
      });
    },

    /** POST /strategies/reset — development only. */
    resetDemo() {
      return mutate(async () => {
        const r = await api<StoreData>("/strategies/reset", {});
        setData(key, () => r);
      });
    },
  };
}
