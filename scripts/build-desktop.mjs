import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");
const result = spawnSync(process.execPath, [nextCli, "build"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, TAURI_DESKTOP: "1" },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
