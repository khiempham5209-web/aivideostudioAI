import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FFMPEG_BIN } from "../utils/binaries.js";
import { muxAudioOntoVideo } from "./video-tools.js";
import { listTracks, listClips, getAsset, type TimelineClipRecord, type TimelineTrackRecord, type AssetRecord } from "../storage/db.js";

const RENDER_FPS = 30;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code}): ${err.slice(-1500)}`)),
    );
    proc.on("error", reject);
  });
}

function canvasSize(aspect: "16:9" | "9:16" | "1:1"): [number, number] {
  if (aspect === "16:9") return [1920, 1080];
  if (aspect === "1:1") return [1080, 1080];
  return [1080, 1920];
}

function formatSrtTime(seconds: number): string {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${pad(millis, 3)}`;
}

function clampSpeed(speed: number): number {
  if (!speed || Number.isNaN(speed)) return 1;
  return Math.min(2, Math.max(0.5, speed));
}

function escapeDrawtext(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

export interface ResolveAssetPath {
  (asset: AssetRecord): Promise<string>;
}

export interface TimelineRenderResult {
  outputDir: string;
  videoPath: string;
  audioPath: string;
  subtitlePath: string | null;
  durationSec: number;
}

/**
 * Renders a project's real multi-track timeline (timeline_tracks/timeline_clips)
 * to a single MP4. Video/Overlay tracks are composited via a chained
 * `overlay` filter graph (each clip time-shifted to its own start_time and
 * gated with `enable=between(t,start,end)`); Text is drawn on top with
 * `drawtext`; Subtitle clips are written to an .srt and burned in via the
 * same subtitle filter used by the scene-based pipeline; Voice/Music/SFX
 * clips are delayed to their start_time and mixed with `amix`.
 *
 * Rotation is stored on the clip but not yet applied at render time (v1).
 */
export async function renderProjectTimeline(
  projectId: string,
  outputDir: string,
  aspect: "16:9" | "9:16" | "1:1" = "9:16",
  resolveAssetPath: ResolveAssetPath = async (asset) => asset.file_path,
  onProgress?: (step: string, progress: number) => void,
): Promise<TimelineRenderResult> {
  await mkdir(outputDir, { recursive: true });
  const report = (step: string, progress: number) => onProgress?.(step, progress);

  const tracks = listTracks(projectId);
  const clips = listClips(projectId);
  const trackById = new Map<string, TimelineTrackRecord>(tracks.map((t) => [t.id, t]));
  const activeClips = clips.filter((c) => {
    const track = trackById.get(c.track_id);
    return track && !track.muted;
  });

  const durationSec = Math.max(0.5, activeClips.reduce((max, c) => Math.max(max, c.start_time + c.duration), 0.5));
  const [width, height] = canvasSize(aspect);

  const byType = (type: string) => activeClips.filter((c) => trackById.get(c.track_id)?.track_type === type);
  const visualClips = [...byType("video"), ...byType("overlay")]
    .filter((c) => c.source_asset_id)
    .sort((a, b) => a.start_time - b.start_time);
  const textClips = byType("text").sort((a, b) => a.start_time - b.start_time);
  const subtitleClips = byType("subtitle").sort((a, b) => a.start_time - b.start_time);
  const transitionClips = byType("transition");
  const audioClips = [...byType("voice"), ...byType("music"), ...byType("sfx")].filter((c) => c.source_asset_id);

  report("Ghép video/overlay/text", 10);
  const silentVideoPath = join(outputDir, "timeline-silent.mp4");
  await renderVisualComposite(visualClips, textClips, transitionClips, width, height, durationSec, silentVideoPath, resolveAssetPath);

  report("Trộn voice/nhạc/SFX", 55);
  const audioPath = join(outputDir, "voice.mp3");
  if (audioClips.length > 0) {
    await mixTimelineAudio(audioClips, durationSec, audioPath, resolveAssetPath);
  } else {
    await run(FFMPEG_BIN, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", durationSec.toFixed(3), "-c:a", "libmp3lame", "-b:a", "192k", audioPath]);
  }

  let subtitlePath: string | null = null;
  if (subtitleClips.length > 0) {
    report("Tạo subtitle", 75);
    const subDir = join(outputDir, "subtitles");
    await mkdir(subDir, { recursive: true });
    subtitlePath = join(subDir, "subtitle.srt");
    const body = subtitleClips
      .map((c, i) => [String(i + 1), `${formatSrtTime(c.start_time)} --> ${formatSrtTime(c.start_time + c.duration)}`, (c.text_content || c.label || "").replace(/\s+/g, " ").trim()].join("\n"))
      .join("\n\n");
    await writeFile(subtitlePath, `${body}\n`, "utf8");
  }

  report("Ghép video + audio + subtitle", 90);
  const videoPath = join(outputDir, "video.mp4");
  await muxAudioOntoVideo(silentVideoPath, audioPath, videoPath, subtitlePath ?? undefined);

  report("Hoàn tất", 100);
  return { outputDir, videoPath, audioPath, subtitlePath, durationSec };
}

const ANIM_FADE_SEC = 0.5;
const TRANSITION_FADE_SEC = 0.5;

/**
 * A transition clip only marks a moment in time (it has no source of its
 * own). We turn it into a real effect by fading out whichever visual clip
 * ends nearest that moment and fading in whichever visual clip starts
 * nearest it — a dissolve-style transition. All transition presets
 * currently produce the same fade; distinct wipe/zoom/spin geometry is not
 * implemented yet.
 */
function computeTransitionFades(
  visualClips: TimelineClipRecord[],
  transitionClips: TimelineClipRecord[],
): { fadeIn: Map<string, number>; fadeOut: Map<string, number> } {
  const fadeIn = new Map<string, number>();
  const fadeOut = new Map<string, number>();
  for (const t of transitionClips) {
    let bestOut: TimelineClipRecord | null = null;
    let bestOutDelta = Infinity;
    let bestIn: TimelineClipRecord | null = null;
    let bestInDelta = Infinity;
    for (const clip of visualClips) {
      const endDelta = Math.abs(clip.start_time + clip.duration - t.start_time);
      if (endDelta <= 1.0 && endDelta < bestOutDelta) {
        bestOut = clip;
        bestOutDelta = endDelta;
      }
      const startDelta = Math.abs(clip.start_time - t.start_time);
      if (startDelta <= 1.0 && startDelta < bestInDelta) {
        bestIn = clip;
        bestInDelta = startDelta;
      }
    }
    if (bestOut) fadeOut.set(bestOut.id, TRANSITION_FADE_SEC);
    if (bestIn) fadeIn.set(bestIn.id, TRANSITION_FADE_SEC);
  }
  return { fadeIn, fadeOut };
}

async function renderVisualComposite(
  visualClips: TimelineClipRecord[],
  textClips: TimelineClipRecord[],
  transitionClips: TimelineClipRecord[],
  width: number,
  height: number,
  durationSec: number,
  outPath: string,
  resolveAssetPath: ResolveAssetPath,
): Promise<void> {
  const ffArgs: string[] = ["-y", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=${durationSec.toFixed(3)}:r=${RENDER_FPS}`];
  const filterParts: string[] = [];
  let base = "[0:v]";
  let inputIdx = 1;
  const { fadeIn: transitionFadeIn, fadeOut: transitionFadeOut } = computeTransitionFades(visualClips, transitionClips);

  for (const clip of visualClips) {
    const asset = clip.source_asset_id ? getAsset(clip.source_asset_id) : undefined;
    if (!asset || (asset.type !== "video" && asset.type !== "image")) continue;
    const localPath = await resolveAssetPath(asset);
    const idx = inputIdx++;
    if (asset.type === "image") {
      ffArgs.push("-loop", "1", "-i", localPath);
    } else {
      ffArgs.push("-i", localPath);
    }
    const label = `v${idx}`;
    const speed = clampSpeed(Number(clip.speed) || 1);
    const trimIn = Math.max(0, Number(clip.trim_in) || 0);
    const scale = Math.max(0.05, Number(clip.scale) || 100) / 100;
    const opacity = Math.min(1, Math.max(0, Number(clip.opacity ?? 100) / 100));
    const scaledW = Math.max(2, Math.round(width * scale));
    const scaledH = Math.max(2, Math.round(height * scale));
    const startExpr = clip.start_time.toFixed(3);
    const endTimeNum = clip.start_time + clip.duration;
    const halfDur = clip.duration / 2;
    const fadeInDur = Math.min(halfDur, Math.max(clip.animation === "fade-in" ? ANIM_FADE_SEC : 0, transitionFadeIn.get(clip.id) || 0));
    const fadeOutDur = Math.min(halfDur, transitionFadeOut.get(clip.id) || 0);
    const slideDur = clip.animation === "slide-up" ? Math.min(halfDur, ANIM_FADE_SEC) : 0;
    const fadeSteps = [
      fadeInDur > 0 ? `fade=t=in:st=${startExpr}:d=${fadeInDur.toFixed(3)}:alpha=1` : "",
      fadeOutDur > 0 ? `fade=t=out:st=${(endTimeNum - fadeOutDur).toFixed(3)}:d=${fadeOutDur.toFixed(3)}:alpha=1` : "",
    ].filter(Boolean).map((f) => `,${f}`).join("");

    if (asset.type === "image") {
      filterParts.push(
        `[${idx}:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,setsar=1,format=rgba,colorchannelmixer=aa=${opacity},` +
          `trim=duration=${clip.duration.toFixed(3)},setpts=PTS-STARTPTS+${startExpr}/TB${fadeSteps}[${label}]`,
      );
    } else {
      const sourceSpan = clip.duration * speed;
      filterParts.push(
        `[${idx}:v]trim=${trimIn.toFixed(3)}:${(trimIn + sourceSpan).toFixed(3)},setpts=(PTS-STARTPTS)/${speed}+${startExpr}/TB,` +
          `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,setsar=1,format=rgba,colorchannelmixer=aa=${opacity}${fadeSteps}[${label}]`,
      );
    }

    const x = `(W-w)/2+${Math.round(Number(clip.pos_x) || 0)}`;
    const y = slideDur > 0
      ? `(H-h)/2+${Math.round(Number(clip.pos_y) || 0)}+if(lt(t-${startExpr},${slideDur.toFixed(3)}),(1-(t-${startExpr})/${slideDur.toFixed(3)})*60,0)`
      : `(H-h)/2+${Math.round(Number(clip.pos_y) || 0)}`;
    const endTime = endTimeNum.toFixed(3);
    const nextLabel = `ov${idx}`;
    filterParts.push(`${base}[${label}]overlay=x=${x}:y='${y}':enable='between(t,${startExpr},${endTime})'[${nextLabel}]`);
    base = `[${nextLabel}]`;
  }

  textClips.forEach((clip, i) => {
    const text = escapeDrawtext(clip.text_content || clip.label);
    if (!text) return;
    const startExpr = clip.start_time.toFixed(3);
    const endTime = (clip.start_time + clip.duration).toFixed(3);
    const nextLabel = `txt${i}`;
    const opacity = Math.min(1, Math.max(0, Number(clip.opacity ?? 100) / 100));
    filterParts.push(
      `${base}drawtext=text='${text}':fontcolor=white@${opacity}:fontsize=54:` +
        `x=(w-text_w)/2+${Math.round(Number(clip.pos_x) || 0)}:y=(h-text_h)/2+${Math.round(Number(clip.pos_y) || 0)}:` +
        `box=1:boxcolor=black@0.35:boxborderw=14:enable='between(t,${startExpr},${endTime})'[${nextLabel}]`,
    );
    base = `[${nextLabel}]`;
  });

  filterParts.push(`${base}format=yuv420p[vout]`);
  ffArgs.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-an",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-r", String(RENDER_FPS),
    "-t", durationSec.toFixed(3),
    outPath,
  );
  await run(FFMPEG_BIN, ffArgs);
}

async function mixTimelineAudio(
  audioClips: TimelineClipRecord[],
  durationSec: number,
  outPath: string,
  resolveAssetPath: ResolveAssetPath,
): Promise<void> {
  const ffArgs: string[] = ["-y"];
  const filterParts: string[] = [];
  const labels: string[] = [];
  let idx = 0;

  for (const clip of audioClips) {
    const asset = clip.source_asset_id ? getAsset(clip.source_asset_id) : undefined;
    if (!asset || asset.type !== "audio") continue;
    const localPath = await resolveAssetPath(asset);
    ffArgs.push("-i", localPath);
    const speed = clampSpeed(Number(clip.speed) || 1);
    const trimIn = Math.max(0, Number(clip.trim_in) || 0);
    const sourceSpan = clip.duration * speed;
    const volume = Math.max(0, Number(clip.volume ?? 100) / 100);
    const delayMs = Math.max(0, Math.round(clip.start_time * 1000));
    const label = `a${idx}`;
    filterParts.push(
      `[${idx}:a]atrim=${trimIn.toFixed(3)}:${(trimIn + sourceSpan).toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed},` +
        `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,volume=${volume},adelay=${delayMs}|${delayMs}[${label}]`,
    );
    labels.push(`[${label}]`);
    idx++;
  }

  if (labels.length === 0) {
    await run(FFMPEG_BIN, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", durationSec.toFixed(3), "-c:a", "libmp3lame", "-b:a", "192k", outPath]);
    return;
  }

  if (labels.length === 1) {
    filterParts.push(`${labels[0]}anull[out]`);
  } else {
    filterParts.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[out]`);
  }

  ffArgs.push(
    "-filter_complex", filterParts.join(";"),
    "-map", "[out]",
    "-t", durationSec.toFixed(3),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    outPath,
  );
  await run(FFMPEG_BIN, ffArgs);
}
