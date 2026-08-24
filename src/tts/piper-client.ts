import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_BIN, PIPER_BIN, PIPER_VOICES_DIR, localPiperEspeakDataDir } from "../utils/binaries.js";
import { getDurationSec } from "../assets/audio-tools.js";
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

// HISTORICAL — kept only because the fix below took several rounds to find,
// and the earlier dead ends are worth not repeating:
//
// Piper clipped/attenuated (and, separately, measurably RUSHED — see next
// paragraph) the very first syllable of whatever text a given invocation
// synthesized. The original fix was to prepend a throwaway "À." filler
// before the real text and cut it off after synthesis (trimLeadingFiller/
// detectSpeechStartAfterFiller below), sacrificing the filler to the
// clipping artifact instead of a real word. That was invoked via
// `python -m piper` with the text piped over stdin.
//
// The real root cause turned out to be that invocation method, not
// anything inherent to the Piper model: synthesizing "Sau khi rời công
// ty," as the first thing spoken via `python -m piper` + stdin measured
// 887ms; the IDENTICAL phrase via the `piper` console-script binary with
// `-i <textfile>` (no filler at all) measured 1061ms — matching a 1060ms
// benchmark of the same words synthesized NOT-first (mid-utterance, after
// a real sentence). The stdin module path was rushing/compressing
// whatever it spoke first by ~16%; the file-based console-script path
// doesn't do that at all. Switching to the console script (PIPER_BIN)
// eliminated the need for the warmup filler, the per-sentence chunking
// that existed to limit each chunk's exposure to this bug, and the
// concatWavs() stitching between chunks — the console script's own
// `--sentence-silence` flag also handles multi-sentence pacing natively
// in a single call, more naturally than manually gluing separately
// synthesized sentences together with zero gap ever did.
const execFileAsync = promisify(execFile);
const SENTENCE_SILENCE_SEC = 0.3;

/** Finds where real speech starts in a Piper-rendered wav — there's
 *  typically a short natural lead-in silence before the console script's
 *  output settles into real speech; this trims it so concatWithSilence's
 *  fixed inter-scene gap is the only source of silence between scenes
 *  instead of that gap stacking on top of a variable natural lead-in.
 *  Cuts just after the first silence gap of at least MIN_GAP_SEC. Falls
 *  back to 0 (no trim) if no such gap is found, so a detection hiccup
 *  never eats real audio.
 *
 *  Bug that shipped once and produced ~227-byte (silent) mp3s for entire
 *  scenes: text with no leading pause at all (speech starts right at t=0,
 *  e.g. no comma near the start) has NO qualifying gap near the beginning —
 *  the only gap silencedetect finds anywhere in the file is the TRAILING
 *  silence at the very end. The old version took whatever gap regex found
 *  FIRST in the stderr text unconditionally, so it grabbed that trailing
 *  gap, treated its end as "where real speech starts", and cut from
 *  (near end-of-file) to end-of-file — discarding essentially the entire
 *  scene. MAX_LEADING_START_SEC below rejects any candidate gap that
 *  doesn't actually start near the beginning of the file, exactly the
 *  distinction that was missing. */
async function detectLeadingSilence(wavPath: string): Promise<number> {
  const MIN_GAP_SEC = 0.12;
  const END_SAFETY_PAD_SEC = 0.02;
  const MAX_LEADING_START_SEC = 0.5;
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, [
      "-i", wavPath,
      "-af", `silencedetect=noise=-30dB:d=${MIN_GAP_SEC}`,
      "-f", "null", "-",
    ], { windowsHide: true });
    const match = stderr.match(/silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/);
    if (!match) return 0;
    const start = parseFloat(match[1]);
    if (start > MAX_LEADING_START_SEC) return 0;
    const end = parseFloat(match[2]);
    return end + END_SAFETY_PAD_SEC;
  } catch {
    return 0;
  }
}

