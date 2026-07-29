import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_BIN, PIPER_PYTHON, PIPER_VOICES_DIR, localPiperEspeakDataDir } from "../utils/binaries.js";
import { EdgeTtsClient } from "./edge-client.js";
import { VOICE_OPTIONS } from "./voice-catalog.js";

/** Edge TTS fallback voice, matched by gender so a mid-render Piper failure
 *  doesn't swap in a voice of the wrong gender for the rest of the file —
 *  that mismatch was previously showing up as "the video randomly has 2
 *  different voices". */
function edgeFallbackVoiceFor(piperVoiceId: string): string {
  const gender = VOICE_OPTIONS.find((v) => v.provider === "piper" && v.name === piperVoiceId)?.gender;
  return gender === "male" ? "vi-VN-NamMinhNeural" : "vi-VN-HoaiMyNeural";
}

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

// Piper clips/attenuates the very first syllable of whatever text a given
// invocation synthesizes — confirmed by ear and by waveform: the same
// sentence's first word renders at full volume when it's NOT the first
// thing spoken (e.g., appearing a second time later in the same input),
// but is short/quiet when it IS the first thing spoken. Prepending this
// throwaway filler (never shown to the user, never in subtitles) sacrifices
// itself to the clipping artifact instead of a real word — the trailing
// silence after it is then detected and trimmed off in trimLeadingFiller().
const PIPER_WARMUP_PREFIX = "À. ";
const execFileAsync = promisify(execFile);

/** Finds where real speech starts in a Piper-rendered wav that begins with
 *  PIPER_WARMUP_PREFIX — the end of the first silence gap of least
 *  MIN_GAP_SEC (the pause after the filler word). Falls back to 0 (no trim)
 *  if no such gap is found, so a detection hiccup never eats real audio.
 *  Backs off SAFETY_MARGIN_SEC from the detected point on purpose: the
 *  silencedetect threshold can trigger right as the next word's quiet
 *  onset consonant/vowel begins, and cutting exactly there was observed to
 *  shave the leading edge off the real first word — landing a bit earlier,
 *  still inside the silent gap, costs nothing but a few extra ms of quiet. */
async function detectSpeechStartAfterFiller(wavPath: string): Promise<number> {
  const MIN_GAP_SEC = 0.12;
  const SAFETY_MARGIN_SEC = 0.1;
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, [
      "-i", wavPath,
      "-af", `silencedetect=noise=-30dB:d=${MIN_GAP_SEC}`,
      "-f", "null", "-",
    ], { windowsHide: true });
    const match = stderr.match(/silence_end:\s*([\d.]+)/);
    if (!match) return 0;
    return Math.max(0, parseFloat(match[1]) - SAFETY_MARGIN_SEC);
  } catch {
    return 0;
  }
}

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

function splitForPiper(text: string): string[] {
  const normalized = text
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [normalized];
  const chunks: string[] = [];
  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length <= 180) {
      chunks.push(sentence);
      continue;
    }

    let current = "";
    for (const part of sentence.split(/([,;:，；：])/)) {
      const next = `${current}${part}`.trim();
      if (current && next.length > 180) {
        chunks.push(current.trim());
        current = part.trim();
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current.trim());
  }
  return chunks;
}

async function concatWavs(inputPaths: string[], outPath: string): Promise<void> {
  if (inputPaths.length === 1) return;
  const listPath = `${outPath}.list.txt`;
  const escapeForConcatList = (p: string) => p.replace(/'/g, "'\\''");
  await writeFile(listPath, inputPaths.map((p) => `file '${escapeForConcatList(p)}'`).join("\n"), "utf-8");
  try {
    await run(FFMPEG_BIN, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  } finally {
    await rm(listPath, { force: true });
  }
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

    await writeFile(`${audioOutPath}.txt`, text.normalize("NFC"), "utf-8");
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

    // Each chunk is its own fresh Piper invocation, so each one independently
    // needs the warm-up-prefix + trim treatment (see PIPER_WARMUP_PREFIX) —
    // not just the first chunk of the whole scene.
    const synthesizeTrimmedChunk = async (chunkText: string, outWavPath: string) => {
      const rawWavPath = `${outWavPath}.raw.wav`;
      await run(PIPER_PYTHON, ["-m", "piper", "--model", modelPath, "--output_file", rawWavPath], {
        env,
        stdin: `${PIPER_WARMUP_PREFIX}${chunkText}`,
      });
      const cutSec = await detectSpeechStartAfterFiller(rawWavPath);
      await run(FFMPEG_BIN, ["-y", "-i", rawWavPath, "-ss", cutSec.toFixed(3), "-c", "copy", outWavPath]);
      await rm(rawWavPath, { force: true });
    };

    const synthesizeOnce = async () => {
      const chunks = splitForPiper(text);
      if (!chunks.length) throw new Error("No text provided for Piper TTS");

      const wavParts = chunks.map((_, index) => `${audioOutPath}.piper.part-${index}.wav`);
      for (let index = 0; index < chunks.length; index++) {
        await synthesizeTrimmedChunk(chunks[index], wavParts[index]);
      }
      if (wavParts.length === 1) {
        await rename(wavParts[0], wavPath);
      } else {
        await concatWavs(wavParts, wavPath);
        await Promise.all(wavParts.map((part) => rm(part, { force: true })));
      }
      await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
      await rm(wavPath, { force: true });
    };

    try {
      // Piper/espeak-ng has a known intermittent failure on Windows with
      // Vietnamese text (previously misdiagnosed as encoding-specific — it
      // can still happen transiently even with the encoding fix above).
      // A bare retry recovers most of these without ever touching the
      // fallback voice, since the same text often succeeds the second time.
      try {
        await synthesizeOnce();
      } catch (firstError) {
        await rm(wavPath, { force: true }).catch(() => {});
        console.warn(`Piper TTS failed once, retrying before falling back: ${firstError instanceof Error ? firstError.message.split("\n")[0] : firstError}`);
        await synthesizeOnce();
      }
    } catch (error) {
      // This used to be attributed to an "unresolved espeak-ng bug" on
      // words like "học"/"đọc" — it was actually the PYTHONUTF8/
      // PYTHONIOENCODING mismatch above, now fixed at the source. This
      // fallback stays as a safety net for any other unexpected failure so
      // one bad scene doesn't kill the whole render, not as the primary fix.
      const fallbackVoice = edgeFallbackVoiceFor(this.voiceId);
      console.warn(`Piper TTS failed twice for this text, falling back to Edge TTS (${fallbackVoice}): ${error instanceof Error ? error.message : error}`);
      await rm(wavPath, { force: true }).catch(() => {});
      const fallback = new EdgeTtsClient({ voice: fallbackVoice });
      await fallback.generate(text, audioOutPath, srtOutPath);
      return;
    }

    if (srtOutPath) {
      await writeFile(srtOutPath, "", "utf-8");
    }
  }
}
