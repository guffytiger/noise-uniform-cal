import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "desktop");
const cargoBin = join(process.env.USERPROFILE ?? "", ".cargo", "bin");
const separator = process.platform === "win32" ? ";" : ":";
const env = {
  ...process.env,
  PATH: `${cargoBin}${separator}${process.env.PATH ?? ""}`,
};

const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";
const result = spawnSync(yarnCommand, ["run", "build"], {
  cwd: desktop,
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.status !== 0) process.exit(result.status ?? 1);

const source = join(desktop, "src-tauri", "target", "release", "uniform-cal-desktop.exe");
const releaseDir = join(root, "desktop-release");
const destination = join(releaseDir, "Noise Uniform Calculator.exe");

if (!existsSync(source)) {
  console.error(`Portable executable was not found at ${source}`);
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
copyFileSync(source, destination);
console.log(`Portable app: ${destination}`);
