import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2),
  local = spawnSync("solc", ["--version"], { encoding: "utf8" });
if (local.status === 0 && local.stdout.includes("0.8.33"))
  args.push(
    "--use",
    process.env.PATH.split(":")
      .map((path) => join(path, "solc"))
      .find((path) => existsSync(path)),
  );
const result = spawnSync("forge", args, {
  cwd: new URL("../", import.meta.url),
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
