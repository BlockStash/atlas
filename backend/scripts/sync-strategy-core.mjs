// Copies the shared strategy core from the frontend into the backend so both sides run
// identical spec, simulation and fee logic. Run after editing frontend/src/lib/strategy-core.ts:
//   npm run strategies:sync          (writes)    npm run strategies:check   (fails if stale)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SRC = `${root}../frontend/src/lib/strategy-core.ts`;
const OUT = `${root}src/strategies/core.ts`;
const IMPORT = 'import catalog from "@/lib/protocol/catalog.json";';

const source = readFileSync(SRC, "utf8");
if (!source.includes(IMPORT)) throw new Error(`Expected "${IMPORT}" in ${SRC}`);
const out =
  "// GENERATED from frontend/src/lib/strategy-core.ts by scripts/sync-strategy-core.mjs. Do not edit.\n" +
  source.replace(
    IMPORT,
    'import catalog from "../protocol/catalog.json" with { type: "json" };',
  );

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (current !== out) {
    console.error("backend/src/strategies/core.ts is stale. Run: npm run strategies:sync");
    process.exit(1);
  }
  console.log("strategy core in sync");
} else {
  writeFileSync(OUT, out);
  console.log("wrote src/strategies/core.ts");
}
