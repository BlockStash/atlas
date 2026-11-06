"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  ChevronDown,
  Globe2,
  LayoutDashboard,
  LogOut,
  Menu,
  PieChart,
  Search,
  ShieldCheck,
  Wallet,
  Landmark,
  ChartCandlestick,
  Compass,
  Layers,
  X,
} from "lucide-react";
import {
  AtlasLogo,
  GlobalMarketClock,
  LoadingScreen,
} from "@/components/atlas/ui";
import { useAtlas } from "@/components/atlas/provider";
import { ENSName } from "@/components/wallet/ens-name";
const links = [
  { href: "/dashboard", label: "Overview", Icon: LayoutDashboard },
  { href: "/markets", label: "Global markets", Icon: Globe2 },
  { href: "/portfolio", label: "My portfolio", Icon: PieChart },
  { href: "/wallet", label: "Wallet", Icon: Wallet },
  { href: "/vault", label: "Atlas Vault", Icon: Landmark },
  { href: "/trade", label: "Synthetic stocks", Icon: ChartCandlestick },
  { href: "/strategies", label: "Explore strategies", Icon: Compass },
  { href: "/strategies/mine", label: "My strategies", Icon: Layers },
];
/** Personal strategy routes highlight "My strategies"; other /strategies/* pages highlight Explore. */
const isActive = (href: string, path: string) => {
  if (href === "/strategies/mine")
    return path === href || path === "/strategies/new";
  if (href === "/strategies")
    return (
      path === href ||
      (path.startsWith("/strategies/") &&
        path !== "/strategies/mine" &&
        path !== "/strategies/new")
    );
  return path === href;
};
export function DashboardShell({
  children,
  search,
  onSearch,
}: {
  children: React.ReactNode;
  search?: string;
  onSearch?: (v: string) => void;
}) {
  const { wallet, ready, logout, toast, state } = useAtlas();
  const path = usePathname();
  const [menu, setMenu] = useState(false),
    [account, setAccount] = useState(false);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        onSearch
      ) {
        event.preventDefault();
        document.getElementById("market-search")?.focus();
      }
    };
    document.addEventListener("keydown", focus);
    return () => document.removeEventListener("keydown", focus);
  }, [onSearch]);
  if (!ready || !wallet || !state.onboardingComplete) return <LoadingScreen />;
  return (
    <div className="app-shell">
      <aside className={`app-sidebar ${menu ? "mobile-open" : ""}`}>
        <AtlasLogo />
        <button
          className="sidebar-close"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        >
          <X size={19} />
        </button>
        <div className="sidebar-section-label">YOUR WORKSPACE</div>
        <nav>
          {links.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={isActive(href, path) ? "active" : ""}
              onClick={() => setMenu(false)}
            >
              <Icon size={18} />
              {label}
              {isActive(href, path) && <span className="active-nav-dot" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-callout">
            <span className="preview-tag">SEPOLIA WORKSPACE</span>
            <h4>Your holdings, onchain.</h4>
            <p>
              Wallet balances and stock positions from your connected wallet.
            </p>
            <span>
              <ShieldCheck size={13} />
              Sepolia synthetic assets
            </span>
          </div>
          <button
            onClick={() =>
              logout().catch(() =>
                toast("Could not disconnect. Please try again."),
              )
            }
          >
            <LogOut size={16} />
            Disconnect wallet
          </button>
          <span className="sidebar-copyright">
            © {new Date().getFullYear()} Atlas
          </span>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          {onSearch ? (
            <label className="search-field">
              <Search size={16} />
              <input
                id="market-search"
                aria-label="Search markets"
                placeholder="Search markets, countries…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
              <kbd>/</kbd>
            </label>
          ) : (
            <Link className="search-field" href="/markets">
              <Search size={16} />
              <span>Search markets, countries…</span>
              <kbd>/</kbd>
            </Link>
          )}
          <div className="header-tools">
            <div id="tour-clock">
              <GlobalMarketClock />
            </div>
            <button
              className="notification-button"
              aria-label="Notifications"
              onClick={() =>
                toast("You’re all caught up. Welcome to your global workspace.")
              }
            >
              <Bell size={18} />
              <span />
            </button>
            <div className="account-dropdown">
              <button
                className="account-button"
                onClick={() => setAccount(!account)}
                aria-expanded={account}
              >
                <span className="avatar">A</span>
                <ENSName address={wallet.address} />
                <ChevronDown size={13} />
              </button>
              {account && (
                <div className="account-menu">
                  <span>
                    <ShieldCheck size={14} />
                    World ID verified{" "}
                    {state.worldIdVerifiedDemo
                      ? "· Demo"
                      : state.worldIdEnvironment === "staging"
                        ? "· Simulator"
                        : ""}
                  </span>
                  <Link href="/wallet">Wallet details</Link>
                  <Link href="/onboarding" onClick={() => setAccount(false)}>
                    Review preferences
                  </Link>
                  <button
                    onClick={() =>
                      logout().catch(() => toast("Could not disconnect."))
                    }
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {children}
        <footer className="dashboard-footer">
          <span>
            <ShieldCheck size={13} />
            Wallet native. Human verified. Globally connected.
          </span>
          <span>Demo market data · For presentation purposes</span>
        </footer>
      </div>
    </div>
  );
}
