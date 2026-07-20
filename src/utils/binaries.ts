import { existsSync } from "node:fs";
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

/** Where pip installed piper's bundled espeak-ng phoneme data. The piper
 *  binary/extension has a build-time-hardcoded fallback path that never
 *  matches a real install, so callers must always pass ESPEAK_DATA_PATH
 *  explicitly (see piper-client.ts) rather than relying on piper's default. */
export function localPiperEspeakDataDir(): string | undefined {
  const win = resolve(".edge-tts-venv", "Lib", "site-packages", "piper", "espeak-ng-data");
  if (existsSync(win)) return win;
  return undefined;
}
