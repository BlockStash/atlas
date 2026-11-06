import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import "./setup.mjs";
const root = new URL("../", import.meta.url);
const backendEnvironment = readFileSync(new URL("backend/.env", root), "utf8");
const historicalDevelopment =
  process.env.PRICE_SOURCE === "historical-development" ||
  /^PRICE_SOURCE\s*=\s*["']?historical-development["']?\s*$/m.test(
    backendEnvironment,
  );
const developmentMarkets =
  process.env.ATLAS_DEVELOPMENT_MARKETS === "true" ||
  /^ATLAS_DEVELOPMENT_MARKETS\s*=\s*(?:true|"true"|'true')\s*$/m.test(
    readFileSync(new URL("backend/.env", root), "utf8"),
  );
const services = [
  { folder: "backend", script: "dev" },
  { folder: "frontend", script: "dev" },
  ...(developmentMarkets && process.env.NODE_ENV !== "production"
    ? [{ folder: "backend", script: "dev:markets" }]
    : []),
  ...(historicalDevelopment &&
  developmentMarkets &&
  process.env.NODE_ENV !== "production"
    ? [
        { folder: "backend", script: "prices:watch" },
        { folder: "backend", script: "prices:history:watch" },
      ]
    : []),
];
const children = services.map(({ folder, script }) =>
  spawn("npm", ["run", script], {
    cwd: new URL(`${folder}/`, root),
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH")
        console.error("Could not stop Atlas process:", error.message);
    }
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const [index, child] of children.entries())
  child.on("exit", (code) => {
    if (services[index].script !== "dev" && !stopping) {
      if (code)
        console.error(
          `${services[index].script} stopped. The app remains running; check its configuration and restart that task.`,
        );
      return;
    }
    if (!stopping) {
      stop();
      process.exitCode = code || 0;
    }
  });

for (const [index, child] of children.entries())
  child.on("error", (error) => {
    console.error("Could not start Atlas:", error.message);
    if (services[index].script !== "dev") return;
    stop();
    process.exitCode = 1;
  });
