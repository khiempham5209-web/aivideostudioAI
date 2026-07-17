import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getDurationSec } from "../assets/audio-tools.js";
import { FFMPEG_BIN } from "../utils/binaries.js";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
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

  if (subtitlePath) {
    const escapedSubtitle = resolve(subtitlePath).replace(/\\/g, "/").replace(/:/g, "\\:");
    args.push(
      "-vf",
      `subtitles='${escapedSubtitle}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60'`,
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
