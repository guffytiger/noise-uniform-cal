# Desktop app (Tauri)

This folder contains only the Tauri desktop shell. The Next.js website remains at
the repository root and keeps its normal `npm run dev` and `npm run build` commands.

## Commands from the repository root

- `npm run desktop:dev` opens the desktop app in development mode.
- `npm run desktop:build` creates a portable Windows executable without an installer.

The portable executable is copied to this repository-root folder:

`desktop-release/Noise Uniform Calculator.exe`

The desktop build generates static frontend assets in `desktop-dist/`. Both build
folders are ignored by Git and do not affect the website build output.

On managed Windows machines, the build requires an Application Control policy that
allows Cargo to execute unsigned generated `build-script-build.exe` files. This is
only needed while compiling; end users only receive the final portable executable.