/** Finds where real speech ENDS in an already-lead-trimmed wav — Piper
 *  leaves a variable amount of trailing silence after the last word
 *  (depends on the sentence's ending punctuation/prosody), which used to be
 *  kept in full and then stacked on top of the fixed SCENE_GAP_SEC pause in
 *  concatWithSilence(). That made the gap before the NEXT scene swing
 *  anywhere from ~50ms to 700ms+ instead of a steady ~300ms — audible as an
 *  unpredictably long pause right before the next scene starts, which reads
 *  as the next scene's opening word being late/dropped even though nothing
 *  was actually deleted. Trimming the tail here too means concatWithSilence
 *  is the ONLY source of inter-scene silence, so every gap is the same
 *  length.
 *
 *  Cuts at the LAST detected silence run's start (plus a small safety pad),
 *  but ONLY when whatever follows that run to end-of-file is short enough
 *  (<150ms) to plausibly be encoder/vocal-decay noise rather than another
 *  real word — real Vietnamese syllables take longer than that to say.
 *  Measured empirically on real renders: that trailing residual after the
 *  final pause is consistently ~50-70ms. If it's longer, there may be real
 *  speech after the last detected pause (e.g. the pause was mid-sentence,
 *  not the final one) — return null (no trim) rather than risk cutting the
 *  scene's actual last word.
 *
 *  A `silenceremove`-filter-based rewrite was tried here (letting ffmpeg
 *  find+trim the trailing run in one pass instead of hand-parsing
 *  `silencedetect` stderr) but was caught by a direct before/after duration
 *  check on a real multi-clause scene before it ever reached the running
 *  app: ffmpeg's `stop_periods=1` matches the FIRST qualifying silence run
 *  after speech starts, not the last one — on a 9.5s three-clause sentence
 *  it matched the comma pause after clause 1 and discarded the remaining
 *  7.4s (two whole clauses) as if it were trailing silence. Do not swap
 *  this implementation for that filter without re-verifying that behavior
 *  on ffmpeg's actual installed version. */
