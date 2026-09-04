// Assembles desktop/staging/ — everything the Inno Setup installer packages.
// Run via: node scripts/prepare-desktop-build.mjs
// Requires: npm run build (dist/ up to date), and node/node.exe already
// placed at desktop/node/ (portable Windows Node runtime).
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  copy(join(ROOT, "scripts", "supertonic-synth.py"), join(STAGING, "scripts", "supertonic-synth.py"));
  copy(join(ROOT, "scripts", "gtts-fallback.py"), join(STAGING, "scripts", "gtts-fallback.py"));
  copy(join(ROOT, "scripts", "vieneu-synth.py"), join(STAGING, "scripts", "vieneu-synth.py"));
  // VieNeu is the app's default voice — its own venv (see binaries.ts's
  // localVieneuPython comment for why it can't share .edge-tts-venv) and its
  // ~700MB Hugging Face model cache (see VIENEU_HF_CACHE_ENV in binaries.ts)
  // ship inside the installer so a fresh machine never needs a Python/pip
  // setup step or an internet download just to generate its first voice line.
  copy(join(ROOT, ".vieneu-venv"), join(STAGING, ".vieneu-venv"));
  copy(join(ROOT, "hf-cache"), join(STAGING, "hf-cache"));
  copy(join(ROOT, "desktop", "hidden-launch.vbs"), join(STAGING, "hidden-launch.vbs"));
  copy(join(ROOT, "desktop", "electron-main.cjs"), join(STAGING, "electron-main.cjs"));
  copy(join(ROOT, "desktop", "icon.ico"), join(STAGING, "icon.ico"));
  copy(join(ROOT, "package.json"), join(STAGING, "package.json"));
  copy(join(ROOT, "package-lock.json"), join(STAGING, "package-lock.json"));

  // electron-packager reads "main" from this package.json to find the app's
  // entry point — the root package.json's own "main" (src/cli.ts) is for
  // the CLI pipeline, unrelated to the desktop app window.
  const stagingPkgPath = join(STAGING, "package.json");
  const stagingPkg = JSON.parse(readFileSync(stagingPkgPath, "utf8"));
  stagingPkg.main = "electron-main.cjs";
  writeFileSync(stagingPkgPath, JSON.stringify(stagingPkg, null, 2));

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
