// Assembles desktop/staging/ — everything the Inno Setup installer packages.
// Run via: node scripts/prepare-desktop-build.mjs
// Requires: npm run build (dist/ up to date), and node/node.exe already
// placed at desktop/node/ (portable Windows Node runtime).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const STAGING = join(ROOT, "desktop", "staging");

function copy(src, dest, opts = {}) {
  if (!existsSync(src)) {
    console.log(`  skip (not found): ${src}`);
    return;
  }
  cpSync(src, dest, { recursive: true, ...opts });
  console.log(`  copied: ${src} -> ${dest}`);
}

function main() {
  const distEntry = join(ROOT, "dist", "api.js");
  if (!existsSync(distEntry)) {
    throw new Error('dist/api.js not found — run "npm run build" first');
  }
  const portableNode = join(ROOT, "desktop", "node", "node.exe");
  if (!existsSync(portableNode)) {
    throw new Error(
      "desktop/node/node.exe not found — download the portable Windows Node runtime and place it there first (see desktop/README.md)",
    );
  }

  console.log(`Resetting ${STAGING}`);
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  console.log("Copying app files...");
  copy(join(ROOT, "dist"), join(STAGING, "dist"));
  copy(join(ROOT, "public"), join(STAGING, "public"));
  copy(join(ROOT, "templates"), join(STAGING, "templates"));
  copy(join(ROOT, "assets"), join(STAGING, "assets"));
  copy(join(ROOT, "desktop", "node"), join(STAGING, "node"));
  copy(join(ROOT, "desktop", "version.json"), join(STAGING, "desktop", "version.json"));
  copy(join(ROOT, "scripts", "launch-desktop.mjs"), join(STAGING, "scripts", "launch-desktop.mjs"));
  copy(join(ROOT, "scripts", "install-edge-tts.mjs"), join(STAGING, "scripts", "install-edge-tts.mjs"));
  copy(join(ROOT, "desktop", "hidden-launch.vbs"), join(STAGING, "hidden-launch.vbs"));
  copy(join(ROOT, "package.json"), join(STAGING, "package.json"));
  copy(join(ROOT, "package-lock.json"), join(STAGING, "package-lock.json"));

  console.log("Installing production-only node_modules into staging (npm ci --omit=dev)...");
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: STAGING, stdio: "inherit", shell: true });

  // ffmpeg-static's own binary download runs as its "install" script, which
  // --ignore-scripts above skips — without this, node_modules/ffmpeg-static
  // has no ffmpeg.exe and every render/voice-preview fails with "spawn ffmpeg
  // ENOENT". Copy the binary already downloaded on THIS dev machine instead
  // of re-running the installer (avoids a network fetch during packaging).
  const ffmpegSrc = join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");
  const ffmpegDest = join(STAGING, "node_modules", "ffmpeg-static", "ffmpeg.exe");
  if (existsSync(ffmpegSrc) && existsSync(dirname(ffmpegDest))) {
    cpSync(ffmpegSrc, ffmpegDest);
    console.log(`  copied ffmpeg binary: ${ffmpegSrc} -> ${ffmpegDest}`);
  } else {
    console.warn("  WARNING: could not find ffmpeg-static's ffmpeg.exe to copy — run `npm install` at the repo root first, or renders will fail with ENOENT.");
  }

  console.log("\nStaging ready at:", STAGING);
  console.log("Next: run Inno Setup on desktop/installer.iss");
}

main();
