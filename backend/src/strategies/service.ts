import {
  CREATOR_FEE_BPS,
  creatorFee,
  isEns,
  isStrategyIcon,
  pickIcon,
  sameAddress,
  shortAddress,
  simulate,
  strategyHandle,
  uid,
  validateSpec,
  type Creator,
  type Performance,
  type Position,
  type RunMeta,
  type Strategy,
  type StrategyIcon,
  type StrategySpec,
  type Visibility,
} from "./core.js";
import type { StrategyRepository } from "./repository.js";

export class StrategyError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface Viewer {
  address: string;
  /** Verified ENS name from the wallet's profile, if linked. */
  ensName: string | null;
}

export interface StrategyInput {
  name: string;
  tagline: string;
  prompt: string;
  spec: unknown;
  visibility: Visibility;
  icon?: StrategyIcon | null;
}

const ZERO_STATS: Strategy["stats"] = {
  clones: 0,
  deployers: 0,
  aum: 0,
  creatorEarnings: 0,
};
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Marketplace rules, enforced server-side:
 * - private strategies are visible and editable only by their creator;
 * - clones start private, keep the root author as `originalCreator`, and get their own icon;
 * - live deployments by anyone but the root author pay CREATOR_FEE_BPS to that author;
 * - spec edits wipe the published track record; strategies others deployed cannot be deleted.
 */
export class StrategyService {
  constructor(
    private repo: StrategyRepository,
    private now: () => number = Date.now,
  ) {}

