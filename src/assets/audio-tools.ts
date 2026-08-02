import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG_BIN, FFPROBE_BIN } from "../utils/binaries.js";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (exit ${code}): ${err}`));
    });
    proc.on("error", reject);
  });
}

export async function getDurationSec(path: string): Promise<number> {
  // For MP3 files, ffprobe's format=duration estimates duration from bitrate×filesize
  // and is often wrong for TTS-generated files (e.g. OmniVoice 24kHz MPEG-2 L3 can
  // be off by 30%+). Count actual encoded packets instead: each MP3 frame contains
  // 1152 samples (MPEG-1, sr≥32kHz) or 576 samples (MPEG-2/2.5, sr<32kHz).
  if (path.toLowerCase().endsWith(".mp3")) {
    try {
      const raw = await run(FFPROBE_BIN, [
        "-v", "error",
        "-count_packets",
        "-select_streams", "a:0",
        "-show_entries", "stream=nb_read_packets,sample_rate",
        "-of", "json",
        path,
      ]);
      const data = JSON.parse(raw);
      const stream = data?.streams?.[0];
      const packets = parseInt(stream?.nb_read_packets ?? "", 10);
      const sampleRate = parseInt(stream?.sample_rate ?? "", 10);
      if (packets > 0 && sampleRate > 0) {
        // MPEG-1 L3 (32/44.1/48 kHz): 1152 samples/frame
        // MPEG-2/2.5 L3 (≤24 kHz): 576 samples/frame
        const samplesPerFrame = sampleRate >= 32000 ? 1152 : 576;
        return (packets * samplesPerFrame) / sampleRate;
      }
    } catch {
      // fall through to format duration below
    }
  }

  const out = await run(FFPROBE_BIN, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const d = parseFloat(out.trim());
  if (isNaN(d)) throw new Error(`ffprobe returned non-numeric duration for ${path}: ${out}`);
  return d;
}

/**
 * Concatenate audio files with `gapSec` silence between each, producing a single
 * output mp3.
 *
 * Each input is pre-processed into its own normalized+faded temp WAV (a
 * separate, short ffmpeg call per file — no argv length concerns), then
 * joined via the concat DEMUXER reading a file-list text file. An earlier
 * version built one giant filter_complex command with an -i per input;
 * that scales with scene count and blew past Windows' command-line length
 * limit (spawn ENAMETOOLONG) on long videos with 70+ scenes. The per-file
 * normalize step still applies a tiny 8 ms fade-in/fade-out to smooth any
 * DC offset discontinuity at the boundary (avoids the "pét" clicking sound).
 */
export async function concatWithSilence(
  inputPaths: string[],
  gapSec: number,
  outPath: string,
): Promise<void> {
  if (inputPaths.length === 0) throw new Error("concatWithSilence: empty inputPaths");

  const tmp = await mkdtemp(join(tmpdir(), "concat-"));
  try {
    // Generate WAV silence (lossless, no encoder priming pops)
    const silencePath = join(tmp, "silence.wav");
    await run(FFMPEG_BIN, [
      "-y", "-f", "lavfi",
      "-i", `anullsrc=r=44100:cl=mono`,
      "-t", String(gapSec),
      "-ac", "1", "-ar", "44100",
      silencePath,
    ]);

    // 8ms used to be applied here, but each scene's audio already starts
    // essentially AT real speech (Piper's own warmup-filler trim in
    // piper-client.ts cuts right to the onset) — a fade-in from silence
    // landing exactly on a fast Vietnamese plosive/stop consonant (đ/t/k...)
    // shaves off the attack transient that makes the consonant recognizable,
    // which is what was being reported as "missing/muffled first word" even
    // though no audio was literally deleted. 2.5ms is long enough to still
    // smooth the sample-value discontinuity (avoids the "pét" click) without
    // eating a meaningful slice of a fast consonant's onset.
    const FADE_SEC = 0.0025;
    const normalize = (inputPath: string, segPath: string) =>
      run(FFMPEG_BIN, [
        "-y", "-i", inputPath,
        "-af",
        `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,` +
          `afade=t=in:st=0:d=${FADE_SEC},` +
          // Trim fade-out: reverse → fade-in → reverse (this fades the END)
          `areverse,afade=t=in:st=0:d=${FADE_SEC},areverse`,
        "-ar", "44100", "-ac", "1",
        segPath,
      ]);

    // Silence is identical every time, so normalize it once and reuse the
    // same segment file for every gap instead of re-running ffmpeg per gap.
    const silenceSegPath = join(tmp, "silence-seg.wav");
    await normalize(silencePath, silenceSegPath);

    const escapeForConcatList = (p: string) => p.replace(/'/g, "'\\''");
    // A leading silence segment before scene 0 too (not just between scenes)
    // — the final mp3 encode below always carries a small (~20-25ms) LAME
    // encoder-delay header no matter what, and not every player that opens
    // the exported MP3 directly (outside this app) honors that gapless
    // metadata correctly. A real silent pad at the very start means even a
    // player that mishandles it still lands well before the first real word,
    // instead of clipping into it — this was showing up as "missing the
    // first word/letter", most noticeably on scene 0 (no adjacent gap into
    // the previous scene's tail to absorb the same slack from).
    const listLines: string[] = [`file '${escapeForConcatList(silenceSegPath)}'`];
    for (let i = 0; i < inputPaths.length; i++) {
      const segPath = join(tmp, `seg-${i}.wav`);
      await normalize(inputPaths[i], segPath);
      listLines.push(`file '${escapeForConcatList(segPath)}'`);
      if (i < inputPaths.length - 1) {
        listLines.push(`file '${escapeForConcatList(silenceSegPath)}'`);
      }
    }
    const listPath = join(tmp, "list.txt");
    await writeFile(listPath, listLines.join("\n"), "utf-8");

    await run(FFMPEG_BIN, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100",
      outPath,
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface SfxMixSpec {
  /** Absolute path to SFX mp3/wav file */
  path: string;
  /** Time in seconds (within voice.mp3) when SFX starts */
  startSec: number;
  /** Volume 0–1 */
  volume: number;
}

/**
 * Mix SFX layer onto an existing voice mp3.
 *
 * - Voice stays at full volume
 * - Each SFX is delayed to its `startSec` and scaled by its `volume`
 * - All SFX layers are summed, then mixed with voice (amix duration=first)
 * - Output is mp3 at 192kbps
 *
 * If `sfxList` is empty, just copies voicePath → outPath.
 */
export async function mixSfxOntoVoice(
  voicePath: string,
  sfxList: SfxMixSpec[],
  outPath: string,
): Promise<void> {
  if (sfxList.length === 0) {
    // No SFX — just normalize/copy voice
    await run(FFMPEG_BIN, [
      "-y", "-i", voicePath,
      "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100",
      outPath,
    ]);
    return;
  }

  const ffArgs: string[] = ["-y", "-i", voicePath];
  const filterParts: string[] = [];
  const sfxLabels: string[] = [];

  sfxList.forEach((s, i) => {
    ffArgs.push("-i", s.path);
    const inputIdx = i + 1; // voice is index 0
    const outLabel = `s${i}`;
    const delayMs = Math.max(0, Math.round(s.startSec * 1000));
    // Per-SFX chain: resample to 44100 mono → adelay to start time → volume
    filterParts.push(
      `[${inputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,` +
      `adelay=${delayMs}|${delayMs},volume=${s.volume}[${outLabel}]`
    );
    sfxLabels.push(`[${outLabel}]`);
  });

  // Mix all SFX layers together
  let mixedSfxLabel: string;
  if (sfxLabels.length === 1) {
    mixedSfxLabel = sfxLabels[0];
  } else {
    filterParts.push(
      `${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:dropout_transition=0:normalize=0[sfxall]`
    );
    mixedSfxLabel = "[sfxall]";
  }

  // Voice path: resample, then mix with SFX layer (voice volume 1.0, SFX already scaled)
  filterParts.push(
    `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[voice]`
  );
  filterParts.push(
    `[voice]${mixedSfxLabel}amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]`
  );

  ffArgs.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[out]",
    "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100",
    outPath,
  );

  await run(FFMPEG_BIN, ffArgs);
}

export async function mixBackgroundMusicUnderVoice(
  voicePath: string,
  backgroundPath: string,
  outPath: string,
  volume = 0.16,
): Promise<void> {
  const voiceDuration = await getDurationSec(voicePath);
  await run(FFMPEG_BIN, [
    "-y",
    "-i", voicePath,
    "-stream_loop", "-1",
    "-i", backgroundPath,
    "-t", voiceDuration.toFixed(3),
    "-filter_complex",
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,volume=${volume}[bg];` +
      `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[voice];` +
      "[voice][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]",
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    outPath,
  ]);
}
