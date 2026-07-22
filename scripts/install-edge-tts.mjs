import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = process.cwd();
const venvDir = resolve(root, ".edge-tts-venv");
const piperVoicesDir = resolve(root, ".piper-voices");
const edgeTtsBin =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "edge-tts.exe")
    : join(venvDir, "bin", "edge-tts");
const pythonBin =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");

// Local Vietnamese Piper voices — offline, CPU-only, no GPU needed. Quality
// is lower than Edge TTS's neural voices, but they're 3 more real, distinct
// local voice options alongside Edge's 2 — see voice-catalog.ts.
const PIPER_VOICES = ["vi_VN-25hours_single-low", "vi_VN-vais1000-medium", "vi_VN-vivos-x_low"];

function quoteIfNeeded(value) {
  return typeof value === "string" && value.includes(" ") && !value.startsWith('"') ? `"${value}"` : value;
}

function run(command, args, options = {}) {
  // shell:true on Windows joins the command + args with plain spaces without
  // quoting them — any piece containing a space (e.g. an install path like
  // "Program Files" or "AI Video Studio") silently gets split into two
  // tokens by cmd.exe. Quote both the command itself and every arg.
  const isWin = process.platform === "win32";
  const quotedCommand = isWin ? quoteIfNeeded(command) : command;
  const quotedArgs = isWin ? args.map(quoteIfNeeded) : args;
  const result = spawnSync(quotedCommand, quotedArgs, {
    stdio: "inherit",
    shell: isWin,
    ...options,
  });
  return result.status === 0;
}

function findPython() {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];

  for (const [command, prefixArgs] of candidates) {
    const ok = spawnSync(command, [...prefixArgs, "--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    }).status === 0;
    if (ok) return { command, prefixArgs };
  }

  return null;
}

function installPiperVoices() {
  // Piper is a desktop-app-only feature (local CPU voices for the installed
  // .exe) — it has no reason to run during a Render deploy, and doing so
  // there added real risk: pip-installing piper-tts plus downloading 3
  // voice models (15-90MB each, from Hugging Face) inside the production
  // build step, which can slow down or outright break a deploy that
  // previously had no such network dependency. Skip it outright in that
  // environment; the desktop build's own first-run setup handles this.
  if (process.env.RENDER || process.env.VERCEL || process.env.APP_ENV === "production") {
    console.log("Skipping Piper voice setup (server/production environment — desktop-only feature).");
    return;
  }
  console.log("Ensuring piper-tts is installed");
  if (!run(pythonBin, ["-m", "pip", "install", "piper-tts"])) {
    console.error("Failed to install piper-tts — local Vietnamese voices will be unavailable.");
    return;
  }
  for (const voice of PIPER_VOICES) {
    const modelPath = join(piperVoicesDir, `${voice}.onnx`);
    if (existsSync(modelPath)) {
      console.log(`Piper voice already downloaded: ${voice}`);
      continue;
    }
    console.log(`Downloading Piper voice: ${voice}`);
    if (!run(pythonBin, ["-m", "piper.download_voices", "--download-dir", piperVoicesDir, voice])) {
      console.error(`Failed to download Piper voice "${voice}" — it will be unavailable.`);
    }
  }
}

function installSupertonic() {
  // Same reasoning as installPiperVoices() — desktop-only, skip on the server.
  if (process.env.RENDER || process.env.VERCEL || process.env.APP_ENV === "production") {
    console.log("Skipping Supertonic voice setup (server/production environment — desktop-only feature).");
    return;
  }
  console.log("Ensuring supertonic is installed");
  if (!run(pythonBin, ["-m", "pip", "install", "supertonic"])) {
    console.error("Failed to install supertonic — those local voices will be unavailable.");
    return;
  }
  const supertonicDir = join(venvDir, "Lib", "site-packages", "supertonic");
  const cacheMarker = join(process.env.USERPROFILE || process.env.HOME || ".", ".cache", "supertonic3");
  if (existsSync(supertonicDir) && existsSync(cacheMarker)) {
    console.log("Supertonic model already downloaded.");
    return;
  }
  console.log("Downloading Supertonic model (~400MB, first run only)...");
  if (!run(pythonBin, ["-c", "from supertonic import TTS; TTS(auto_download=True)"])) {
    console.error("Failed to download the Supertonic model — it will download lazily on first real use instead.");
  }
}

if (existsSync(edgeTtsBin) && existsSync(pythonBin)) {
  console.log(`edge-tts virtualenv already exists: ${edgeTtsBin}`);
  console.log("Ensuring gTTS fallback is installed");
  if (!run(pythonBin, ["-m", "pip", "install", "gTTS"])) {
    console.error("Failed to install gTTS fallback.");
    process.exit(1);
  }
  installPiperVoices();
  installSupertonic();
  process.exit(0);
}

const python = findPython();
if (!python) {
  console.error("Python is required to install edge-tts, but no python command was found.");
  process.exit(1);
}

console.log(`Creating edge-tts virtualenv at ${venvDir}`);
if (!run(python.command, [...python.prefixArgs, "-m", "venv", venvDir])) {
  console.error("Failed to create edge-tts virtualenv.");
  process.exit(1);
}

console.log("Installing edge-tts and gTTS into virtualenv");
if (!run(pythonBin, ["-m", "pip", "install", "--upgrade", "pip", "edge-tts", "gTTS"])) {
  console.error("Failed to install edge-tts.");
  process.exit(1);
}

if (!existsSync(edgeTtsBin)) {
  console.error(`edge-tts was installed, but binary was not found at ${edgeTtsBin}`);
  process.exit(1);
}

console.log(`edge-tts installed: ${edgeTtsBin}`);
installPiperVoices();
installSupertonic();
