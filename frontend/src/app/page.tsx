"use client";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Fingerprint,
  Globe2,
  Layers3,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  AtlasLogo,
  FoxIcon,
  SecurityNote,
  Ticker,
} from "@/components/atlas/ui";
import { Globe } from "@/components/atlas/globe";
import { useAtlas } from "@/components/atlas/provider";
import { SkinToggle, ThemeToggle } from "@/components/atlas/theme";
export default function Landing() {
  const { setModal } = useAtlas();
  return (
    <main className="landing">
      <div className="landing-grid" />
      <header className="landing-nav">
        <AtlasLogo />
        <div className="nav-actions">
          <span className="theme-switches">
            <SkinToggle />
            <ThemeToggle />
          </span>
          <button className="demo-link" onClick={() => setModal(true)}>
            Investor demo
            <ArrowUpRight size={14} />
          </button>
          <button className="btn primary small" onClick={() => setModal(true)}>
            <Wallet size={15} />
            Connect Wallet
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
            GLOBAL STRATEGIES
            <span className="label-divider" />
            CRYPTO NATIVE
          </div>
          <h1 className="hero-title-long">
            Smart Global Finance
            <br />
            <span>Strategy Platform.</span>
          </h1>
          <p className="hero-description">
            Build, share and copy trading strategies that run
            <br className="desktop-break" /> across the world&rsquo;s markets
            &mdash; all from one
            <br className="desktop-break" /> seamless, crypto-native wallet.
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
            <span>STRATEGIES. WORLDWIDE.</span>
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
