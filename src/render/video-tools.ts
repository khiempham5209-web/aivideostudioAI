import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getDurationSec } from "../assets/audio-tools.js";
import { FFMPEG_BIN } from "../utils/binaries.js";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code}): ${err.slice(-800)}`)),
    );
    proc.on("error", reject);
  });
}

/** Common encode flags so every fitted clip is concat-compatible (same codec). */
const ENCODE = (fps: number) => [
  "-an",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-r", String(fps),
];

/**
 * Re-encode `inPath` to exactly `targetSec` seconds (video only):
 * - longer target → freeze the last frame (tpad clone) to fill the remainder,
 *   so a 5s poster animation holds while the scene's narration continues;
 * - shorter target → trim. Output is normalized for concat.
 */
export async function fitClipToDuration(
  inPath: string,
  targetSec: number,
  outPath: string,
  fps = 30,
): Promise<void> {
  const inDur = await getDurationSec(inPath);
  const target = Math.max(0.1, targetSec);
  const args = ["-y", "-i", inPath];
  if (target > inDur + 0.02) {
    const ext = target - inDur;
    args.push("-vf", `tpad=stop_mode=clone:stop_duration=${ext.toFixed(3)}`);
  }
  args.push("-t", target.toFixed(3), ...ENCODE(fps), outPath);
  await run(FFMPEG_BIN, args);
}

function aspectFilter(aspect: "16:9" | "9:16" | "1:1"): string {
  if (aspect === "16:9") {
    return "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";
  }
  if (aspect === "1:1") {
    return "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080";
  }
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
}

/**
 * Cut a real footage clip for one narration scene and normalize it for concat.
 * The source audio is removed; narration is muxed later.
 */
export async function cutFootageToDuration(
  inPath: string,
  startSec: number,
  targetSec: number,
  outPath: string,
  aspect: "16:9" | "9:16" | "1:1" = "9:16",
  fps = 30,
): Promise<void> {
  const target = Math.max(0.1, targetSec);
  await run(FFMPEG_BIN, [
    "-y",
    "-ss", Math.max(0, startSec).toFixed(3),
    "-i", inPath,
    "-t", target.toFixed(3),
    "-vf", aspectFilter(aspect),
    ...ENCODE(fps),
    outPath,
  ]);
}

export const ASPECT_RESOLUTION: Record<"16:9" | "9:16" | "1:1", [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
};

export interface KaraokeWord {
  text: string;
  /** Estimated speaking duration in seconds (proportional, not real ASR timing). */
  durationSec: number;
}

export interface KaraokeLine {
  start: number;
  end: number;
  words: KaraokeWord[];
}

function formatAssTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(cs / 360000);
  const minutes = Math.floor((cs % 360000) / 6000);
  const secs = Math.floor((cs % 6000) / 100);
  const centis = cs % 100;
  const pad = (v: number, w = 2) => String(v).padStart(w, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis)}`;
}

/** ASS Dialogue text is a single line — strip anything that would break the
 *  format (literal braces open override blocks, backslashes start tags). */
function escapeAssText(text: string): string {
  return text.replace(/[{}\\]/g, "");
}

/**
 * Builds a karaoke-style .ass subtitle: one Dialogue line per caption chunk,
 * each word wrapped in a `\k` hard-karaoke tag so libass sweeps it from the
 * "not yet spoken" to the "spoken" color at its estimated time — burned via
 * ffmpeg's `ass` filter (not `subtitles`+force_style, which only applies
 * uniform styling and can't carry per-word timing tags).
 */
