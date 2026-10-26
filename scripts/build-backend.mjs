import { execFileSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const options = { cwd: fileURLToPath(root), stdio: "inherit" };

await rm(new URL("dist/", root), { recursive: true, force: true });

execFileSync(process.execPath, [
  fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json"))),
  "-p", "tsconfig.build.json",
], options);
execFileSync(process.execPath, [
  fileURLToPath(import.meta.resolve("tsc-alias/dist/bin/index.js")),
  "-p", "tsconfig.build.json", "--resolve-full-paths", "--resolve-full-extension", ".js",
], options);

await cp(new URL("plugins/sessions-pg/migrations/", root),
  new URL("dist/plugins/sessions-pg/migrations/", root), { recursive: true });
