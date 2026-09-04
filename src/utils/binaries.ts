import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

function packageBinary(packageName: string): string | undefined {
  try {
    const mod = require(packageName) as string | { path?: string };
    const candidate = typeof mod === "string" ? mod : mod.path;
    return candidate && existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function localEdgeTtsBinary(): string | undefined {
  const exe = resolve(".edge-tts-venv", "Scripts", "edge-tts.exe");
  const cmd = resolve(".edge-tts-venv", "Scripts", "edge-tts.cmd");
  const linux = resolve(".edge-tts-venv", "bin", "edge-tts");
  if (existsSync(exe)) return exe;
  if (existsSync(cmd)) return cmd;
  if (existsSync(linux)) return linux;
  return undefined;
}

function localEdgeTtsPython(): string | undefined {
  const win = resolve(".edge-tts-venv", "Scripts", "python.exe");
  const linux = resolve(".edge-tts-venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(linux)) return linux;
  return undefined;
}

export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? packageBinary("ffmpeg-static") ?? "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH ?? packageBinary("ffprobe-static") ?? "ffprobe";
export const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN ?? localEdgeTtsBinary() ?? "edge-tts";
export const EDGE_TTS_PYTHON = process.env.EDGE_TTS_PYTHON ?? localEdgeTtsPython() ?? "python";

// Piper (local Vietnamese voices) shares the edge-tts venv — installed there
// by scripts/install-edge-tts.mjs.
export const PIPER_PYTHON = EDGE_TTS_PYTHON;
export const PIPER_VOICES_DIR = resolve(".piper-voices");

function localPiperBinary(): string | undefined {
  const exe = resolve(".edge-tts-venv", "Scripts", "piper.exe");
  const linux = resolve(".edge-tts-venv", "bin", "piper");
  if (existsSync(exe)) return exe;
  if (existsSync(linux)) return linux;
  return undefined;
}

// The `piper` console-script entry point (installed alongside python in the
// venv by pip), NOT `python -m piper`. Invoking the module via stdin text
// measurably compresses/rushes the first thing it speaks in each call
// (confirmed by direct A/B timing: the same phrase took 887ms via `python
// -m piper` + stdin vs 1061ms via this console script + `-i` file input,
// vs a 1060ms natural non-first-in-invocation benchmark) — the console
// script's own `-i`/`-f` file-based flow doesn't have that problem, and
// also exposes `--sentence-silence` so a whole multi-sentence scene can be
// synthesized in one call instead of one call per sentence.
export const PIPER_BIN = process.env.PIPER_BIN ?? localPiperBinary() ?? "piper";

/** Where pip installed piper's bundled espeak-ng phoneme data. The piper
 *  binary/extension has a build-time-hardcoded fallback path that never
 *  matches a real install, so callers must always pass ESPEAK_DATA_PATH
 *  explicitly (see piper-client.ts) rather than relying on piper's default. */
export function localPiperEspeakDataDir(): string | undefined {
  const win = resolve(".edge-tts-venv", "Lib", "site-packages", "piper", "espeak-ng-data");
  if (existsSync(win)) return win;
  // Linux venvs (Render) use "lib/pythonX.Y/site-packages" instead of "Lib" —
  // the minor version varies by build image, so find whichever exists.
  const libDir = resolve(".edge-tts-venv", "lib");
  if (existsSync(libDir)) {
    for (const entry of readdirSync(libDir)) {
      const candidate = resolve(libDir, entry, "site-packages", "piper", "espeak-ng-data");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether the supertonic pip package is installed in the local venv — the
 *  model itself auto-downloads on first real synthesis call, so this is
 *  just a proxy for "is this instance set up to use it at all". */
export function isSupertonicInstalled(): boolean {
  return existsSync(resolve(".edge-tts-venv", "Lib", "site-packages", "supertonic"));
}

// VieNeu-TTS (vieneu on PyPI) has its own dedicated Vietnamese phonemizer
// (sea-g2p) instead of espeak-ng — confirmed to actually get ngã/hỏi tones
// right where every one of the 31 local Piper voices got them wrong. It
// needs its OWN separate venv, not the shared .edge-tts-venv one: one of
// its dependencies (kaldi-native-fbank) only ships prebuilt wheels up to
// Python 3.12, and .edge-tts-venv runs on whatever Python built it (3.14
// here), which forces a from-source build that fails without a C++
// compiler toolchain installed. A dedicated Python 3.11 venv sidesteps
// that entirely.
function localVieneuPython(): string | undefined {
  const win = resolve(".vieneu-venv", "Scripts", "python.exe");
  const linux = resolve(".vieneu-venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(linux)) return linux;
  return undefined;
}
export const VIENEU_PYTHON = process.env.VIENEU_PYTHON ?? localVieneuPython() ?? "python";
export const VIENEU_VENV_DIR = resolve(".vieneu-venv");

export function isVieneuInstalled(): boolean {
  return existsSync(resolve(".vieneu-venv", "Lib", "site-packages", "vieneu"));
}

// The vieneu package downloads its ~700MB model from the Hugging Face Hub
// into $HF_HOME/hub on first use — fine on the dev machine where that cache
// already exists, but a fresh install (a new laptop) would otherwise need a
// working internet connection and several minutes on its very first voice
// generation. Bundling a pre-populated cache next to the venv and pointing
// HF_HOME at it during the synth call sidesteps that entirely — only
// applied when the bundled folder is actually present, so this dev
// environment keeps using its normal ~/.cache/huggingface untouched.
export const VIENEU_HF_CACHE_DIR = resolve("hf-cache");
export const VIENEU_HF_CACHE_ENV = existsSync(VIENEU_HF_CACHE_DIR) ? { HF_HOME: VIENEU_HF_CACHE_DIR } : undefined;
