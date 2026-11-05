"use client";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { markets } from "@/lib/data";
import { MarketClock } from "./ui";
// Orthographic projection of a point-cloud globe. The continent shapes and orbit lines
// stay as vectors at every screen size; no external image requests are needed.
const shapes = [
  [
    [-17, 36],
    [5, 37],
    [32, 31],
    [44, 11],
    [37, -5],
    [31, -28],
    [18, -35],
    [8, -22],
    [-1, 5],
    [-16, 14],
  ],
  [
    [-10, 36],
    [-10, 57],
    [5, 71],
    [30, 70],
    [47, 56],
    [85, 73],
    [130, 65],
    [165, 60],
    [150, 40],
    [130, 30],
    [122, 8],
    [105, -5],
    [91, 7],
    [78, 6],
    [65, 25],
    [44, 30],
    [28, 40],
    [12, 35],
  ],
  [
    [-168, 70],
    [-128, 73],
    [-82, 55],
    [-53, 47],
    [-80, 25],
    [-100, 17],
    [-118, 32],
    [-150, 58],
  ],
  [
    [-81, 12],
    [-62, 9],
    [-36, -5],
    [-43, -23],
    [-67, -55],
    [-76, -30],
  ],
  [
    [112, -11],
    [139, -12],
    [154, -28],
    [146, -39],
    [116, -34],
  ],
  [
    [-52, 60],
    [-25, 73],
    [-40, 83],
    [-61, 79],
  ],
];
function inside(x: number, y: number, poly: number[][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      c = !c;
  }
  return c;
}
// Keep SVG attributes stable across server and browser JavaScript engines.
const precise = (value: number) => Number(value.toFixed(4));
function project(lon: number, lat: number) {
  const a = ((lon - 26) * Math.PI) / 180,
    b = (lat * Math.PI) / 180;
  return {
    x: precise(280 + 208 * Math.cos(b) * Math.sin(a)),
    y: precise(255 - 208 * Math.sin(b)),
    z: precise(Math.cos(b) * Math.cos(a)),
  };
}
const dots: { x: number; y: number; z: number }[] = [];
for (let lat = -68; lat <= 80; lat += 3)
  for (let lon = -180; lon < 180; lon += 3) {
    const p = project(lon, lat);
    if (p.z > 0 && shapes.some((s) => inside(lon, lat, s))) dots.push(p);
  }
export function Globe({ onMarket }: { onMarket: () => void }) {
  return (
    <div className="globe-scene">
      <div className="globe-aura" />
      <svg
        className="globe-svg"
        viewBox="0 0 560 530"
        aria-label="Globe connecting five global markets"
        role="img"
      >
        <defs>
          <radialGradient id="sphere">
            <stop offset="0" stopColor="#142a46" stopOpacity=".6" />
            <stop offset=".8" stopColor="#11263e" stopOpacity=".2" />
            <stop offset="1" stopColor="#274a70" stopOpacity=".4" />
          </radialGradient>
          <radialGradient id="globe-edge">
            <stop offset=".88" stopColor="#486a9a" stopOpacity="0" />
            <stop offset="1" stopColor="#7eabed" stopOpacity=".3" />
          </radialGradient>
          <linearGradient id="orbit">
            <stop stopColor="#739de0" stopOpacity="0" />
            <stop offset=".5" stopColor="#739de0" stopOpacity=".7" />
            <stop offset="1" stopColor="#739de0" stopOpacity="0" />
          </linearGradient>
        </defs>
        <ellipse
          cx="280"
          cy="255"
          rx="251"
          ry="92"
          transform="rotate(-28 280 255)"
          stroke="#496a9c"
          strokeOpacity=".2"
          fill="none"
        />
        <circle
          cx="280"
          cy="255"
          r="209"
          fill="url(#sphere)"
          stroke="#496587"
          strokeOpacity=".3"
        />
        {[-55, -30, 0, 30, 55].map((n) => (
          <ellipse
            key={n}
            cx="280"
            cy={precise(255 - 208 * Math.sin((n * Math.PI) / 180))}
            rx={precise(208 * Math.cos((n * Math.PI) / 180))}
            ry={precise(16 * Math.cos((n * Math.PI) / 180))}
            fill="none"
            stroke="#779acd"
            strokeOpacity=".09"
          />
        ))}
        {[-70, -40, 0, 40, 70].map((n) => (
          <ellipse
            key={n}
            cx="280"
            cy="255"
            rx={precise(Math.max(15, 208 * Math.cos((n * Math.PI) / 180)))}
            ry="208"
            fill="none"
            stroke="#779acd"
            strokeOpacity=".1"
          />
        ))}
        {dots.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r="1.6"
            fill="#7a9fcf"
            opacity={precise(0.23 + p.z * 0.55)}
          />
        ))}
        <circle cx="280" cy="255" r="208" fill="url(#globe-edge)" />
        <path
          d="M138 178 Q270 30 410 226 M276 147 Q360 120 408 225 M276 147 Q330 205 340 268"
          fill="none"
          stroke="url(#orbit)"
          strokeWidth="1.2"
          strokeDasharray="4 5"
        />
        {[
          { x: 138, y: 178 },
          { x: 276, y: 147 },
          { x: 340, y: 268 },
          { x: 408, y: 225 },
          { x: 292, y: 153 },
        ].map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="11" fill="#86b2ff" opacity=".08" />
            <circle cx={p.x} cy={p.y} r="4" fill="#bad3ff" />
            <circle cx={p.x} cy={p.y} r="2" fill="#fff" />
          </g>
        ))}
        <ellipse
          cx="280"
          cy="255"
          rx="251"
          ry="92"
          transform="rotate(-28 280 255)"
          stroke="url(#orbit)"
          strokeWidth="1"
          fill="none"
          strokeDasharray="200 750"
        />
      </svg>
      {markets.map((m, i) => (
        <motion.button
          key={m.id}
          className={`floating-market floating-${m.id}`}
          onClick={onMarket}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: [0, -5, 0] }}
          transition={{
            opacity: { delay: 0.1 * i, duration: 0.5 },
            y: {
              delay: i * 0.7,
              duration: 7,
              repeat: Infinity,
              ease: "easeInOut",
            },
          }}
        >
          <div>
            <span className="flag">{m.flag}</span>
            <strong>
              {m.name === "United States"
                ? "UNITED STATES"
                : m.name === "United Kingdom"
                  ? "UNITED KINGDOM"
                  : m.name.toUpperCase()}
            </strong>
            <ArrowUpRight size={12} />
          </div>
          <p>{m.exchange}</p>
          <footer>
            <MarketClock market={m} />
            <span className={`market-status ${m.open ? "" : "closed"}`}>
              {m.open ? "● OPEN" : "○ CLOSED"}
            </span>
          </footer>
        </motion.button>
      ))}
      <div className="globe-caption">
        <span className="status-dot" /> CONNECTED BY ATLAS
        <span className="caption-line" />
        BORDERLESS BY DESIGN
      </div>
    </div>
  );
}
