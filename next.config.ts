import type { NextConfig } from "next";

const isDesktopBuild = process.env.TAURI_DESKTOP === "1";

const nextConfig: NextConfig = isDesktopBuild
  ? {
      output: "export",
      distDir: "desktop-dist",
      images: { unoptimized: true },
    }
  : {};

export default nextConfig;
