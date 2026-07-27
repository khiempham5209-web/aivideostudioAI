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

// Piper's bundled espeak-ng occasionally hangs instead of throwing on
// certain input (a variant of the known Vietnamese-diacritic bug — see the
// fallback comment below) — without a timeout, one bad scene stalls the
// entire sequential TTS queue (TTS_CONCURRENCY defaults to 1) forever.
const PIPER_TIMEOUT_MS = 60_000;

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { env: options.env, windowsHide: true });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${PIPER_TIMEOUT_MS}ms (hung, no exit)`));
    }, PIPER_TIMEOUT_MS);
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(`${command} failed (exit ${code}): ${stderr.slice(-800)}`));
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
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
    // Without this, Python's stdin on Windows decodes under the system
    // codepage instead of UTF-8, mangling multi-byte characters (e.g. the
    // curly quotes "..." U+201C/U+201D) into invalid lone surrogates and
    // crashing piper's espeak-ng phonemizer with UnicodeEncodeError. This
    // was previously misdiagnosed as an unfixable espeak-ng bug on certain
    // Vietnamese words — it's actually this encoding mismatch.
    env.PYTHONUTF8 = "1";
    env.PYTHONIOENCODING = "utf-8";

    try {
      await run(PIPER_PYTHON, ["-m", "piper", "--model", modelPath, "--output_file", wavPath], { env, stdin: text });
      await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
      await rm(wavPath, { force: true });
    } catch (error) {
      // This used to be attributed to an "unresolved espeak-ng bug" on
      // words like "học"/"đọc" — it was actually the PYTHONUTF8/
      // PYTHONIOENCODING mismatch above, now fixed at the source. This
      // fallback stays as a safety net for any other unexpected failure so
      // one bad scene doesn't kill the whole render, not as the primary fix.
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
