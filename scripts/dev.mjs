import { spawn } from "node:child_process";
import "./setup.mjs";
const root = new URL("../", import.meta.url);
const children = ["backend", "frontend"].map((folder) =>
  spawn("npm", ["run", "dev"], {
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
for (const child of children)
  child.on("exit", (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code || 0;
    }
  });

for (const child of children)
  child.on("error", (error) => {
    console.error("Could not start Atlas:", error.message);
    stop();
    process.exitCode = 1;
  });
