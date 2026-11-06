"use client";
import {
  Anchor,
  Atom,
  Banknote,
  Bitcoin,
  Brain,
  Check,
  Coins,
  Compass,
  Cpu,
  Crown,
  Diamond,
  Factory,
  Feather,
  Flame,
  Gem,
  Globe,
  Landmark,
  Leaf,
  Moon,
  Mountain,
  Orbit,
  PiggyBank,
  Rocket,
  Shield,
  Sprout,
  Star,
  Sun,
  Target,
  Telescope,
  TrendingUp,
  Trophy,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  STRATEGY_COLORS,
  STRATEGY_ICONS,
  iconKey,
  type StrategyColor,
  type StrategyIcon,
  type StrategyIconName,
} from "@/lib/strategies";

const GLYPHS: Record<StrategyIconName, LucideIcon> = {
  Rocket,
  Globe,
  Gem,
  Flame,
  Zap,
  Leaf,
  Shield,
  Mountain,
  Anchor,
  Compass,
  Crown,
  Target,
  TrendingUp,
  Landmark,
  Coins,
  Bitcoin,
  Cpu,
  Sun,
  Moon,
  Waves,
  Sprout,
  Diamond,
  Feather,
  Atom,
  Orbit,
  Factory,
  Banknote,
  PiggyBank,
  Trophy,
  Star,
  Brain,
  Telescope,
};

/** Foreground colour per palette entry; the badge background is a tint of it. */
const HUES: Record<StrategyColor, string> = {
  blue: "#91b2ff",
  violet: "#c9b2ff",
  green: "#68c7aa",
  amber: "#f2c77a",
  rose: "#f29bb0",
  cyan: "#7fd6e8",
  orange: "#f5a66b",
};

export function StrategyIconBadge({
  icon,
  size = 40,
  title,
}: {
  icon: StrategyIcon;
  size?: number;
  title?: string;
}) {
  const Glyph = GLYPHS[icon.name] ?? Rocket;
  const hue = HUES[icon.color] ?? HUES.blue;
  return (
    <span
      className="strategy-icon"
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        color: hue,
        background: `linear-gradient(135deg, ${hue}33, ${hue}12)`,
        borderColor: `${hue}55`,
      }}
    >
      <Glyph size={Math.round(size * 0.52)} strokeWidth={1.9} />
    </span>
  );
}

/** Choose a glyph and colour. Combinations used by other strategies are disabled. */
export function IconPicker({
  value,
  onChange,
  taken,
}: {
  value: StrategyIcon;
  onChange: (icon: StrategyIcon) => void;
  taken: Set<string>;
}) {
  const inUse = (icon: StrategyIcon) =>
    taken.has(iconKey(icon)) && iconKey(icon) !== iconKey(value);
  const setColor = (color: StrategyColor) => {
    // Keep the glyph if that colour is free; otherwise move to the first free glyph.
    const same = { name: value.name, color };
    if (!inUse(same)) return onChange(same);
    const free = STRATEGY_ICONS.find((name) => !inUse({ name, color }));
    if (free) onChange({ name: free, color });
  };
  return (
    <div className="icon-picker">
      <div
        className="icon-picker-colors"
        role="radiogroup"
        aria-label="Icon colour"
      >
        {STRATEGY_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={value.color === color}
            aria-label={color}
            className={value.color === color ? "active" : ""}
            style={{ background: HUES[color] }}
            onClick={() => setColor(color)}
          >
            {value.color === color && <Check size={13} strokeWidth={3} />}
          </button>
        ))}
      </div>
      <div className="icon-picker-grid" role="radiogroup" aria-label="Icon">
        {STRATEGY_ICONS.map((name) => {
          const icon = { name, color: value.color };
          const used = inUse(icon);
          const active = value.name === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${name}${used ? " (used by another strategy)" : ""}`}
              title={
                used ? "Already used by another strategy in this colour" : name
              }
              disabled={used}
              className={active ? "active" : ""}
              onClick={() => onChange(icon)}
            >
              <StrategyIconBadge icon={icon} size={38} />
            </button>
          );
        })}
      </div>
      <small className="muted">
        Each icon and colour pair is unique, so your strategy is easy to spot.
        Greyed-out icons are already taken in this colour.
      </small>
    </div>
  );
}
