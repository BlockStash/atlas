import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
for (const [source, target] of [
  ["frontend/.env.example", "frontend/.env.local"],
  ["backend/.env.example", "backend/.env"],
]) {
  const destination = new URL(target, root);
  if (!existsSync(destination)) {
    copyFileSync(new URL(source, root), destination);
    console.log(`Created ${target}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(`Atlas is ready in ${fileURLToPath(root)}. Run npm run dev.`);
