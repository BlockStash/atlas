"use client";
import { useEffect, useState } from "react";
import { formatUnits, isAddress, isHash } from "viem";
import {
  AtSign,
  ArrowUpRight,
  BadgeCheck,
  Check,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { api } from "@/lib/api";
import { sepoliaClient } from "@/lib/chain";
import { transactionMessage } from "@/lib/transactions";
import {
  newRegistration,
  registrationQuote,
  registrationTiming,
  sendRegistrationStep,
  completeRegistrationStep,
  type ENSRegistration,
  type RegistrationAction,
} from "@/lib/ens-registration";
import type { UserOnboardingState } from "@/lib/types";
type Quote = Awaited<ReturnType<typeof registrationQuote>>;
export function ENSIdentity({
  initialMode = "link",
}: {
  initialMode?: "link" | "create";
}) {
  const { wallet, state, update } = useAtlas();
  const [mode, setMode] = useState(initialMode),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [changing, setChanging] = useState(false);
  const [reg, setReg] = useState<ENSRegistration | null>(null),
    [quote, setQuote] = useState<Quote | null>(null),
    [seconds, setSeconds] = useState<number | null>(null),
    [expired, setExpired] = useState(false);
  const [storage, setStorage] = useState<{
    driver: string;
    ready: boolean;
    message?: string;
  } | null>(null);
  const address = wallet?.address,
    key = `atlas_ens_registration_11155111_${address?.toLowerCase()}`;
  useEffect(() => {
    if (!wallet) return;
    let active = true;
    api<typeof storage>("/storage/status")
      .then((value) => {
        if (active) setStorage(value);
      })
      .catch(() => {
        if (active)
          setStorage({
            driver: "arkiv",
            ready: false,
            message: "Could not check profile storage.",
          });
      });
    return () => {
      active = false;
    };
  }, [wallet]);
  useEffect(() => {
    setReg(null);
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const value = JSON.parse(saved);
        if (
          value.owner?.toLowerCase() === address?.toLowerCase() &&
          isHash(value.secret) &&
          value.duration === 31536000 &&
          (!value.resolverAddress || isAddress(value.resolverAddress))
        )
          setReg(value);
      }
    } catch {
      setError("Could not restore registration progress from this browser.");
    }
  }, [key, address]);
  useEffect(() => {
    if (!reg || reg.registerHash || !wallet) return;
    if (state.ensName && !changing) return; // Linked: the draft isn't on screen.
    let active = true;
    registrationQuote(reg.name, wallet.address)
      .then((value) => {
        if (active) setQuote(value);
      })
      .catch((e) => {
        if (active) setError(transactionMessage(e));
      });
    return () => {
      active = false;
    };
  }, [reg, wallet, state.ensName, changing]);
  useEffect(() => {
    if (!reg?.commitHash || reg.registerHash) return;
    let active = true;
    const tick = () =>
      registrationTiming(reg)
        .then((value) => {
          if (active) {
            setSeconds(value.seconds);
            setExpired(value.expired);
          }
        })
        .catch(() => {
          if (active) setSeconds(null);
        });
    void tick();
    const id = setInterval(tick, 15000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [reg]);
  useEffect(() => {
    if (seconds === null || seconds <= 0) return;
    const id = setTimeout(
      () =>
        setSeconds((value) => (value === null ? null : Math.max(0, value - 1))),
      1000,
    );
    return () => clearTimeout(id);
  }, [seconds]);
  if (!wallet) return null;
  function save(value: ENSRegistration | null) {
    setReg(value);
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch {
      setError(
        "Browser storage is unavailable. Keep this window open until registration completes.",
      );
    }
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(transactionMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function link(value = name) {
    await run(async () => {
      const profile = await api<UserOnboardingState>("/profile/ens", {
        name: value,
      });
      update({
        ensName: profile.ensName,
        ensChainId: profile.ensChainId,
        ensVerifiedAt: profile.ensVerifiedAt,
      });
      setChanging(false);
      if (reg && reg.name === profile.ensName) save(null); // Registration finished.
      setMessage(`${profile.ensName} is linked to your Atlas profile.`);
    });
  }
  async function check() {
    await run(async () => {
      if (wallet!.demo)
        throw new Error("Connect a real MetaMask wallet to register ENS.");
      const draft = newRegistration(name, wallet!.address),
        value = await registrationQuote(draft.name, wallet!.address);
      save(draft);
      setQuote(value);
    });
  }
  async function confirm(current: ENSRegistration) {
    if (!current.pending) return;
    let replaced = false;
    const receipt = await sepoliaClient.waitForTransactionReceipt({
      hash: current.pending.hash,
      timeout: 120000,
      onReplaced: (info) => {
        if (info.reason !== "repriced") replaced = true;
      },
    });
    if (replaced) {
      save({ ...current, pending: undefined });
      throw new Error(
        "The transaction was cancelled or replaced in MetaMask. This registration step has not been completed.",
      );
    }
    if (receipt.status === "reverted") {
      save({ ...current, pending: undefined });
      throw new Error("The transaction reverted. You can retry this step.");
    }
    save(completeRegistrationStep(current, receipt));
    setMessage("Sepolia transaction confirmed.");
  }
  async function transact(kind: RegistrationAction) {
    await run(async () => {
      if (!reg) return;
      if (reg.pending)
        throw new Error(
          "Check the pending transaction before sending another.",
        );
      const hash = await sendRegistrationStep(reg, kind),
        pending = { ...reg, pending: { kind, hash } };
      save(pending);
      await confirm(pending);
    });
  }
  const showLinked = !!state.ensName && !wallet.demo && !changing;
  async function unlink() {
    await run(async () => {
      await api("/profile/ens", undefined, "DELETE");
      update({ ensName: null, ensChainId: null, ensVerifiedAt: null });
      setChanging(false);
      setMessage(
        "ENS name unlinked from Atlas. Your onchain records were unchanged.",
      );
    });
  }
  return (
    <section className="ens-identity">
      <div className="ens-title">
        <AtSign size={22} />
        <div>
          <h3>Your ENS identity</h3>
          <p>A name for your wallet, verified on Sepolia.</p>
        </div>
        {state.ensName && !wallet.demo ? (
          <span className="ens-verified-badge">
            <BadgeCheck size={13} /> Verified
          </span>
        ) : (
          <span className="demo-badge">SEPOLIA</span>
        )}
      </div>
      {showLinked ? (
        <div className="ens-verified">
          <span className="ens-verified-icon">
            <Check size={20} strokeWidth={2.6} />
          </span>
          <div className="ens-verified-body">
            <strong>{state.ensName}</strong>
            <span>
              Resolves to {wallet.address.slice(0, 6)}…
              {wallet.address.slice(-4)} on Sepolia
              {state.ensVerifiedAt &&
                ` · verified ${new Date(state.ensVerifiedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`}
            </span>
          </div>
          <div className="ens-verified-actions">
            <a
              className="btn secondary small"
              href={`https://sepolia.app.ens.domains/${encodeURIComponent(state.ensName!)}`}
              target="_blank"
              rel="noreferrer"
            >
              ENS app <ArrowUpRight size={13} />
            </a>
            <button
              className="btn secondary small"
              disabled={busy}
              onClick={() => {
                setError("");
                setMessage("");
                setChanging(true);
              }}
            >
              Change
            </button>
            <button
              className="text-button ens-unlink"
              disabled={busy}
              onClick={unlink}
            >
              Unlink
            </button>
          </div>
        </div>
      ) : (
        <>
          {changing && (
            <div className="ens-changing">
              <span>
                Linking a new name replaces <strong>{state.ensName}</strong>.
              </span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setChanging(false);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          <div
            className="ens-tabs"
            role="group"
            aria-label="ENS identity options"
          >
            <button
              className={mode === "link" ? "active" : ""}
              onClick={() => setMode("link")}
            >
              <Link2 size={14} />
              Link existing ENS
            </button>
            <button
              className={mode === "create" ? "active" : ""}
              onClick={() => setMode("create")}
            >
              <Plus size={14} />
              Create new ENS
            </button>
          </div>
          {wallet.demo ? (
            <p className="error-box">
              Connect a real MetaMask wallet to use ENS identity.
            </p>
          ) : (
            <>
              {mode === "link" ? (
                <form
                  className="ens-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void link();
                  }}
                >
                  <label>
                    Existing ENS name
                    <input
                      autoComplete="off"
                      placeholder="your-name.eth"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                      required
                    />
                  </label>
                  <p>
                    The name must resolve to {wallet.address.slice(0, 6)}…
                    {wallet.address.slice(-4)} on Sepolia. Linking saves it to
                    your Atlas profile; it does not change onchain ENS records.
                  </p>
                  <button className="btn primary full" disabled={busy}>
                    {busy ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <Link2 size={15} />
                    )}
                    Verify & link ENS
                  </button>
                </form>
              ) : (
                <div className="ens-create">
                  {!reg ? (
                    <form
                      className="ens-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void check();
                      }}
                    >
                      <label>
                        Choose a Sepolia .eth name
                        <input
                          required
                          autoComplete="off"
                          placeholder="your-atlas-name.eth"
                          value={name}
                          disabled={busy}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                      <p>
                        Register a test name for one year. You’ll approve each
                        Sepolia transaction in MetaMask. Fees use test USDC plus
                        test ETH for gas.
                      </p>
                      <button className="btn primary full" disabled={busy}>
                        {busy ? (
                          <Loader2 className="spin" size={15} />
                        ) : (
                          <AtSign size={15} />
                        )}
                        Check availability
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="ens-registration-heading">
                        <h4>{reg.name}</h4>
                        <button
                          className="text-button"
                          disabled={busy || !!reg.pending}
                          onClick={() => {
                            save(null);
                            setQuote(null);
                            setMessage("");
                            setError("");
                          }}
                        >
                          Choose another
                        </button>
                      </div>
                      <div className="ens-registration-owner">
                        Owner: {reg.owner}
                        <br />
                        Network: Sepolia · Duration: 1 year
                      </div>
                      {quote && !reg.registerHash && (
                        <div className="ens-price">
                          <span>Current registration fee</span>
                          <strong>
                            {formatUnits(quote.price, quote.decimals)} test{" "}
                            {quote.symbol}
                          </strong>
                          <small>
                            Plus test ETH gas. The price is checked again before
                            registration.
                          </small>
                          <small>Payment token: {quote.token}</small>
                        </div>
                      )}
                      <ol className="ens-registration-steps">
                        <li className={reg.resolverAddress ? "done" : ""}>
                          <span>
                            {reg.resolverAddress ? <Check size={13} /> : 1}
                          </span>
                          <div>
                            <strong>Create your resolver</strong>
                            <p>
                              Sets your wallet as the address record on your own
                              resolver.
                            </p>
                            {!reg.resolverAddress && (
                              <button
                                className="btn secondary small"
                                disabled={busy || !!reg.pending}
                                onClick={() => transact("resolver")}
                              >
                                Create resolver in MetaMask
                              </button>
                            )}
                          </div>
                        </li>
                        <li className={reg.commitHash ? "done" : ""}>
                          <span>
                            {reg.commitHash ? <Check size={13} /> : 2}
                          </span>
                          <div>
                            <strong>Commit your name</strong>
                            <p>
                              A commitment protects your registration while the
                              waiting period runs.
                            </p>
                            {reg.resolverAddress && !reg.commitHash && (
                              <button
                                className="btn secondary small"
                                disabled={busy || !!reg.pending}
                                onClick={() => transact("commit")}
                              >
                                Commit in MetaMask
                              </button>
                            )}
                            {reg.commitHash && !reg.registerHash && (
                              <p role="status">
                                {expired
                                  ? "Commitment expired. Choose the name again to restart."
                                  : seconds === null
                                    ? "Checking onchain waiting period…"
                                    : seconds > 0
                                      ? `Ready to register in about ${seconds}s.`
                                      : "Waiting period complete. Ready to register."}
                              </p>
                            )}
                          </div>
                        </li>
                        <li className={reg.registerHash ? "done" : ""}>
                          <span>
                            {reg.registerHash ? <Check size={13} /> : 3}
                          </span>
                          <div>
                            <strong>Pay with test USDC & register</strong>
                            <p>
                              Mint test tokens if needed, approve only the
                              quoted price, then register.
                            </p>
                            {reg.commitHash && !reg.registerHash && quote && (
                              <div className="ens-registration-actions">
                                {quote.balance < quote.price ? (
                                  <button
                                    className="btn secondary small"
                                    disabled={busy || !!reg.pending}
                                    onClick={() => transact("fund")}
                                  >
                                    Get test USDC in MetaMask
                                  </button>
                                ) : quote.allowance < quote.price ? (
                                  <button
                                    className="btn secondary small"
                                    disabled={busy || !!reg.pending}
                                    onClick={() => transact("approve")}
                                  >
                                    Approve{" "}
                                    {formatUnits(quote.price, quote.decimals)}{" "}
                                    test {quote.symbol}
                                  </button>
                                ) : (
                                  <button
                                    className="btn primary small"
                                    disabled={
                                      busy ||
                                      !!reg.pending ||
                                      seconds === null ||
                                      seconds > 0 ||
                                      expired
                                    }
                                    onClick={() => transact("register")}
                                  >
                                    Register in MetaMask
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      </ol>
                      {reg.pending && (
                        <div className="ens-pending" role="status">
                          <p>
                            {busy
                              ? "Waiting for Sepolia confirmation…"
                              : "Transaction submitted. Check its status before continuing."}
                          </p>
                          <a
                            href={`https://sepolia.etherscan.io/tx/${reg.pending.hash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View transaction
                            <ArrowUpRight size={13} />
                          </a>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => run(() => confirm(reg))}
                          >
                            <RefreshCw size={13} />
                            Check transaction
                          </button>
                        </div>
                      )}
                      {reg.registerHash && (
                        <div className="ens-created">
                          <Check size={20} />
                          <h4>Your test ENS name is registered.</h4>
                          <a
                            href={`https://sepolia.etherscan.io/tx/${reg.registerHash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View registration
                            <ArrowUpRight size={13} />
                          </a>
                          <button
                            className="btn primary full"
                            disabled={busy}
                            onClick={() => link(reg.name)}
                          >
                            {busy ? (
                              <Loader2 size={15} className="spin" />
                            ) : (
                              <Link2 size={15} />
                            )}
                            Link {reg.name} to Atlas
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {busy && (
        <p className="ens-busy" role="status">
          <Loader2 size={14} className="spin" />
          Complete any request in MetaMask. Keep this window open.
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="ens-message" role="status">
          <Check size={14} />
          {message}
        </p>
      )}
      {storage && (
        <p className={`ens-storage ${storage.ready ? "" : "unavailable"}`}>
          {storage.driver === "arkiv"
            ? "Arkiv profile storage"
            : "Local profile storage"}{" "}
          · {storage.ready ? "Ready" : storage.message || "Setup required"}
        </p>
      )}
    </section>
  );
}
