import { readFile, writeFile, mkdir, readdir, rm, rename } from "node:fs/promises";
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
  generateSilenceClip,
  applyVoiceAdjustments,
  type SfxMixSpec,
} from "../assets/audio-tools.js";
import { indexSfxLibrary, pickSfxForScene, defaultPlayback } from "../assets/sfx-selector.js";
import { composeTemplate } from "./template-composer.js";
import { cutFootageToDuration, fitClipToDuration, imageToKenBurnsClip, concatVideos, muxAudioOntoVideo } from "./video-tools.js";
import { fetchPexelsMedia, isPexelsConfigured, deriveVisualQuery } from "../assets/pexels-client.js";
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
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXT.has(path.slice(dot).toLowerCase());
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

function srtText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const VN_ONES = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

/** Reads a 0-999 group into Vietnamese words. `hasHigherGroup` controls the
 *  "một trăm linh năm" (105) vs "một trăm lẻ năm" style zero-tens filler —
 *  both are correct, "linh" is used here — and whether a fully-zero group
 *  should still say "không trăm" (only needed when a higher group precedes
 *  it, e.g. 1005 -> "một nghìn không trăm linh năm"). */
function readGroup(n: number, forceHundreds: boolean): string {
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;
  const parts: string[] = [];
  if (hundreds > 0 || forceHundreds) parts.push(`${VN_ONES[hundreds]} trăm`);
  if (tens === 0) {
    if (ones > 0 && (hundreds > 0 || forceHundreds)) parts.push(`linh ${VN_ONES[ones]}`);
    else if (ones > 0) parts.push(VN_ONES[ones]);
  } else if (tens === 1) {
    parts.push(ones === 5 ? "mười lăm" : ones === 0 ? "mười" : `mười ${VN_ONES[ones]}`);
  } else {
    const tensWord = `${VN_ONES[tens]} mươi`;
    if (ones === 0) parts.push(tensWord);
    else if (ones === 1) parts.push(`${tensWord} mốt`);
    else if (ones === 5) parts.push(`${tensWord} lăm`);
    else parts.push(`${tensWord} ${VN_ONES[ones]}`);
  }
  return parts.join(" ");
}

/** Spells out a non-negative integer in Vietnamese words, e.g. 1005 ->
 *  "một nghìn không trăm linh năm". Covers 0-999,999,999 (comfortably past
 *  anything a real video script would contain — chapter/scene numbers,
 *  ages, prices, dates); returns the plain digit string unchanged outside
 *  that range or for negative/non-integer input, so a pathological value
 *  never crashes a render, it just skips this specific normalization. */
function numberToVietnameseWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999_999_999) return String(value);
  if (value === 0) return "không";
  const billions = Math.floor(value / 1_000_000_000);
  const millions = Math.floor((value % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1_000);
  const rest = value % 1_000;
  const groups: string[] = [];
  if (billions > 0) groups.push(`${readGroup(billions, false)} tỷ`);
  if (millions > 0) groups.push(`${readGroup(millions, groups.length > 0)} triệu`);
  if (thousands > 0) groups.push(`${readGroup(thousands, groups.length > 0)} nghìn`);
  if (rest > 0 || groups.length === 0) groups.push(readGroup(rest, groups.length > 0));
  return groups.join(" ").replace(/\s+/g, " ").trim();
}

/** Quote marks are never meant to be spoken, but leaving them in for TTS
 *  input isn't just cosmetic — a line starting right at a quote character
 *  (dialogue-style scenes like `"Bác mang cây đi đâu vậy ạ?"`) is where we
 *  observed both Piper/espeak-ng synthesis failures AND clipped first
 *  words, on both Piper and Edge. Strip double-quote variants before
 *  synthesis only — subtitles/script.txt still show the real punctuation.
 *
 *  Same reasoning extends to a few other characters that turned up in real
 *  long-form story scripts (chapter headers like "CHƯƠNG 12", em/en-dashes,
 *  the single-character "…" glyph): none of these are guaranteed to be
 *  handled the way plain ASCII punctuation is by Piper/espeak-ng's
 *  Vietnamese frontend, so normalize them before synthesis instead of
 *  hoping the phonemizer copes. Standalone digit runs are spelled out in
 *  Vietnamese words — the project convention is for scripts to already do
 *  this (see TemplateScene.voiceText), but this is a safety net for the
 *  cases that slip through (chapter/scene numbers are a common one), not a
 *  replacement for writing scripts correctly in the first place. */