export function buildKaraokeAss(lines: KaraokeLine[], aspect: "16:9" | "9:16" | "1:1"): string {
  const [w, h] = ASPECT_RESOLUTION[aspect];
  const fontSize = Math.round(h * 0.026);
  const marginV = Math.round(h * 0.05);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // PrimaryColour = already-spoken (stays highlighted after \k sweeps past it), yellow.
    // SecondaryColour = not-yet-spoken (default resting color), white.
    `Style: Caption,Arial,${fontSize},&H0000FFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,2,80,80,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = lines.map((line) => {
    const text = line.words
      .map((word) => `{\\k${Math.max(1, Math.round(word.durationSec * 100))}}${escapeAssText(word.text)}`)
      .join(" ");
    return `Dialogue: 0,${formatAssTime(line.start)},${formatAssTime(line.end)},Caption,,0,0,0,,${text}`;
  }).join("\n");

  return `${header}\n${events}\n`;
}

/**
 * Turn a static image into a narration-length clip with a slow Ken Burns
 * zoom (the same treatment scene visuals get when no real footage/AI-drawn
 * template is assigned — see the image branch in template-pipeline.ts).
 */
export async function imageToKenBurnsClip(
  inPath: string,
  targetSec: number,
  outPath: string,
  aspect: "16:9" | "9:16" | "1:1" = "9:16",
  fps = 30,
): Promise<void> {
  const target = Math.max(0.1, targetSec);
  const [w, h] = ASPECT_RESOLUTION[aspect];
  const frames = Math.max(1, Math.round(target * fps));
  // Gentle zoom-in (up to ~1.12x by the end) — subtle enough not to feel
  // like a slideshow gimmick over several seconds of narration.
  const zoompan = `zoompan=z='min(zoom+0.0008,1.12)':d=${frames}:s=${w}x${h}:fps=${fps}`;
  await run(FFMPEG_BIN, [
    "-y",
    "-loop", "1",
    "-i", inPath,
    "-t", target.toFixed(3),
    "-vf", `${aspectFilter(aspect)},${zoompan}`,
    ...ENCODE(fps),
    outPath,
  ]);
}

/** Concatenate uniformly-encoded clips into one silent video (stream copy). */
export async function concatVideos(clipPaths: string[], outPath: string): Promise<void> {
  if (clipPaths.length === 0) throw new Error("concatVideos: empty clipPaths");
  const tmp = await mkdtemp(join(tmpdir(), "vconcat-"));
  try {
    const listFile = join(tmp, "list.txt");
    // Absolute paths: the concat demuxer resolves `file '...'` relative to the
    // list file's directory (the temp dir), not the process cwd.
    const body = clipPaths
      .map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listFile, body, "utf8");
    await run(FFMPEG_BIN, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Mux an audio track onto a silent video. The video length wins (no -shortest),
 * so an outro visual hold past the end of narration is preserved as silent tail.
 */
export async function muxAudioOntoVideo(
  videoPath: string,
  audioPath: string,
  outPath: string,
  subtitlePath?: string,
  aspect: "16:9" | "9:16" | "1:1" = "9:16",
): Promise<void> {
  const args = [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:a", "aac",
    "-b:a", "192k",
  ];

  if (subtitlePath && subtitlePath.toLowerCase().endsWith(".ass")) {
    // A real .ass file (see buildKaraokeAss) already carries its own
    // PlayResX/PlayResY and per-word \k karaoke timing — burn it as-is via
    // the `ass` filter rather than `subtitles`+force_style, which only
    // applies one uniform style and can't carry per-word override tags (it
    // converts SRT text through libass's own auto-styling, discarding any
    // control codes typed into the plain text).
    const escapedSubtitle = resolve(subtitlePath).replace(/\\/g, "/").replace(/:/g, "\\:");
    args.push("-vf", `ass='${escapedSubtitle}'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
  } else if (subtitlePath) {
    // Plain .srt carries no resolution info, so libass's SRT->ASS conversion
    // falls back to an internal default reference size unless told the real
    // frame size via `original_size` — without it, FontSize is computed
    // against that (much smaller) default and comes out several times too
    // large on our actual 1080x1920/1920x1080 output, burying the frame.
    const [w, h] = ASPECT_RESOLUTION[aspect];
    const fontSize = Math.round(h * 0.032);
    const escapedSubtitle = resolve(subtitlePath).replace(/\\/g, "/").replace(/:/g, "\\:");
    args.push(
      "-vf",
      `subtitles='${escapedSubtitle}':original_size=${w}x${h}:force_style='FontName=Arial,FontSize=${fontSize},PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60'`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
    );
  } else {
    args.push("-c:v", "copy");
  }

  args.push(outPath);
  await run(FFMPEG_BIN, args);
}
