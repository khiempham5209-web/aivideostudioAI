import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pLimit from "p-limit";
import { TemplateScriptSchema, type TemplateScript } from "./template-script-schema.js";
import { loadConfig } from "../config.js";
import { createTtsClient } from "../tts/tts-client.js";
import {
  getDurationSec,
  concatWithSilence,
  mixSfxOntoVoice,
  mixBackgroundMusicUnderVoice,
  type SfxMixSpec,
} from "../assets/audio-tools.js";
import { indexSfxLibrary, pickSfxForScene, defaultPlayback } from "../assets/sfx-selector.js";
import { composeTemplate } from "./template-composer.js";
import { cutFootageToDuration, fitClipToDuration, concatVideos, muxAudioOntoVideo } from "./video-tools.js";
import { log } from "../utils/logger.js";

const TOTAL_STEPS = 8;
const SCENE_GAP_SEC = 0.3;
const OUTRO_HOLD_SEC = 3;
const RENDER_FPS = 30;

/** Maps a scene role to a key the SFX selector understands (tier-3 defaults). */
const TYPE_TO_SFX: Record<string, string> = {
  hook: "hook",
  body: "callout",
  outro: "outro",
};

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);

function formatSrtTime(seconds: number): string {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${pad(millis, 3)}`;
}

function srtText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function listFootageFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const dot = name.lastIndexOf(".");
      return dot >= 0 && VIDEO_EXT.has(name.slice(dot).toLowerCase());
    })
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => join(dir, name));
}

function pickFootageStartSec(
  footageIndex: number,
  sceneIndex: number,
  sourceDur: number,
  targetDur: number,
  cursorSec: number,
): number {
  const maxStart = Math.max(0, sourceDur - targetDur - 0.1);
  if (maxStart === 0) return 0;
  if (footageIndex === 0) return cursorSec % maxStart;
  return Math.min(maxStart, sceneIndex * Math.max(6, targetDur * 0.9));
}

export interface TemplatePipelineOptions {
  footageDir?: string;
  footagePlan?: Record<string, { path: string; startSec?: number | null; endSec?: number | null }>;
  backgroundAudioPath?: string;
  audioOnly?: boolean;
  burnSubtitles?: boolean;
}

export async function runTemplatePipeline(scriptPath: string, options: TemplatePipelineOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const outputDir = dirname(scriptPath);
  log.info(`Output directory: ${outputDir}`);

  // STEP 1 — load + validate
  const fileText = await readFile(scriptPath, "utf8");
  const raw = JSON.parse(fileText.replace(/^\uFEFF/, ""));
  const script: TemplateScript = TemplateScriptSchema.parse(raw);
  const effectiveTtsProvider = script.voice.provider ?? cfg.ttsProvider;
  log.step(1, TOTAL_STEPS, `Load + validate template script (TTS: ${effectiveTtsProvider})`);

  // STEP 2 — script.txt for CapCut
  log.step(2, TOTAL_STEPS, "Write script.txt");
  await writeFile(join(outputDir, "script.txt"), script.scenes.map((s) => s.voiceText).join("\n\n"));

  // STEP 3 — TTS per scene (idempotent)
  log.step(3, TOTAL_STEPS, "TTS each scene");
  const ttsClient = createTtsClient(cfg, {
    provider: effectiveTtsProvider,
    voiceName: script.voice.name,
    speed: script.voice.speed,
  });
  const limit = pLimit(cfg.ttsConcurrency);
  const voiceDir = join(outputDir, "voice");
  await mkdir(voiceDir, { recursive: true });
  const sceneAudio = await Promise.all(
    script.scenes.map((scene) =>
      limit(async () => {
        const out = join(voiceDir, `scene-${scene.id}.mp3`);
        const srtOut = join(voiceDir, `scene-${scene.id}.srt`);
        if (existsSync(out)) {
          const dur = await getDurationSec(out);
          log.info(`  scene ${scene.id}: REUSE mp3 (${dur.toFixed(2)}s)`);
          return { id: scene.id, path: out, durationSec: dur };
        }
        log.info(`  TTS scene ${scene.id} (${scene.voiceText.length} chars)...`);
        await ttsClient.generate(scene.voiceText, out, srtOut);
        const dur = await getDurationSec(out);
        log.info(`  scene ${scene.id}: ${dur.toFixed(2)}s`);
        return { id: scene.id, path: out, durationSec: dur };
      }),
    ),
  );

  // STEP 4 — concat voice + compute scene timings
  log.step(4, TOTAL_STEPS, "Concat voice + compute timings");
  const voiceRawMp3 = join(outputDir, "voice-raw.mp3");
  const voiceWithSfxMp3 = join(outputDir, "voice-with-sfx.mp3");
  const voiceMp3 = join(outputDir, "voice.mp3");
  await concatWithSilence(sceneAudio.map((a) => a.path), SCENE_GAP_SEC, voiceRawMp3);

  let cursor = 0;
  const sceneStarts: Record<string, number> = {};
  for (const a of sceneAudio) {
    sceneStarts[a.id] = cursor;
    cursor += a.durationSec + SCENE_GAP_SEC;
  }

  const subtitleDir = join(outputDir, "subtitles");
  await mkdir(subtitleDir, { recursive: true });
  const subtitlePath = join(subtitleDir, "subtitle.srt");
  const subtitleBody = script.scenes.map((scene, index) => {
    const audio = sceneAudio.find((a) => a.id === scene.id)!;
    const start = sceneStarts[scene.id];
    const end = start + audio.durationSec;
    return [
      String(index + 1),
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}`,
      srtText(scene.voiceText),
    ].join("\n");
  }).join("\n\n");
  await writeFile(subtitlePath, `${subtitleBody}\n`, "utf8");

  // STEP 5 — SFX selection + mix
  log.step(5, TOTAL_STEPS, "Pick + mix SFX");
  const SFX_DIR = join(outputDir, "..", "..", "assets", "sfx");
  const sfxIndex = existsSync(SFX_DIR) ? indexSfxLibrary(SFX_DIR) : {};
  const sfxList: SfxMixSpec[] = [];
  for (const scene of script.scenes) {
    const startSec = sceneStarts[scene.id];
    if (scene.sfx) {
      if (scene.sfx.name === "none") continue;
      const p = join(SFX_DIR, `${scene.sfx.name}.mp3`);
      if (existsSync(p)) sfxList.push({ path: p, startSec: startSec + scene.sfx.startOffsetSec, volume: scene.sfx.volume });
      continue;
    }
    if (Object.keys(sfxIndex).length === 0) continue;
    const picked = pickSfxForScene({
      voiceText: scene.voiceText,
      templateName: TYPE_TO_SFX[scene.type] ?? "callout",
      sceneId: scene.id,
      index: sfxIndex,
    });
    if (!picked) continue;
    const pb = defaultPlayback(picked);
    sfxList.push({ path: join(SFX_DIR, picked.relPath), startSec: startSec + pb.offsetSec, volume: pb.volume });
  }
  await mixSfxOntoVoice(voiceRawMp3, sfxList, voiceWithSfxMp3);
  if (options.backgroundAudioPath) {
    log.info(`  background music: ${options.backgroundAudioPath}`);
    await mixBackgroundMusicUnderVoice(voiceWithSfxMp3, options.backgroundAudioPath, voiceMp3);
  } else {
    await mixSfxOntoVoice(voiceWithSfxMp3, [], voiceMp3);
  }
  const totalAudioSec = await getDurationSec(voiceMp3);
  log.info(`  voice.mp3: ${totalAudioSec.toFixed(2)}s, ${sfxList.length} SFX`);
  if (options.audioOnly) {
    log.step(6, TOTAL_STEPS, "Audio only mode");
    console.log("\n=== Audio Result ===");
    console.log(`Audio:  ${voiceMp3}`);
    console.log(`Script: ${join(outputDir, "script.txt")}`);
    console.log(`Subtitle: ${subtitlePath}`);
    console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
    return;
  }

  // STEP 6 — render/cut each scene's visual clip, fit to narration length
  log.step(6, TOTAL_STEPS, "Render/cut visual clips + fit to narration");
  const clipsDir = join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const FOOTAGE_DIR = options.footageDir ?? join(outputDir, "..", "..", "assets", "footage");
  const footageFiles = await listFootageFiles(FOOTAGE_DIR);
  const footageDurations = await Promise.all(footageFiles.map((file) => getDurationSec(file)));
  if (footageFiles.length > 0) {
    log.info(`  footage mode: ${footageFiles.length} source video(s) from ${FOOTAGE_DIR}`);
  } else {
    log.info("  template mode: no assets/footage video files found");
  }
  const lastIdx = script.scenes.length - 1;
  const fittedClips: string[] = [];
  let footageCursor = 0;
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const dur = sceneAudio.find((a) => a.id === scene.id)!.durationSec;
    const visualDur = dur + (i < lastIdx ? SCENE_GAP_SEC : OUTRO_HOLD_SEC);

    const rawClip = join(clipsDir, `scene-${scene.id}.mp4`);
    const fitClip = join(clipsDir, `scene-${scene.id}-fit.mp4`);

    const plannedFootage = options.footagePlan?.[scene.id];
    if (plannedFootage?.path) {
      const plannedDur = await getDurationSec(plannedFootage.path);
      const startSec = Math.max(0, Number(plannedFootage.startSec ?? 0));
      const endSec = plannedFootage.endSec == null ? null : Math.max(startSec + 0.1, Number(plannedFootage.endSec));
      const clipDur = Math.min(visualDur, Math.max(0.1, (endSec ?? plannedDur) - startSec));
      if (existsSync(fitClip)) {
        log.info(`  scene ${scene.id}: REUSE assigned footage`);
      } else {
        await cutFootageToDuration(plannedFootage.path, startSec, clipDur, rawClip, script.aspect, RENDER_FPS);
        await fitClipToDuration(rawClip, visualDur, fitClip, RENDER_FPS);
      }
      log.info(`  scene ${scene.id}: assigned footage @ ${startSec.toFixed(2)}s -> ${visualDur.toFixed(2)}s`);
      fittedClips.push(fitClip);
    } else if (footageFiles.length > 0) {
      const footageIndex = footageFiles.length === 1 ? 0 : i % footageFiles.length;
      const footagePath = footageFiles[footageIndex];
      const sourceDur = footageDurations[footageIndex] ?? visualDur;
      const startSec = pickFootageStartSec(footageIndex, i, sourceDur, visualDur, footageCursor);
      if (existsSync(fitClip)) {
        log.info(`  scene ${scene.id}: REUSE footage clip`);
      } else {
        await cutFootageToDuration(footagePath, startSec, visualDur, fitClip, script.aspect, RENDER_FPS);
      }
      log.info(`  scene ${scene.id}: footage ${footageIndex + 1} @ ${startSec.toFixed(2)}s → ${visualDur.toFixed(2)}s`);
      footageCursor += visualDur;
      fittedClips.push(fitClip);
    } else {
      // IDEMPOTENT: reuse an already-rendered clip. Delete it to force a
      // re-render after editing the scene's inputs or template.
      if (existsSync(rawClip)) {
        log.info(`  scene ${scene.id}: REUSE clip — delete to force re-render`);
      } else {
        await composeTemplate({
          templateId: scene.templateId,
          inputs: scene.inputs,
          aspect: script.aspect,
          outputPath: rawClip,
          fps: RENDER_FPS,
        });
      }
      await fitClipToDuration(rawClip, visualDur, fitClip, RENDER_FPS);
      log.info(`  scene ${scene.id}: ${scene.templateId} → ${visualDur.toFixed(2)}s`);
      fittedClips.push(fitClip);
    }
  }

  // STEP 7 — concat clips + mux voice
  log.step(7, TOTAL_STEPS, "Concat clips + mux audio");
  const silentVideo = join(outputDir, "video-silent.mp4");
  const videoPath = join(outputDir, "video.mp4");
  await concatVideos(fittedClips, silentVideo);
  await muxAudioOntoVideo(silentVideo, voiceMp3, videoPath, options.burnSubtitles ? subtitlePath : undefined);

  // STEP 8 — done
  log.step(8, TOTAL_STEPS, "Done");
  console.log("\n=== Result ===");
  console.log(`Video:  ${videoPath}`);
  console.log(`Audio:  ${voiceMp3}  (cho CapCut)`);
  console.log(`Script: ${join(outputDir, "script.txt")}  (cho CapCut auto-caption)`);
  console.log(`Subtitle: ${subtitlePath}`);
  console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
}
