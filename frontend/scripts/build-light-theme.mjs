// Generates src/app/theme-light.generated.css from src/app/globals.css.
//
// The dark theme hard-codes ~650 colours, so instead of hand-maintaining a second palette this
// mirrors every colour-bearing declaration under :root[data-theme="light"], remapped by role:
//   text-like (color, fill, stroke…)  light → dark, keeping hue; dark text on light fills stays.
//   surfaces (background, borders)     dark → near-white; white overlays → black overlays;
//                                      accent fills stay; accent tints get a little stronger.
//   shadows                            black shadows soften; glows dim.
// Rule order, media queries and !important are preserved, so the cascade matches the dark theme.
// Re-run after editing globals.css:  npm run theme:light
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const root = fileURLToPath(new URL("..", import.meta.url));
const SRC = `${root}src/app/globals.css`;
const OUT = `${root}src/app/theme-light.generated.css`;
const SCOPE = ':root[data-theme="light"]';

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function parse(token) {
  const t = token.toLowerCase();
  if (t === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (t === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (t[0] === "#") {
    let h = t.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const m = t.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (v) =>
      v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v);
    const al =
      p[3] === undefined
        ? 1
        : p[3].endsWith("%")
          ? parseFloat(p[3]) / 100
          : parseFloat(p[3]);
    return { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]), a: al };
  }
  return null;
}

function toHsl({ r, g, b, a }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h =
      max === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l, a };
}

function format({ h, s, l, a }) {
  const f = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r = l,
    g = l,
    b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
      p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }
  const hex = (v) =>
    Math.round(clamp(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a) : ""}`;
}

const text = (c) => {
  if (c.l <= 0.5) return c; // already dark (e.g. navy text on light accent fills)
  if (c.l >= 0.88) return { ...c, s: c.s * 0.35, l: clamp(1 - c.l, 0.1, 0.45) }; // body text → ink
  if (c.s > 0.35)
    return { ...c, s: c.s * 0.8, l: Math.min(0.44, 1 - c.l + 0.18) }; // accent text
  return { ...c, l: clamp(1 - c.l, 0.1, 0.45) }; // grey text
};
const surface = (c) => {
  if (c.a < 1 && c.l > 0.85)
    return { h: 0, s: 0, l: 0, a: clamp(c.a * 0.9, 0.02, 1) }; // white overlay
  if (c.l < 0.3) return { ...c, s: c.s * 0.55, l: 1 - c.l * 0.45 }; // dark surface
  if (c.a < 1) return { ...c, l: c.l * 0.82, a: clamp(c.a * 1.25) }; // accent tint
  if (c.l > 0.85 && c.s < 0.3) return { ...c, l: 1 - c.l }; // inverted light-grey chip
  return c; // opaque accent fill
};
const shadow = (c) => {
  if (c.a === 1 && c.l < 0.3) return surface(c); // solid gap ring matching the page
  if (c.l < 0.2) return { ...c, a: c.a * 0.3 };
  if (c.l > 0.9) return c; // inset highlight
  return { ...c, a: c.a * 0.6 };
};

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
const TEXT_PROPS =
  /^(color|fill|stroke|caret-color|outline-color|text-decoration-color|-webkit-text-fill-color|accent-color)$/;
const SURFACE_PROPS =
  /^(background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline|column-rule(-color)?)$/;
const SHADOW_PROPS = /^(box-shadow|text-shadow|filter)$/;
const VAR_ROLE = {
  "--bg": surface,
  "--panel": surface,
  "--border": surface,
  "--muted": text,
  "--text": text,
  "--blue": text,
  "--green": text,
  "--red": text,
};

function roleFor(prop, rule) {
  if (prop.startsWith("--")) return VAR_ROLE[prop] ?? null;
  if (TEXT_PROPS.test(prop)) return text;
  if (SHADOW_PROPS.test(prop)) return shadow;
  if (SURFACE_PROPS.test(prop)) {
    // Gradient text (background-clip: text) reads as text.
    const clipped = rule.nodes.some(
      (d) =>
        d.type === "decl" &&
        /background-clip$/.test(d.prop) &&
        d.value.includes("text"),
    );
    return clipped && prop.startsWith("background") ? text : surface;
  }
  return null;
}

function scopeSelector(sel) {
  return sel
    .split(",")
    .map((s) => {
      s = s.trim();
      if (s.startsWith(":root")) return SCOPE + s.slice(5);
      if (s.startsWith("html")) return `html[data-theme="light"]${s.slice(4)}`;
      return `${SCOPE} ${s}`;
    })
    .join(",\n");
}

const css = postcss.parse(readFileSync(SRC, "utf8"));
const out = postcss.root();
let count = 0;

function walk(container, target) {
  container.each((node) => {
    if (node.type === "atrule") {
      if (!["media", "supports"].includes(node.name)) return; // skip keyframes, @property, @import…
      const at = postcss.atRule({
        name: node.name,
        params: node.params,
        nodes: [],
      });
      walk(node, at);
      if (at.nodes?.length) target.append(at);
      return;
    }
    if (node.type !== "rule" || node.selector.includes("data-theme")) return;
    const decls = [];
    node.each((d) => {
      if (d.type !== "decl") return;
      if (d.prop === "color-scheme")
        return decls.push(
          postcss.decl({
            prop: d.prop,
            value: "light",
            important: d.important,
          }),
        );
      const role = roleFor(d.prop, node);
      if (!role || !COLOR.test(d.value)) return;
      COLOR.lastIndex = 0;
      const value = d.value.replace(COLOR, (m) => {
        const c = parse(m);
        return c ? format(role(toHsl(c))) : m;
      });
      if (value !== d.value)
        decls.push(
          postcss.decl({ prop: d.prop, value, important: d.important }),
        );
    });
    if (decls.length) {
      count += decls.length;
      target.append(
        postcss.rule({ selector: scopeSelector(node.selector), nodes: decls }),
      );
    }
  });
}
walk(css, out);

writeFileSync(
  OUT,
  `/* GENERATED by scripts/build-light-theme.mjs from globals.css. Do not edit; run \`npm run theme:light\`.\n   Hand-tuned light-mode fixes live in theme-light.css. */\n${out.toString()}\n`,
);
console.log(`theme-light.generated.css: ${count} declarations`);