async function detectSpeechEnd(wavPath: string): Promise<number | null> {
  const MIN_TAIL_SILENCE_SEC = 0.15;
  const TAIL_SAFETY_PAD_SEC = 0.08;
  const MAX_TRAILING_ARTIFACT_SEC = 0.15;
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, [
      "-i", wavPath,
      "-af", `silencedetect=noise=-30dB:d=${MIN_TAIL_SILENCE_SEC}`,
      "-f", "null", "-",
    ], { windowsHide: true });
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!durationMatch) return null;
    const totalDuration = parseInt(durationMatch[1], 10) * 3600 + parseInt(durationMatch[2], 10) * 60 + parseFloat(durationMatch[3]);
    const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
    if (!starts.length) return null;
    const lastStart = starts[starts.length - 1];
    // If the last run is "closed" (has a matching end), whatever comes after
    // it to EOF is the residual to check; if it's unclosed (silence runs to
    // EOF), the residual is 0.
    const residualAfterSilence = ends.length >= starts.length ? totalDuration - ends[ends.length - 1] : 0;
    if (residualAfterSilence > MAX_TRAILING_ARTIFACT_SEC) return null;
    return lastStart + TAIL_SAFETY_PAD_SEC;
  } catch {
    return null;
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

    const textPath = `${audioOutPath}.txt`;
    const normalizedText = text.normalize("NFC").trim();
    if (!normalizedText) throw new Error("No text provided for Piper TTS");
    await writeFile(textPath, normalizedText, "utf-8");
    const wavPath = `${audioOutPath}.piper.wav`;
    const espeakDataDir = ensureEspeakDataDir();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (espeakDataDir) env.ESPEAK_DATA_PATH = espeakDataDir;
    env.PYTHONUTF8 = "1";
    env.PYTHONIOENCODING = "utf-8";

    const synthesizeOnce = async () => {
      const rawWavPath = `${wavPath}.raw.wav`;
      await run(PIPER_BIN, [
        "-m", modelPath,
        "-i", textPath,
        "-f", rawWavPath,
        "--sentence-silence", String(SENTENCE_SILENCE_SEC),
      ], { env });
      const rawDurationSec = await getDurationSec(rawWavPath);

      const cutSec = await detectLeadingSilence(rawWavPath);
      if (cutSec > 0) {
        await run(FFMPEG_BIN, ["-y", "-i", rawWavPath, "-ss", cutSec.toFixed(3), "-c", "copy", wavPath]);
      } else {
        await run(FFMPEG_BIN, ["-y", "-i", rawWavPath, "-c", "copy", wavPath]);
      }

      const tailEndSec = await detectSpeechEnd(wavPath);
      if (tailEndSec !== null) {
        const tailTrimmedPath = `${wavPath}.tailtrim.wav`;
        await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-to", tailEndSec.toFixed(3), "-c", "copy", tailTrimmedPath]);
        await rename(tailTrimmedPath, wavPath);
      }

      // Safety net: the leading/trailing trim heuristics above are each
      // independently designed to fall back to "no trim" when uncertain,
      // but a bug in either (one already shipped once — see
      // detectLeadingSilence's comment — and produced ~227-byte silent
      // mp3s for entire scenes) can still make it through undetected for
      // some input. Checking the combined result's duration against the
      // untrimmed original here catches ANY such bug, known or not, rather
      // than relying on each individual heuristic being bug-free: losing
      // more than 70% of the raw audio is never a legitimate trim (leading
      // + trailing silence realistically cost a few hundred ms, not the
      // bulk of the clip), so fall back to the untrimmed raw audio instead
      // of shipping a near-empty scene.
      const trimmedDurationSec = await getDurationSec(wavPath);
      if (trimmedDurationSec < rawDurationSec * 0.3) {
        console.warn(`Piper trim discarded ${(rawDurationSec - trimmedDurationSec).toFixed(2)}s of a ${rawDurationSec.toFixed(2)}s clip (>70%) — using untrimmed audio instead for "${normalizedText.slice(0, 60)}"`);
        await run(FFMPEG_BIN, ["-y", "-i", rawWavPath, "-c", "copy", wavPath]);
      }
      await rm(rawWavPath, { force: true });

      await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
      await rm(wavPath, { force: true });
    };

    try {
      // Piper/espeak-ng has a known intermittent failure on Windows with
      // Vietnamese text (previously misdiagnosed as encoding-specific — it
      // can still happen transiently even with the encoding fix above) —
      // measured directly on a real 1076-scene render: it hit disproportionately
      // on very short lines ("Biết.", "Có.", "1.", single-word dialogue beats),
      // producing an empty/unreadable wav (ffprobe: non-numeric duration).
      // Falling back to Edge after only 2 attempts meant ~7% of scenes
      // silently swapped to a completely different voice mid-video, which
      // is far more noticeable than a slightly slower render — retrying
      // more before giving up on Piper trades a bit of time for a lot less
      // voice-switching, since the same short line often succeeds on a
      // later attempt (it's intermittent, not a deterministic failure on
      // that exact text).
      const MAX_ATTEMPTS = 5;
      let lastError: unknown;
      let succeeded = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await synthesizeOnce();
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          await rm(wavPath, { force: true }).catch(() => {});
          if (attempt < MAX_ATTEMPTS) {
            console.warn(`Piper TTS failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
          }
        }
      }
      if (!succeeded) throw lastError;
    } catch (error) {
      // This used to be attributed to an "unresolved espeak-ng bug" on
      // words like "học"/"đọc" — it was actually the PYTHONUTF8/
      // PYTHONIOENCODING mismatch above, now fixed at the source. This
      // fallback stays as a safety net for any other unexpected failure so
      // one bad scene doesn't kill the whole render, not as the primary fix.
      const fallbackVoice = edgeFallbackVoiceFor(this.voiceId);
      console.warn(`Piper TTS failed twice for this text, falling back to Edge TTS (${fallbackVoice}): ${error instanceof Error ? error.message : error}`);
      await rm(wavPath, { force: true }).catch(() => {});
      await rm(textPath, { force: true }).catch(() => {});
      const fallback = new EdgeTtsClient({ voice: fallbackVoice });
      await fallback.generate(text, audioOutPath, srtOutPath);
      return;
    }

    await rm(textPath, { force: true }).catch(() => {});
    if (srtOutPath) {
      await writeFile(srtOutPath, "", "utf-8");
    }
  }
}