  private iso() {
    return new Date(this.now()).toISOString();
  }
  private me(v: Viewer): Creator {
    return {
      address: v.address,
      name: isEns(v.ensName)
        ? v.ensName!.toLowerCase()
        : shortAddress(v.address),
    };
  }
  private spec(value: unknown): StrategySpec {
    const { spec, error } = validateSpec(value);
    if (!spec)
      throw new StrategyError("INVALID_SPEC", error ?? "Invalid spec.");
    if (spec.universe.length > 40)
      throw new StrategyError(
        "INVALID_SPEC",
        "A strategy can hold at most 40 assets.",
      );
    if (spec.rules.length > 25)
      throw new StrategyError(
        "INVALID_SPEC",
        "A strategy can have at most 25 rules.",
      );
    return spec;
  }
  /** Visible to this viewer, or 404 — private strategies are never revealed to others. */
  private visible(id: string, viewer?: Viewer): Strategy {
    const s = this.repo.get(id);
    if (
      !s ||
      (s.visibility === "private" &&
        !sameAddress(s.creator.address, viewer?.address))
    )
      throw new StrategyError("NOT_FOUND", "Strategy not found.", 404);
    return s;
  }
  /** Strategies saved before an asset was delisted (e.g. crypto) can no longer run or be cloned. */
  private tradable(s: Strategy): Strategy {
    const { error } = validateSpec(s.spec);
    if (error) throw new StrategyError("UNSUPPORTED_ASSET", error, 422);
    return s;
  }
  private owned(id: string, viewer: Viewer): Strategy {
    const s = this.visible(id, viewer);
    if (!sameAddress(s.creator.address, viewer.address))
      throw new StrategyError(
        "FORBIDDEN",
        "Only the creator can change this strategy.",
        403,
      );
    return s;
  }
  private takenIcons(viewer: Viewer) {
    return this.repo.visible(viewer.address).map((s) => s.icon);
  }
  /** Walks fork links to the root strategy, which collects the creator fee. */
  private root(s: Strategy): Strategy {
    let cur = s;
    const seen = new Set<string>();
    while (cur.forkedFrom && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = this.repo.get(cur.forkedFrom.id);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }

  list(viewer?: Viewer) {
    return this.repo.visible(viewer?.address);
  }

  get(id: string, viewer?: Viewer) {
    return this.visible(id, viewer);
  }

  /** A creator's public profile by ENS name or address; the owner also sees their private work. */
  creator(handle: string, viewer?: Viewer) {
    const key = handle.toLowerCase().replace(/^@/, "");
    const all = this.repo.visible(viewer?.address);
    const theirs = all.filter(
      (s) =>
        s.creator.name.toLowerCase() === key ||
        s.creator.address.toLowerCase() === key,
    );
    const creator = theirs[0]?.creator;
    if (!creator)
      throw new StrategyError("NOT_FOUND", "Creator not found.", 404);
    const ids = new Set(theirs.map((s) => s.id));
    return {
      creator,
      strategies: theirs,
      forks: all.filter(
        (s) =>
          s.forkedFrom &&
          ids.has(s.forkedFrom.id) &&
          s.visibility === "public" &&
          !sameAddress(s.creator.address, creator.address),
      ),
    };
  }

  create(viewer: Viewer, input: StrategyInput): Strategy {
    const spec = this.spec(input.spec);
    return this.repo.transaction(() => {
      const now = this.iso(),
        me = this.me(viewer),
        id = uid("stg_");
      const s: Strategy = {
        id,
        name: input.name,
        tagline: input.tagline,
        prompt: input.prompt,
        spec,
        visibility: input.visibility,
        icon: isStrategyIcon(input.icon)
          ? input.icon
          : pickIcon(id, this.takenIcons(viewer)),
        ens: strategyHandle(input.name, viewer.ensName),
        creator: me,
        originalCreator: me,
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        stats: { ...ZERO_STATS },
        runs: {},
      };
      this.repo.save(s);
      return s;
    });
  }

  update(
    viewer: Viewer,
    id: string,
    patch: Partial<
      Pick<StrategyInput, "name" | "tagline" | "prompt" | "spec" | "icon">
    >,
  ): Strategy {
    const spec = patch.spec === undefined ? undefined : this.spec(patch.spec);
    return this.repo.transaction(() => {
      const s = this.owned(id, viewer);
      const specChanged =
        !!spec && JSON.stringify(spec) !== JSON.stringify(s.spec);
      const next: Strategy = {
        ...s,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.tagline !== undefined ? { tagline: patch.tagline } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(spec ? { spec } : {}),
        ...(isStrategyIcon(patch.icon) ? { icon: patch.icon } : {}),
        ens: patch.name
          ? strategyHandle(patch.name, viewer.ensName ?? s.creator.name)
          : s.ens,
        // Spec edits invalidate the old track record.
        runs: specChanged ? {} : s.runs,
        updatedAt: this.iso(),
      };
      this.repo.save(next);
      return next;
    });
  }

  setVisibility(viewer: Viewer, id: string, visibility: Visibility): Strategy {
    return this.repo.transaction(() => {
      const s = this.owned(id, viewer);
      const next = { ...s, visibility, updatedAt: this.iso() };
      this.repo.save(next);
      return next;
    });
  }

  remove(viewer: Viewer, id: string) {
    this.repo.transaction(() => {
      const s = this.owned(id, viewer);
      if (s.stats.deployers > 0)
        throw new StrategyError(
          "IN_USE",
          "Others have deployed this strategy — make it private instead of deleting.",
          409,
        );
      this.repo.delete(id);
    });
  }

  clone(viewer: Viewer, id: string): Strategy {
    return this.repo.transaction(() => {
      const src = this.tradable(this.visible(id, viewer));
      const now = this.iso(),
        cloneId = uid("stg_"),
        base = src.name.replace(/ Fund$/, "");
      const copy: Strategy = {
        ...structuredClone(src),
        id: cloneId,
        // A clone gets its own icon so it is distinguishable from its parent.
        icon: pickIcon(cloneId, this.takenIcons(viewer)),
        name: `${base} (My Fork)`,
        ens: strategyHandle(`${base} fork`, viewer.ensName),
        visibility: "private",
        creator: this.me(viewer),
        // The ORIGINAL creator stays attached through every clone generation.
        originalCreator: src.originalCreator,
        forkedFrom: { id: src.id, name: src.name, creator: src.creator.name },
        createdAt: now,
        updatedAt: now,
        stats: { ...ZERO_STATS },
        runs: {},
      };
      this.repo.save({
        ...src,
        stats: { ...src.stats, clones: src.stats.clones + 1 },
      });
      this.repo.save(copy);
      return copy;
    });
  }

  /** 1-year backtest. The creator's run is published as the strategy's track record. */
  backtest(
    viewer: Viewer,
    id: string,
    capital: number,
  ): { performance: Performance; strategy: Strategy } {
    return this.repo.transaction(() => {
      let s = this.tradable(this.visible(id, viewer));
      const run: RunMeta = { startedAt: this.iso(), capital, nonce: uid() };
      if (sameAddress(s.creator.address, viewer.address)) {
        s = { ...s, runs: { ...s.runs, backtest: run }, updatedAt: this.iso() };
        this.repo.save(s);
      }
      return {
        performance: simulate(
          s.spec,
          `${s.id}:backtest:${run.nonce}`,
          365,
          capital,
          "backtest",
          run.startedAt,
        ),
        strategy: s,
      };
    });
  }

  /** Paper trade or live deployment. Live deployments by non-authors pay the creator fee. */
  deploy(viewer: Viewer, id: string, mode: "paper" | "live", amount: number) {
    return this.repo.transaction(() => {
      const s = this.tradable(this.visible(id, viewer));
      if (amount < s.spec.execution.minDeployment)
        throw new StrategyError(
          "BELOW_MINIMUM",
          `Minimum is ${s.spec.execution.minDeployment} aUSDT.`,
        );
      const payFee =
        mode === "live" &&
        !sameAddress(s.originalCreator.address, viewer.address);
      const fee = payFee ? round(creatorFee(amount)) : 0;
      const now = this.iso();
      const position: Position = {
        id: uid("pos_"),
        strategyId: id,
        mode,
        capital: round(amount - fee),
        creatorFee: fee,
        feeRecipient: payFee ? s.originalCreator.address : null,
        startedAt: now,
      };
      const owner = sameAddress(s.creator.address, viewer.address);
      let next = s;
      if (owner && !next.runs[mode])
        next = {
          ...next,
          runs: {
            ...next.runs,
            [mode]: { startedAt: now, capital: amount, nonce: uid() },
          },
        };
      if (mode === "live" && !owner)
        next = {
          ...next,
          stats: {
            ...next.stats,
            deployers: next.stats.deployers + 1,
            aum: round(next.stats.aum + position.capital),
          },
        };
      this.repo.save(next);
      if (fee) {
        // Credit the root strategy of the original creator.
        const root = this.root(next);
        this.repo.save({
          ...root,
          stats: {
            ...root.stats,
            creatorEarnings: round(root.stats.creatorEarnings + fee),
          },
        });
      }
      this.repo.addPosition(viewer.address, position);
      return {
        position,
        strategy: this.repo.get(id)!,
        feeBps: payFee ? CREATOR_FEE_BPS : 0,
      };
    });
  }

  positions(viewer: Viewer) {
    return this.repo.positions(viewer.address);
  }

  /** Stops a paper trade or withdraws a live position (demo: no funds move). */
  stop(viewer: Viewer, positionId: string) {
    this.repo.transaction(() => {
      const p = this.repo.position(positionId);
      if (!p || !sameAddress(p.owner, viewer.address))
        throw new StrategyError("NOT_FOUND", "Position not found.", 404);
      this.repo.deletePosition(positionId);
      if (p.mode !== "live") return;
      const s = this.repo.get(p.strategyId);
      if (s && !sameAddress(s.creator.address, viewer.address))
        this.repo.save({
          ...s,
          stats: {
            ...s.stats,
            deployers: Math.max(0, s.stats.deployers - 1),
            aum: round(Math.max(0, s.stats.aum - p.capital)),
          },
        });
    });
  }

  reset(viewer: Viewer) {
    this.repo.transaction(() => {
      this.repo.resetOwner(viewer.address);
      this.repo.restoreSeeds();
    });
  }
}
