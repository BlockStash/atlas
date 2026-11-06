import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
export function processLock(file: string, label: string) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw Error(`Inspect the ${label} lock file.`);
    try {
      process.kill(pid, 0);
      console.log(`${label} is already running.`);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch {
    console.log(`${label} is already starting.`);
    return false;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  process.once("exit", () => {
    try {
      if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
    } catch {}
  });
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  return true;
}
