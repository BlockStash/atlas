"use client";
import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { SKIN_KEY, THEME_KEY, type Skin, type Theme } from "@/lib/theme";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-skin"],
  });
  return () => observer.disconnect();
}
const read = (): Theme =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "dark" as Theme);
  const setTheme = (next: Theme) => {
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not persisted; still applies for this visit.
    }
  };
  return { theme, setTheme };
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

const readSkin = (): Skin =>
  document.documentElement.dataset.skin === "ethglobal" ? "ethglobal" : "atlas";

export function useSkin() {
  const skin = useSyncExternalStore(subscribe, readSkin, () => "atlas" as Skin);
  const setSkin = (next: Skin) => {
    if (next === "ethglobal")
      document.documentElement.dataset.skin = "ethglobal";
    else delete document.documentElement.dataset.skin;
    try {
      localStorage.setItem(SKIN_KEY, next);
    } catch {
      // Not persisted; still applies for this visit.
    }
  };
  return { skin, setSkin };
}

/** The four-diamond motif from the ETHGlobal Mumbai artwork. */
function EthGlobalGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12 4.5 14 12 12 9.6 10 12Z M12 19.5 10 12 12 14.4 14 12Z M4.5 12 12 10 9.6 12 12 14Z M19.5 12 12 14 14.4 12 12 10Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Switches the ETHGlobal Mumbai skin on or off. Works with both light and dark mode. */
export function SkinToggle({ className = "" }: { className?: string }) {
  const { skin, setSkin } = useSkin();
  const on = skin === "ethglobal";
  const label = on
    ? "Turn off ETHGlobal Mumbai mode"
    : "Turn on ETHGlobal Mumbai mode";
  return (
    <button
      type="button"
      className={`theme-toggle skin-toggle ${on ? "on" : ""} ${className}`}
      onClick={() => setSkin(on ? "atlas" : "ethglobal")}
      aria-pressed={on}
      aria-label={label}
      title={label}
    >
      <EthGlobalGlyph />
    </button>
  );
}