function textForTts(text: string): string {
  return text
    .replace(/["“”„‟«»]/g, "")
    .replace(/…/g, "...")
    .replace(/[–—]/g, ", ")
    .replace(/\b\d+\b/g, (digits) => numberToVietnameseWords(Number(digits)))
    .replace(/\s+/g, " ")
    .trim();
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
  /** Reports (step label, 0-100 progress within this pipeline) so a crash mid-run
   *  points at exactly which scene/step it died on, instead of a frozen "25%". */
  onProgress?: (step: string, progress: number) => void;
}

export interface TemplatePipelineResult {
  /** Real TTS-measured duration per scene id — lets callers anchor subtitle/UI timing to actual audio. */
  sceneDurations: Record<string, number>;
}

export async function runTemplatePipeline(scriptPath: string, options: TemplatePipelineOptions = {}): Promise<TemplatePipelineResult> {
  const cfg = loadConfig();
  const outputDir = dirname(scriptPath);
  log.info(`Output directory: ${outputDir}`);
  const report = (step: string, progress: number) => options.onProgress?.(step, progress);

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
  // Dialogue/Q&A mode: a second voice for scenes tagged speaker "B" (see
  // template-script-schema.ts). Absent in single-voice projects, in which
  // case every scene is speaker "A" and only ttsClient above is used.
  const ttsClient2 = script.voice2
    ? createTtsClient(cfg, {
        provider: script.voice2.provider ?? cfg.ttsProvider,
        voiceName: script.voice2.name,
        speed: script.voice2.speed,
      })
    : null;
  const ttsClientFor = (scene: TemplateScript["scenes"][number]) =>
    scene.speaker === "B" && ttsClient2 ? ttsClient2 : ttsClient;
  const limit = pLimit(cfg.ttsConcurrency);
  const voiceDir = join(outputDir, "voice");
  await mkdir(voiceDir, { recursive: true });

  // The reuse check below (`if (existsSync(out))`) is what lets a retried
  // job skip scenes it already synthesized — but it only checks file
  // existence, not which voice (or which version of the TTS pipeline) made
  // the file. Without this guard, switching a project's voice and
  // re-generating silently kept reusing the OLD voice's audio for every
  // scene that happened to already have an mp3 on disk from a prior run, so
  // the output never changed to match the newly selected voice. Clearing
  // stale scene files when this signature changes makes the reuse
  // optimization voice-aware.
  //
  // The "chunked-vN" segment is a manual cache-buster for changes to HOW a
  // scene gets synthesized (not just which voice) — e.g. splitForPiper's
  // rewrite from one-Piper-call-per-sentence to greedily packing sentences
  // into fewer calls (v3) changed the actual audio for scenes with multiple
  // sentences even though the voice itself didn't change. Bump this number
  // any time piper-client.ts's synthesis/trim/chunking logic changes, or
  // every regenerate on every already-rendered project keeps silently
  // reusing pre-fix audio forever — this is what made two separate rounds
  // of "still broken" reports in the same day turn out to be untested old
  // audio, not the fix actually failing.
  const voice2Signature = script.voice2 ? `:${script.voice2.provider}:${script.voice2.name}:${script.voice2.speed}:${script.voice2.pitch}:${script.voice2.volume}` : "";
  // pitch/volume added to the signature for the same reason speed is in it —
  // they're applied via post-processing (applyVoiceAdjustments), so a scene
  // reused from a prior run with different pitch/volume settings would
  // silently keep the OLD pitch/volume forever otherwise.
  const voiceSignature = `${effectiveTtsProvider}:chunked-v6:${script.voice.name}:${script.voice.speed}:${script.voice.pitch}:${script.voice.volume}${voice2Signature}`;
  const voiceSignaturePath = join(voiceDir, ".voice-signature");
  const previousSignature = existsSync(voiceSignaturePath) ? await readFile(voiceSignaturePath, "utf8") : null;
  if (previousSignature !== voiceSignature) {
    const staleFiles = (await readdir(voiceDir)).filter((f) => f.startsWith("scene-"));
    await Promise.all(staleFiles.map((f) => rm(join(voiceDir, f), { force: true })));
    await writeFile(voiceSignaturePath, voiceSignature, "utf8");
  }

  let ttsDone = 0;
  const reportTts = () => {
    ttsDone += 1;
    // TTS is a small slice of a full video render (scene rendering + video
    // encoding still follow it), but it's nearly the WHOLE job when
    // audioOnly — reusing the same narrow 5-20 band there left the progress
    // bar visibly stuck around 38-46% (after api.ts's own audioOnly-specific
    // remap) for the entire TTS phase, the longest part of an audio-only
    // job, then jumping straight to 100% at the very end.
    report(
      `Đang tạo giọng đọc: ${ttsDone}/${script.scenes.length} scene`,
      options.audioOnly
        ? Math.round((ttsDone / script.scenes.length) * 90)
        : 5 + Math.round((ttsDone / script.scenes.length) * 15),
    );
  };
  const sceneAudio = await Promise.all(
    script.scenes.map((scene) =>
      limit(async () => {
        const out = join(voiceDir, `scene-${scene.id}.mp3`);
        const srtOut = join(voiceDir, `scene-${scene.id}.srt`);
        if (existsSync(out)) {
          const dur = await getDurationSec(out);
          log.info(`  scene ${scene.id}: REUSE mp3 (${dur.toFixed(2)}s)`);
          reportTts();
          return { id: scene.id, path: out, durationSec: dur };
        }
        let preparedText = textForTts(scene.voiceText);
        if (!/\p{L}/u.test(preparedText)) {
          // No actual letters left after normalization (digits are already
          // spelled out by textForTts, so this only catches things like a
          // standalone "…"). A scene that's just an ellipsis is usually the
          // continuation marker in a numbered list written out across
          // scenes ("1." / "2." / "3." / "…" / "37.", meaning "numbered 1
          // through 37") — meant to be read aloud as part of that sequence,
          // not skipped. Speak it as "chấm chấm chấm" (literally "dot dot
          // dot", how it's naturally read out loud in Vietnamese).
          if (/^\.{3}$/.test(preparedText)) {
            preparedText = "chấm chấm chấm";
          } else {
            // Anything else with no letters at all (truly empty/garbage
            // content) has no sensible spoken reading — every TTS engine
            // legitimately fails trying to synthesize speech from
            // punctuation alone (Piper throws immediately, Edge and the
            // gTTS fallback both error out on empty input), which used to
            // crash the entire render on whichever scene hit this rather
            // than just that one scene. Render it as a short silent beat
            // instead of crashing.
            log.info(`  scene ${scene.id}: no spoken content ("${scene.voiceText}") — rendering as silence`);
            await generateSilenceClip(out, 1.2);
            if (srtOut) await writeFile(srtOut, "", "utf-8");
            const dur = await getDurationSec(out);
            reportTts();
            return { id: scene.id, path: out, durationSec: dur };
          }
        }
        log.info(`  TTS scene ${scene.id} (${scene.voiceText.length} chars)...`);
        await ttsClientFor(scene).generate(preparedText, out, srtOut);
        // Only Edge has native rate control (applied inside EdgeTtsClient
        // itself via --rate) — Piper/OmniVoice/Supertonic ignore speed
        // entirely unless it's applied here too. Pitch/volume have no
        // native support anywhere, so those always go through post-processing
        // regardless of provider.
        const isVoice2Scene = scene.speaker === "B" && script.voice2;
        const voiceSettings = isVoice2Scene ? script.voice2! : script.voice;
        const sceneProvider = isVoice2Scene ? (script.voice2!.provider ?? cfg.ttsProvider) : effectiveTtsProvider;
        const speedNeedsPostProcess = sceneProvider !== "edge" && voiceSettings.speed !== 1;
        if (speedNeedsPostProcess || voiceSettings.pitch !== 0 || voiceSettings.volume !== 100) {
          const adjustedPath = `${out}.adjusted.mp3`;
          await applyVoiceAdjustments(out, adjustedPath, {
            speed: speedNeedsPostProcess ? voiceSettings.speed : 1,
            pitchSemitones: voiceSettings.pitch,
            volumePercent: voiceSettings.volume,
          });
          await rm(out, { force: true });
          await rename(adjustedPath, out);
        }
        const dur = await getDurationSec(out);
        log.info(`  scene ${scene.id}: ${dur.toFixed(2)}s`);
        reportTts();
        return { id: scene.id, path: out, durationSec: dur };
      }),
    ),
  );

  // STEP 4 — concat voice + compute scene timings
  log.step(4, TOTAL_STEPS, "Concat voice + compute timings");
  const voiceRawMp3 = join(outputDir, "voice-raw.mp3");
  const voiceWithSfxMp3 = join(outputDir, "voice-with-sfx.mp3");
  const voiceMp3 = join(outputDir, "voice.mp3");
  const { leadingSilenceSec, segmentDurationsSec } = await concatWithSilence(
    sceneAudio.map((a) => a.path),
    SCENE_GAP_SEC,
    voiceRawMp3,
  );

  // concatWithSilence measured each segment's duration off its own
  // post-resample, post-fade WAV — the exact bytes that ended up in
  // voiceRawMp3 — which differs slightly from each scene's pre-concat mp3
  // duration (that mp3 gets decoded, resampled and re-encoded on its way
  // into the concat). Overwrite durationSec here so every downstream use
  // (subtitle end times below, and the per-scene video duration further
  // down) is measured against what's actually in the audio file instead of
  // an estimate that drifts a few ms further off it each scene — by the
  // back half of a 90+ scene render that drift was over a second.
  sceneAudio.forEach((a, i) => {
    a.durationSec = segmentDurationsSec[i];
  });

  // concatWithSilence also pads `leadingSilenceSec` of silence before the
  // very first segment (not just between segments) — a cursor starting at 0
  // ignored that pad entirely, making every scene's subtitle start early by
  // exactly that amount.
  let cursor = leadingSilenceSec;
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
  const sceneDurations = Object.fromEntries(sceneAudio.map((a) => [a.id, a.durationSec]));
  if (options.audioOnly) {
    report("Ghép giọng đọc + trộn âm thanh", 96);
    log.step(6, TOTAL_STEPS, "Audio only mode");
    console.log("\n=== Audio Result ===");
    console.log(`Audio:  ${voiceMp3}`);
    console.log(`Script: ${join(outputDir, "script.txt")}`);
    console.log(`Subtitle: ${subtitlePath}`);
    console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
    return { sceneDurations };
  }

  // STEP 6 — render/cut each scene's visual clip, fit to narration length
  log.step(6, TOTAL_STEPS, "Render/cut visual clips + fit to narration");
  const clipsDir = join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const pexelsCacheDir = join(outputDir, "..", "..", "assets", "pexels-cache");
  if (isPexelsConfigured()) await mkdir(pexelsCacheDir, { recursive: true });
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
    report(`Đang dựng hình scene ${i + 1}/${script.scenes.length}`, 20 + Math.round((i / script.scenes.length) * 65));
    const dur = sceneAudio.find((a) => a.id === scene.id)!.durationSec;
    const visualDur = dur + (i < lastIdx ? SCENE_GAP_SEC : OUTRO_HOLD_SEC);

    const rawClip = join(clipsDir, `scene-${scene.id}.mp4`);
    const fitClip = join(clipsDir, `scene-${scene.id}-fit.mp4`);

    const plannedFootage = options.footagePlan?.[scene.id];
    if (plannedFootage?.path && isImagePath(plannedFootage.path)) {
      if (existsSync(fitClip)) {
        log.info(`  scene ${scene.id}: REUSE image Ken Burns clip`);
      } else {
        await imageToKenBurnsClip(plannedFootage.path, visualDur, fitClip, script.aspect, RENDER_FPS);
      }
      log.info(`  scene ${scene.id}: assigned image (Ken Burns) -> ${visualDur.toFixed(2)}s`);
      fittedClips.push(fitClip);
    } else if (plannedFootage?.path) {
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
    } else if (isPexelsConfigured()) {
      // AI-script-generated scenes already carry an English visualQuery
      // (see prompt-to-script.ts's prompt). Manually-written/pasted scenes
      // — the common case — had none, and used to get skipped straight to
      // the AI-drawn template as if Pexels weren't configured at all.
      // Deriving one here from the (often Vietnamese) narration text means
      // real stock footage is attempted regardless of how the scene's text
      // was created, not just for the one script-entry path. Only spend the
      // Gemini call when actually about to fetch — a REUSE hit below skips
      // it entirely.
      const visualQuery = existsSync(fitClip) ? null : scene.visualQuery || (await deriveVisualQuery(scene.voiceText));
      const pexels = visualQuery ? await fetchPexelsMedia(visualQuery, script.aspect, pexelsCacheDir) : null;
      if (existsSync(fitClip)) {
        log.info(`  scene ${scene.id}: REUSE Pexels/template clip`);
        fittedClips.push(fitClip);
      } else if (pexels?.type === "video") {
        await cutFootageToDuration(pexels.path, 0, visualDur, fitClip, script.aspect, RENDER_FPS);
        log.info(`  scene ${scene.id}: Pexels video "${visualQuery}" -> ${visualDur.toFixed(2)}s`);
        fittedClips.push(fitClip);
      } else if (pexels?.type === "image") {
        await imageToKenBurnsClip(pexels.path, visualDur, fitClip, script.aspect, RENDER_FPS);
        log.info(`  scene ${scene.id}: Pexels photo "${visualQuery}" (Ken Burns) -> ${visualDur.toFixed(2)}s`);
        fittedClips.push(fitClip);
      } else {
        log.info(`  scene ${scene.id}: no Pexels match for "${visualQuery ?? "(no query)"}", falling back to AI template`);
        if (existsSync(rawClip)) {
          log.info(`  scene ${scene.id}: REUSE clip — delete to force re-render`);
        } else {
          await composeTemplate({ templateId: scene.templateId, inputs: scene.inputs, aspect: script.aspect, outputPath: rawClip, fps: RENDER_FPS });
        }
        await fitClipToDuration(rawClip, visualDur, fitClip, RENDER_FPS);
        fittedClips.push(fitClip);
      }
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
  report("Ghép video + trộn âm thanh", 88);
  const silentVideo = join(outputDir, "video-silent.mp4");
  const videoPath = join(outputDir, "video.mp4");
  await concatVideos(fittedClips, silentVideo);
  await muxAudioOntoVideo(silentVideo, voiceMp3, videoPath, options.burnSubtitles ? subtitlePath : undefined, script.aspect);

  // STEP 8 — done
  log.step(8, TOTAL_STEPS, "Done");
  console.log("\n=== Result ===");
  console.log(`Video:  ${videoPath}`);
  console.log(`Audio:  ${voiceMp3}  (cho CapCut)`);
  console.log(`Script: ${join(outputDir, "script.txt")}  (cho CapCut auto-caption)`);
  console.log(`Subtitle: ${subtitlePath}`);
  console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
  return { sceneDurations };
}
