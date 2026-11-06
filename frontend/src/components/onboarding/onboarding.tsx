"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleCheck,
  Compass,
  Fingerprint,
  Globe2,
  GraduationCap,
  Layers3,
  Loader2,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import {
  AtlasLogo,
  FoxIcon,
  LoadingScreen,
  SecurityNote,
} from "@/components/atlas/ui";
import { useAtlas } from "@/components/atlas/provider";
import {
  WorldIDVerification,
  useDemoWorldId,
} from "@/components/world-id/verification";
import { markets, shortAddress } from "@/lib/data";
import { api } from "@/lib/api";
const steps = [
  "Connect Wallet",
  "Verify Identity",
  "Choose Markets",
  "Select Payment Asset",
  "Experience Level",
  "Complete",
];
const icons = [
  Wallet,
  Fingerprint,
  Globe2,
  Layers3,
  GraduationCap,
  CircleCheck,
];
const headings = [
  [
    "You’re connected.",
    "Your wallet is now connected to Atlas. The world is one step closer.",
  ],
  [
    "Verify you’re human.",
    "Use World ID or a device passkey to privately verify that you’re human.",
  ],
  [
    "Where will you go?",
    "Choose the markets that interest you. You can change this anytime.",
  ],
  [
    "Your investment. Your choice.",
    "Choose your preferred crypto settlement asset.",
  ],
  [
    "A little about your experience.",
    "We’ll personalize the information density and guidance you see.",
  ],
  [
    "Your Atlas is ready.",
    "Your global investing experience has been personalized.",
  ],
];
export function Onboarding() {
  const { wallet, state, ready, update, toast } = useAtlas(),
    router = useRouter();
  const [saving, setSaving] = useState(false);
  const demoWorldId = useDemoWorldId();
  const step = state.currentStep;
  if (!ready || !wallet) return <LoadingScreen />;
  const canContinue =
    step === 1
      ? state.passkeyVerified ||
        (state.worldIdVerified && (demoWorldId || !state.worldIdVerifiedDemo))
      : step === 2
        ? state.selectedMarkets.length > 0
        : true;
  async function next() {
    setSaving(true);
    const patch = { currentStep: Math.min(5, step + 1) };
    try {
      await api("/profile", patch, "PUT");
      update(patch);
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message
          : "Could not save your progress. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function enter() {
    setSaving(true);
    try {
      await api(
        "/profile",
        {
          selectedMarkets: state.selectedMarkets,
          preferredAsset: state.preferredAsset,
          experienceLevel: state.experienceLevel,
          onboardingComplete: true,
          currentStep: 5,
        },
        "PUT",
      );
      update({ onboardingComplete: true });
      router.push("/home");
      toast("Welcome to Atlas. Your global portfolio is ready.");
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message
          : "Could not complete onboarding. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="onboarding-page">
      <header className="onboarding-header">
        <AtlasLogo />
        <span className="onboarding-header-note">
          <ShieldCheck size={15} />
          Your journey, secured.
        </span>
        <span className="preview-tag">INVESTOR PREVIEW</span>
      </header>
      <div className="onboarding-shell">
        <aside className="onboarding-sidebar">
          <div>
            <span className="eyebrow">A WORLD OF POSSIBILITIES</span>
            <h2>
              Make yourself
              <br />
              at home, globally.
            </h2>
            <p>
              A few simple steps.
              <br />
              An entirely new perspective.
            </p>
          </div>
          <div className="onboarding-steps">
            {steps.map((label, i) => {
              const Icon = icons[i];
              return (
                <div
                  key={label}
                  className={`onboarding-step ${i === step ? "current" : i < step ? "completed" : ""}`}
                >
                  <span className="step-circle">
                    {i < step ? <Check size={16} /> : <Icon size={17} />}
                  </span>
                  <span>
                    <small>
                      {i === step
                        ? "IN PROGRESS"
                        : i < step
                          ? "COMPLETED"
                          : `STEP 0${i + 1}`}
                    </small>
                    <strong>{label}</strong>
                  </span>
                  {i === step && <ChevronRight size={14} />}
                </div>
              );
            })}
          </div>
          <div className="sidebar-wallet">
            <span className="fox-box">
              <FoxIcon />
            </span>
            <div>
              <strong>{shortAddress(wallet.address)}</strong>
              <small>
                <span className="status-dot" />
                {wallet.demo ? "Demo wallet connected" : "Wallet connected"}
              </small>
            </div>
            <ShieldCheck size={16} />
          </div>
        </aside>
        <section className="onboarding-content">
          <div className="onboarding-progress">
            <div>
              <span>PERSONALIZE YOUR ATLAS</span>
              <span>Step {Math.min(step + 1, 6)} of 6</span>
            </div>
            <div className="progress-segments">
              {steps.map((_, i) => (
                <span key={i} className={i <= step ? "filled" : ""} />
              ))}
            </div>
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              className="onboarding-body"
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.22 }}
            >
              <div className="step-kicker">
                {step === 5
                  ? "ALL SET FOR YOUR NEXT CHAPTER"
                  : `LET’S GET YOU STARTED / 0${step + 1}`}
              </div>
              <h1>{headings[step][0]}</h1>
              <p className="step-description">{headings[step][1]}</p>
              {step === 0 && (
                <div className="wallet-confirm">
                  <span className="success-emblem">
                    <Check size={31} />
                  </span>
                  <div className="wallet-confirm-card">
                    <div>
                      <span className="fox-box">
                        <FoxIcon />
                      </span>
                      <span>
                        <strong>MetaMask{wallet.demo ? " · Demo" : ""}</strong>
                        <small>{shortAddress(wallet.address)}</small>
                      </span>
                      <span className="connected-pill">
                        <Check size={12} />
                        Connected
                      </span>
                    </div>
                    <div className="wallet-network">
                      <span>Connected network</span>
                      <strong>{wallet.network}</strong>
                    </div>
                    <div className="wallet-balance-preview">
                      <div>
                        <span className="token-icon usdt">₮</span>
                        <span>USDT</span>
                        <strong>— —</strong>
                      </div>
                      <div>
                        <span className="token-icon atlas">A</span>
                        <span>ATLAS</span>
                        <strong>— —</strong>
                      </div>
                    </div>
                  </div>
                  <p className="subtle-note">
                    Balances appear on your dashboard. No transaction is
                    required.
                  </p>
                </div>
              )}
              {step === 1 && <WorldIDVerification />}
              {step === 2 && (
                <>
                  <div className="selection-heading">
                    <span>{state.selectedMarkets.length} markets selected</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        update({
                          selectedMarkets:
                            state.selectedMarkets.length === markets.length
                              ? ["india"]
                              : markets.map((m) => m.id),
                        })
                      }
                    >
                      {state.selectedMarkets.length === markets.length
                        ? "Reset selection"
                        : "Select all markets"}
                      <Globe2 size={14} />
                    </button>
                  </div>
                  <div className="market-selection">
                    {markets.map((m) => {
                      const active = state.selectedMarkets.includes(m.id);
                      return (
                        <motion.button
                          whileTap={{ scale: 0.98 }}
                          className={`selection-card ${active ? "selected" : ""}`}
                          aria-pressed={active}
                          key={m.id}
                          onClick={() =>
                            update({
                              selectedMarkets: active
                                ? state.selectedMarkets.filter(
                                    (id) => id !== m.id,
                                  )
                                : [...state.selectedMarkets, m.id],
                            })
                          }
                        >
                          <span className="flag">{m.flag}</span>
                          <div>
                            <strong>{m.name}</strong>
                            <span>{m.exchange}</span>
                          </div>
                          <small>{m.currency}</small>
                          <span className="selection-check">
                            {active && <Check size={13} />}
                          </span>
                        </motion.button>
                      );
                    })}
                  </div>
                  <p className="subtle-note">
                    <Compass size={14} />
                    Start with what you know. Explore beyond it.
                  </p>
                </>
              )}
              {step === 3 && (
                <>
                  <div className="payment-selection">
                    {(["USDT", "ATLAS"] as const).map((asset) => (
                      <motion.button
                        whileTap={{ scale: 0.985 }}
                        aria-pressed={state.preferredAsset === asset}
                        key={asset}
                        className={`payment-card ${state.preferredAsset === asset ? "selected" : ""}`}
                        onClick={() => update({ preferredAsset: asset })}
                      >
                        <div>
                          <span
                            className={`token-icon ${asset === "USDT" ? "usdt" : "atlas"}`}
                          >
                            {asset === "USDT" ? "₮" : "A"}
                          </span>
                          <span className="selection-check">
                            {state.preferredAsset === asset && (
                              <Check size={13} />
                            )}
                          </span>
                        </div>
                        <h3>
                          {asset}
                          <small>
                            {asset === "USDT" ? "Stablecoin" : "Atlas Coin"}
                          </small>
                        </h3>
                        <p>
                          {asset === "USDT"
                            ? "A dollar-pegged crypto asset for global investments."
                            : "The native token of the Atlas ecosystem."}
                        </p>
                        <footer>
                          <span>DEMO BALANCE</span>
                          <strong>
                            {asset === "USDT" ? "5,420.25" : "8,250"}
                            <small>{asset}</small>
                          </strong>
                        </footer>
                      </motion.button>
                    ))}
                  </div>
                  <p className="subtle-note">
                    <Layers3 size={14} />
                    Set a preference now. You can use both assets later.
                  </p>
                </>
              )}
              {step === 4 && (
                <>
                  <div className="experience-selection">
                    {[
                      {
                        id: "beginner",
                        title: "New investor",
                        copy: "New to investing or global markets.",
                        Icon: Compass,
                      },
                      {
                        id: "intermediate",
                        title: "Intermediate",
                        copy: "Comfortable with stocks and basic market concepts.",
                        Icon: BarChart3,
                      },
                      {
                        id: "advanced",
                        title: "Advanced",
                        copy: "Experienced in trading, crypto, or international markets.",
                        Icon: GraduationCap,
                      },
                    ].map(({ id, title, copy, Icon }) => (
                      <button
                        key={id}
                        aria-pressed={state.experienceLevel === id}
                        className={`experience-card ${state.experienceLevel === id ? "selected" : ""}`}
                        onClick={() =>
                          update({
                            experienceLevel: id as typeof state.experienceLevel,
                          })
                        }
                      >
                        <span className="experience-icon">
                          <Icon size={23} />
                        </span>
                        <span>
                          <strong>{title}</strong>
                          <p>{copy}</p>
                        </span>
                        <span className="selection-check">
                          {state.experienceLevel === id && <Check size={13} />}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="subtle-note">
                    This selection only personalizes the Atlas demo experience.
                  </p>
                </>
              )}
              {step === 5 && (
                <>
                  <div className="completion-emblem">
                    <span>
                      <Sparkles size={30} />
                    </span>
                    <div className="completion-orbit" />
                  </div>
                  <div className="completion-summary">
                    <div>
                      <span>Wallet</span>
                      <strong>{shortAddress(wallet.address)}</strong>
                    </div>
                    <div>
                      <span>Human verification</span>
                      <strong className="positive">
                        <ShieldCheck size={14} />
                        {[
                          state.worldIdVerified &&
                            `World ID${
                              state.worldIdVerifiedDemo
                                ? " · Simulated"
                                : state.worldIdEnvironment === "staging"
                                  ? " · Simulator"
                                  : ""
                            }`,
                          state.passkeyVerified && "Passkey",
                        ]
                          .filter(Boolean)
                          .join(" + ")}
                      </strong>
                    </div>
                    <div>
                      <span>Your markets</span>
                      <strong className="summary-markets">
                        {markets
                          .filter((m) => state.selectedMarkets.includes(m.id))
                          .map((m) => (
                            <span key={m.id} title={m.name}>
                              {m.flag} {m.name}
                            </span>
                          ))}
                      </strong>
                    </div>
                    <div>
                      <span>Preferred asset</span>
                      <strong>{state.preferredAsset}</strong>
                    </div>
                    <div>
                      <span>Experience</span>
                      <strong className="capitalize">
                        {state.experienceLevel === "beginner"
                          ? "New investor"
                          : state.experienceLevel}
                      </strong>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="onboarding-bottom">
            {step === 5 ? (
              <>
                <button
                  className="btn primary full"
                  disabled={saving}
                  onClick={enter}
                >
                  {saving ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <Globe2 size={17} />
                  )}
                  Enter Atlas
                  <ArrowRight size={17} />
                </button>
                <button
                  className="text-button review-button"
                  onClick={() => update({ currentStep: 2 })}
                >
                  Review preferences
                </button>
              </>
            ) : (
              <div className="onboarding-controls">
                {step > 0 ? (
                  <button
                    className="btn back"
                    onClick={() => update({ currentStep: step - 1 })}
                  >
                    <ArrowLeft size={15} />
                    Back
                  </button>
                ) : (
                  <span />
                )}
                <button
                  className="btn primary"
                  disabled={!canContinue || saving}
                  onClick={next}
                >
                  {saving ? <Loader2 size={16} className="spin" /> : null}
                  {step === 0
                    ? "Continue to identity verification"
                    : "Continue"}
                  <ArrowRight size={16} />
                </button>
              </div>
            )}
            <SecurityNote />
          </div>
        </section>
      </div>
      <footer className="onboarding-footer">
        <span>One Wallet. Five Markets. One Global Portfolio.</span>
        <span>© {new Date().getFullYear()} Atlas</span>
      </footer>
    </main>
  );
}
