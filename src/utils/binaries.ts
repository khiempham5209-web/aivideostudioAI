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
  if (existsSync(exe)) return exe;
  if (existsSync(cmd)) return cmd;
  return undefined;
}

export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? packageBinary("ffmpeg-static") ?? "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH ?? packageBinary("ffprobe-static") ?? "ffprobe";
export const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN ?? localEdgeTtsBinary() ?? "edge-tts";
