"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Fingerprint,
  Globe2,
  Layers3,
  LockKeyhole,
  Menu,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import {
  AtlasLogo,
  FoxIcon,
  SecurityNote,
  Ticker,
} from "@/components/atlas/ui";
import { Globe } from "@/components/atlas/globe";
import { useAtlas } from "@/components/atlas/provider";
import { ThemeToggle } from "@/components/atlas/theme";
export default function Landing() {
  const { setModal } = useAtlas();
  const [mobile, setMobile] = useState(false),
    [info, setInfo] = useState<"security" | "about" | null>(null);
  useEffect(() => {
    if (info)
      document
        .getElementById("atlas-info")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [info]);
  return (
    <main className="landing">
      <div className="landing-grid" />
      <header className="landing-nav">
        <AtlasLogo />
        <nav className={mobile ? "open" : ""}>
          <a className="active" href="#home" onClick={() => setMobile(false)}>
            Home
          </a>
          <a href="#markets" onClick={() => setMobile(false)}>
            Markets
          </a>
          <a href="#how-it-works" onClick={() => setMobile(false)}>
            How it works
          </a>
          <button
            onClick={() => {
              setInfo(info === "security" ? null : "security");
              setMobile(false);
            }}
          >
            Security
          </button>
          <button
            onClick={() => {
              setInfo(info === "about" ? null : "about");
              setMobile(false);
            }}
          >
            About
          </button>
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          <button className="demo-link" onClick={() => setModal(true)}>
            Investor demo
            <ArrowUpRight size={14} />
          </button>
          <button className="btn primary small" onClick={() => setModal(true)}>
            <Wallet size={15} />
            Connect Wallet
          </button>
          <button
            className="mobile-menu"
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <section id="home" className="hero">
        <motion.div
          className="hero-copy"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="hero-label">
            <span className="status-dot" />
            GLOBAL INVESTING
            <span className="label-divider" />
            CRYPTO NATIVE
          </div>
          <h1>
            Global Markets.
            <br />
            <span>One Wallet.</span>
          </h1>
          <p className="hero-description">
            A world of opportunity. A single point of access.
            <br className="desktop-break" /> Discover global markets through one
            seamless,
            <br className="desktop-break" /> crypto-native investment
            experience.
          </p>
          <div className="hero-actions">
            <button className="btn primary" onClick={() => setModal(true)}>
              <FoxIcon />
              Connect MetaMask
              <ArrowRight size={16} />
            </button>
            <a className="btn secondary" href="#how-it-works">
              Explore Atlas
              <ArrowUpRight size={17} />
            </a>
          </div>
          <SecurityNote />
          <div className="hero-advantages">
            <div>
              <Globe2 size={18} />
              <strong>5 global markets</strong>
              <span>A world of possibilities</span>
            </div>
            <div>
              <Layers3 size={18} />
              <strong>Crypto native</strong>
              <span>USDT & ATLAS</span>
            </div>
            <div>
              <Wallet size={18} />
              <strong>One portfolio</strong>
              <span>Everything, connected</span>
            </div>
          </div>
        </motion.div>
        <div id="markets" className="hero-art">
          <div className="art-label">
            <span>YOUR WORLD. CONNECTED.</span>
            <span>01 — 05</span>
          </div>
          <Globe onMarket={() => setModal(true)} />
        </div>
      </section>
      <div className="market-strip">
        <span className="strip-label">
          <span className="status-dot" />
          MARKET SNAPSHOT<small>ILLUSTRATIVE DATA</small>
        </span>
        <Ticker />
      </div>
      <section id="how-it-works" className="journey">
        <div className="journey-intro">
          <span className="eyebrow">YOUR NEXT CHAPTER</span>
          <h2>
            A world of investing.
            <br />
            Three simple steps.
          </h2>
          <span className="journey-time">
            Get started in under 2 minutes
            <ArrowUpRight size={13} />
          </span>
        </div>
        {[
          {
            n: "01",
            Icon: Wallet,
            title: "Connect your wallet",
            copy: "Your keys. Your control. Connect securely with MetaMask.",
          },
          {
            n: "02",
            Icon: Fingerprint,
            title: "Verify with World ID",
            copy: "Prove you’re a unique human. Keep your identity private.",
          },
          {
            n: "03",
            Icon: Globe2,
            title: "Make Atlas yours",
            copy: "Choose your markets. Set your preferences. Explore the world.",
          },
        ].map(({ n, Icon, title, copy }) => (
          <button
            className="journey-step"
            key={n}
            onClick={() => setModal(true)}
          >
            <div className="step-heading">
              <span className="step-icon">
                <Icon size={20} />
              </span>
              <span>{n}</span>
            </div>
            <h3>
              {title}
              <ChevronRight size={15} />
            </h3>
            <p>{copy}</p>
          </button>
        ))}
      </section>
      {info && (
        <section className="info-panel" id="atlas-info">
          <button aria-label="Close information" onClick={() => setInfo(null)}>
            <X size={18} />
          </button>
          {info === "security" ? (
            <>
              <ShieldCheck />
              <h2>Built around your control.</h2>
              <p>
                Atlas never has access to your wallet private keys. Wallet
                authentication uses a signed message, and World ID is designed
                to verify unique humanity with minimal data sharing. This
                investor demo uses simulated assets and does not execute trades.
              </p>
              <span>
                <Check size={15} />
                Non-custodial connection <Check size={15} />
                Privacy-first identity <LockKeyhole size={15} />
                Secure sessions
              </span>
            </>
          ) : (
            <>
              <Globe2 />
              <h2>One Wallet. Five Markets. One Global Portfolio.</h2>
              <p>
                Atlas is a crypto-native global investment concept connecting
                India, the United States, the United Kingdom, Singapore, and
                Europe. Explore a personalized investor demonstration with USDT
                and ATLAS settlement preferences.
              </p>
            </>
          )}
        </section>
      )}
      <footer className="landing-footer">
        <span>
          © {new Date().getFullYear()} Atlas. A world without borders.
        </span>
        <div>
          <ShieldCheck size={13} />
          Wallet native
          <span className="footer-dot" />
          Human verified
          <span className="footer-dot" />
          Globally connected
        </div>
        <span>
          Investor preview <span className="version">V.01</span>
        </span>
      </footer>
    </main>
  );
}
