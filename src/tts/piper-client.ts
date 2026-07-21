import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_BIN, PIPER_PYTHON, PIPER_VOICES_DIR, localPiperEspeakDataDir } from "../utils/binaries.js";
import { EdgeTtsClient } from "./edge-client.js";

export interface PiperOpts {
  /** Piper voice id, e.g. "vi_VN-vivos-x_low" — matches the .onnx filename in PIPER_VOICES_DIR. */
  voiceId: string;
}

let cachedEspeakDataDir: string | undefined;

/**
 * Piper's espeak-ng phoneme lookup is a native extension with a build-time
 * path baked in (never matches a real install) and separately chokes on
 * non-ASCII path segments (this repo's own path has one). Copying the
 * bundled data to a fixed temp dir once sidesteps both problems — every
 * later call just points ESPEAK_DATA_PATH at this copy.
 */
function ensureEspeakDataDir(): string | undefined {
  if (cachedEspeakDataDir) return cachedEspeakDataDir;
  const source = localPiperEspeakDataDir();
  if (!source) return undefined;
  const target = join(tmpdir(), "piper-espeak-ng-data");
  if (!existsSync(join(target, "phontab"))) {
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  cachedEspeakDataDir = target;
  return target;
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { env: options.env, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} failed (exit ${code}): ${stderr.slice(-800)}`))));
    proc.on("error", reject);
    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin, "utf-8");
      proc.stdin.end();
    }
  });
}

export class PiperClient {
  private voiceId: string;

  constructor(options: PiperOpts) {
    this.voiceId = options.voiceId;
  }

  async generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void> {
    const modelPath = join(PIPER_VOICES_DIR, `${this.voiceId}.onnx`);
    if (!existsSync(modelPath)) {
      throw new Error(`Piper voice model not found: ${modelPath} (run npm run postinstall to download it)`);
    }

    const wavPath = `${audioOutPath}.piper.wav`;
    const espeakDataDir = ensureEspeakDataDir();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (espeakDataDir) env.ESPEAK_DATA_PATH = espeakDataDir;

    try {
      await run(PIPER_PYTHON, ["-m", "piper", "--model", modelPath, "--output_file", wavPath], { env, stdin: text });
      await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
      await rm(wavPath, { force: true });
    } catch (error) {
      // Known, unresolved bug in Piper's bundled Windows espeak-ng data: it
      // throws on common Vietnamese words (verified: "học", "đọc", "họ",
      // "giỏi" all fail identically across piper-tts 1.3.0–1.5.0) instead of
      // just mispronouncing them. Rather than let one bad word kill an
      // entire scene's narration, fall back to Edge TTS for this line only.
      console.warn(`Piper TTS failed for this text, falling back to Edge TTS: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      await rm(wavPath, { force: true });
      const fallback = new EdgeTtsClient({ voice: "vi-VN-HoaiMyNeural" });
      await fallback.generate(text, audioOutPath, srtOutPath);
      return;
    }

    if (srtOutPath) {
      await writeFile(srtOutPath, "", "utf-8");
    }
  }
}
