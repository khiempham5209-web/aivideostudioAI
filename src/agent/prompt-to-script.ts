import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import dotenv from "dotenv";
import { z } from "zod";
import {
  TemplateScriptSchema,
  type TemplateScript,
} from "../render/template-script-schema.js";
import { toSlug } from "../utils/slug.js";

dotenv.config({ path: ".env.local" });

// "||" on purpose, not "??": CHANNEL_NAME can be present-but-empty in
// .env.local (e.g. after the desktop auto-sync writes `CHANNEL_NAME=`), and
// an empty string must fall through to the default too, not just a truly
// missing key — an empty channel name fails TemplateScriptSchema's
// metadata.channel (z.string().min(1)) and silently discards the real AI
// script for the generic fallback script instead.
const CHANNEL_NAME = process.env.CHANNEL_NAME || "Khiempham AI";
export const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

// The scene-count cap lives in one place now: TemplateScriptSchema itself
// (src/render/template-script-schema.ts). Reuse it as-is rather than
// rebuilding — a prior version of this file tried to override just the
// bound via .extend({ scenes: TemplateScriptSchema.shape.scenes.max(N) }),
// but that schema is already a ZodEffects (it has .refine() chains on it),
// so calling .max() on it silently did nothing and the old .max(12) kept
// winning. Don't repeat that mistake here.
const GeneratedScriptSchema = TemplateScriptSchema;

export interface GenerateScriptOptions {
  outputRoot?: string;
  model?: string;
  channel?: string;
  voiceProvider?: "edge" | "omnivoice" | "piper" | "supertonic";
  voiceName?: string;
  voiceSpeed?: number;
  /** Target spoken duration in seconds — shapes requested word count and scene count. */
  targetDurationSec?: number;
  /** "auto" (content mode only): targetDurationSec becomes a loose token-budget
   *  headroom number instead of a real target — the AI is told to pick a
   *  length that actually fits the topic instead of padding/trimming to a
   *  fixed number. */
  durationMode?: "fixed" | "auto";
  /** Which AI writes the script. Defaults to Gemini. */
  aiProvider?: "gemini" | "openai";
  /** Real product facts (name/price/shop/key points) to ground the script in —
   *  see buildPrompt: forbids inventing specs and forces the hook scene to
   *  name the actual product. */
  productFacts?: string;
  /** Business mode chosen at project creation. "affiliate" swaps in
   *  product-first, no-personal-experience, CTA-closing script rules;
   *  "content" (default) keeps the entertainment/review framing. */
  mode?: "affiliate" | "content";
  /** Where the affiliate video will be posted — only changes the CTA line's
   *  exact wording (plan section 7's rule engine). Ignored in "content" mode. */
  platform?: "tiktok_shop" | "shopee_aff" | "generic";
  /** Second voice for dialogue/Q&A mode — providing both this and
   *  secondVoiceName switches the script from single-narrator to an
   *  alternating two-speaker Q&A format (see buildPrompt). Omit both for
   *  the default single-voice behavior. */
  secondVoiceProvider?: "edge" | "omnivoice" | "piper" | "supertonic";
  secondVoiceName?: string;
}

export interface GeneratedScriptResult {
  script: TemplateScript;
  outputDir: string;
  scriptPath: string;
}

function timestampForPath(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

/**
 * The model occasionally echoes a multi-line input (e.g. a topic the user
 * typed with a literal line break in it) back into a JSON string value
 * without escaping the newline, producing invalid JSON like
 * `"...text\n  more text..."` — a bare newline inside a string, which
 * JSON.parse rejects with "Expected ',' or '}' after property value".
 * Walk the text tracking whether we're inside a quoted string and escape
 * any bare control character we find there before re-parsing.
 */
function sanitizeJsonControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    try {
      return JSON.parse(sanitizeJsonControlChars(text));
    } catch {
      throw error;
    }
  }
}

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // With responseMimeType "application/json" this should already be pure JSON;
  // try it directly first before falling back to a lenient substring extraction.
  try {
    return parseJsonLoose(cleaned);
  } catch {
    // fall through
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Gemini did not return a JSON object");
  }

  return parseJsonLoose(cleaned.slice(first, last + 1));
}

function normalizeGeneratedScript(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;

  const script = raw as { scenes?: unknown };
  if (!Array.isArray(script.scenes)) return raw;
  const scenes = script.scenes;

  return {
    ...script,
    scenes: scenes.map((scene, index) => {
      if (!scene || typeof scene !== "object") return scene;
      const item = scene as { type?: unknown };
      const forcedType =
        index === 0
          ? "hook"
          : index === scenes.length - 1
            ? "outro"
            : "body";
      return {
        ...item,
        type: forcedType,
      };
    }),
  };
}

function buildPrompt(
  userRequest: string,
  channel: string,
  voiceProvider: "edge" | "omnivoice" | "piper" | "supertonic",
  voiceName: string,
  voiceSpeed: number,
  targetDurationSec: number,
  productFacts?: string,
  mode: "affiliate" | "content" = "content",
  platform: "tiktok_shop" | "shopee_aff" | "generic" = "generic",
  durationMode: "fixed" | "auto" = "fixed",
  secondVoice?: { provider: "edge" | "omnivoice" | "piper" | "supertonic"; name: string },
): { text: string; minWords: number; maxWords: number } {
  // "Auto" only makes sense for content mode — affiliate always targets a
  // real, fixed ad length (60/90/120s), never "however long the topic needs".
  const isAutoDuration = durationMode === "auto" && mode !== "affiliate";
  // Affiliate product videos are short-form ads, not long-form content — cap
  // the effective duration regardless of what the project's duration dial
  // was set to (that dial is shared with AI Content mode, which allows up to
  // 30 minutes). The plan's original spec was 15-45s; real-world testing
  // against a real product showed that's too tight for an actual persuasive
  // structure (hook, relatable problem, dramatized benefits, CTA). Range
  // widened again to 35-120s per the follow-up spec (which explicitly wants
  // 60/90/120s as the three real options) — 120s is still a short ad, not a
  // documentary, and the wider ceiling is what makes the "8-20 scenes"
  // target below reachable at all.
  const effectiveDurationSec = mode === "affiliate"
    ? Math.min(120, Math.max(35, targetDurationSec))
    : targetDurationSec;
  // Vietnamese TTS at normal speed reads roughly 2.4-2.6 words/sec.
  const targetWords = Math.round(effectiveDurationSec * 2.5);
  // Auto mode: targetDurationSec is just a ceiling for token-budget headroom,
  // not a real target — drop the 0.85 floor so a naturally short topic can
  // stay short instead of being padded out to hit a word count nobody asked for.
  const minWords = isAutoDuration ? 60 : Math.max(60, Math.round(targetWords * 0.85));
  const maxWords = Math.round(targetWords * 1.15);
  // Affiliate scene density follows the spec's three anchor points exactly
  // (60s->8-12, 90s->12-16, 120s->16-20 — each range is 4 scenes wide, and
  // the floor scales at a constant 2/15 scenes-per-second, so this formula
  // reproduces all three anchors exactly instead of the old flat
  // duration/14 divisor, which gave a 60s affiliate ad only ~4 scenes.
  // Content mode keeps the old ~14s/scene pacing — it wasn't the one this
  // was reported broken for, and it already yields plenty of scenes across
  // the up-to-30-minute range that mode allows.
  const minScenes = mode === "affiliate"
    ? Math.max(3, Math.round((effectiveDurationSec * 2) / 15))
    : isAutoDuration
      ? 3
      : Math.max(3, Math.round(effectiveDurationSec / 14) - 2);
  const maxScenes = mode === "affiliate"
    ? Math.min(155, minScenes + 4)
    : Math.min(155, Math.max(3, Math.round(effectiveDurationSec / 14)) + 2);
  // Plan section 7's rule engine: CTA wording is platform-specific, everything
  // else about the ad is the same regardless of where it's posted.
  const platformCta = platform === "tiktok_shop"
    ? `end on a call-to-action inviting the viewer to check the product pinned/linked below the video (e.g. "xem sản phẩm được gắn bên dưới video này") — do not mention Shopee or any other platform by name`
    : platform === "shopee_aff"
      ? `end on a call-to-action inviting the viewer to check the current price on Shopee via the link in the description/bio (e.g. "xem giá trên Shopee ở link trong mô tả") — do not mention TikTok or any other platform by name`
      : `end on a call-to-action inviting the viewer to check the product info via the link in the video description`;
  const modeRules = mode === "affiliate" ? `
- This is an AFFILIATE PRODUCT AD whose job is to make someone want to buy — not a spec sheet read aloud, and not a review/commentary video. A viewer who watches this and thinks "ok, and?" is a failed ad even if every fact in it is accurate.
- Follow a real ad structure, not a bullet list of facts:
  1. HOOK (first scene): open on a specific, relatable moment where the viewer feels the problem — a concrete scenario they recognize ("đồ trang điểm vương vãi khắp bàn mỗi sáng"), not an abstract statement ("nhiều người gặp vấn đề lưu trữ"). Make them think "đúng là mình luôn vậy".
  2. TURN (early body): introduce the product as the specific answer to that exact moment, not a generic "và đây là giải pháp" transition.
  3. BENEFITS (middle body, most of the runtime): each benefit gets its own concrete, sensory, visual payoff — what the viewer will SEE or FEEL change, not just a restated feature. "gọn gàng hơn" is weak; "mở ngăn bàn ra là thấy ngay từng món, không phải bới tung mọi thứ" is strong. Pull this from "Thông tin sản phẩm THẬT" but dramatize it, don't just restate the bullet.
  4. CTA (outro): ${platformCta} — do not say "mua ngay" as a command; invite them to look, not order.
- Product-first: the hook must feature the product's situation, not a generic story unrelated to it.
- NEVER write or imply that the narrator personally used, tried, or tested the product ("mình đã dùng", "sau khi trải nghiệm", "mình thấy da mình..."). Speak about the product's stated facts/benefits in third person instead ("sản phẩm này...", "công dụng chính là...") — you can still be vivid and sensory in third person without claiming personal use.
- Do NOT invent specs, results, or benefits beyond what is listed in "Thông tin sản phẩm THẬT" below. Dramatizing a real benefit ("tìm đồ trong 2 giây thay vì lục tung cả bàn") is encouraged; inventing a new benefit that isn't there is not.
- HARD RULE: never state a price, a discount amount, or any number of đồng/VNĐ in ANY scene's voiceText, not even in the outro — prices change and a wrong spoken price is a real compliance risk. The reference price in "Thông tin sản phẩm THẬT" is context for you only, never to be spoken. Invite the viewer to check the current price via the link/description instead (e.g. "xem giá hiện tại ở phần mô tả").
- Keep pacing tight and punchy — this is a short ad, not a documentary — but "tight" means no wasted words, not "just list the facts and stop." Every sentence should either build the scenario, land a benefit, or move toward the CTA.` : `
- This is a review/commentary video. Do not recreate copyrighted dialogue, do not provide a scene-by-scene substitute for watching the movie, and keep the tone transformative: summary, opinion, themes, strengths, weaknesses, verdict.
- If the user asks to review a film, cover: hook, premise, main conflict, character arc, highlights, weak points, message, verdict.${isAutoDuration ? `
- DURATION IS AUTOMATIC: the ${minWords}-${maxWords} word / ${minScenes}-${maxScenes} scene numbers below are a ceiling only, not a target to hit. Decide the actual length yourself based on how much the topic genuinely needs to say — a quick tip or simple fact deserves a short, tight script; a process, story, or multi-part topic deserves a long one. Do NOT pad with repetition or filler to reach a word/scene count, and do NOT cut real content short just because you reached a "typical" length. Length should be a consequence of the content, not the other way around.` : ""}${effectiveDurationSec > 150 ? `
- This is a longer video with ${minScenes}-${maxScenes} scenes to fill, covering a topic that likely has a natural sequence (a process, a timeline, a build, a list of distinct sub-topics). Before writing scenes, mentally split the topic into clear sequential CHAPTERS that together cover it start to finish — e.g. for "xây nhà cấp 4 ở nông thôn" that's roughly: chọn/chuẩn bị đất -> san nền -> làm móng -> xây tường -> làm mái -> hoàn thiện nội thất -> thành quả. Then distribute the scenes evenly across those chapters (a few scenes per chapter, not all scenes on one chapter while others get skipped). Do NOT pad a single chapter with repetitive scenes just to hit the scene-count floor — if you're repeating yourself, you've missed a real chapter you haven't covered yet.
- Make the chapter progression audible in the script itself: each chapter's first scene should clearly signal the topic has moved to a new phase (e.g. "Sau khi có nền xong, bước tiếp theo là...", "Tiếp đến là phần mái nhà..."), so a listener can follow the structure without seeing any on-screen chapter labels.` : ""}`;
  const promptText = `
You create Vietnamese short ${mode === "affiliate" ? "product ad" : "review"} videos as JSON for an existing renderer.

User request:
${userRequest}
${productFacts ? `
Thông tin sản phẩm THẬT (bắt buộc dùng đúng, không được bịa thêm thông số hay công dụng không có ở đây):
${productFacts}
Cảnh đầu tiên (hook) phải giới thiệu đúng tên sản phẩm này. Không được nhắc đến link/URL trong lời thoại.
` : ""}

Return ONLY valid JSON matching this exact structure:
{
  "version": "1.0",
  "renderer": "hyperframes",
  "metadata": {
    "title": "...",
    "source": { "url": "local://user-request", "domain": "local", "image": null },
    "channel": "${channel}"
  },
  "voice": { "provider": "${voiceProvider}", "name": "${voiceName}", "speed": ${voiceSpeed} },${secondVoice ? `
  "voice2": { "provider": "${secondVoice.provider}", "name": "${secondVoice.name}", "speed": ${voiceSpeed} },` : ""}
  "aspect": "9:16",
  "scenes": []
}
${secondVoice ? `
DIALOGUE MODE (2 voices): this script is spoken by TWO people having a Q&A-style conversation, not one narrator. "voice" is speaker A, "voice2" is speaker B. Write it as an actual back-and-forth: speaker A asks/introduces, speaker B answers/reacts, and so on — not one person's monologue split in half. Every scene object MUST include a "speaker" field, either "A" or "B", matching who is talking in that scene's voiceText. Alternate speakers naturally as the conversation flows (a speaker can occasionally take two scenes in a row if the conversation genuinely calls for it, e.g. a longer answer), but the overall script must clearly read as a dialogue between two people, not a single voice with a label slapped on. The hook (first scene) and outro (last scene) still follow the usual hook/outro rules, just spoken by whichever speaker fits.
` : ""}
Scene rules:
- Create ${minScenes} to ${maxScenes} scenes total${isAutoDuration ? " AT MOST" : ""}: first scene type "hook", last scene type "outro", the rest type "body".${isAutoDuration ? ` This is a ceiling, not a target — use as few of them as the topic genuinely needs (a trivial topic can be just hook + 1 body + outro = 3 scenes).` : ""}
${isAutoDuration
    ? `- The ${minWords}-${maxWords} word count is a CEILING ONLY (never exceed ${maxWords}) — there is NO floor. Stop writing as soon as you've genuinely said everything worth saying about the topic, even if that's well under ${minWords} words. A 3-sentence answer to a simple question is a correct, complete response here, not an unfinished one.`
    : `- HARD REQUIREMENT: the sum of all scene.voiceText combined must be ${minWords} to ${maxWords} Vietnamese words total — this is a hard ceiling AND floor, not a suggestion. Count every word across every scene as you write, including the hook and outro. A script shorter than ${minWords} words OR longer than ${maxWords} words is a FAILED response — going over the ceiling is just as much a failure as falling short of the floor. Before returning your JSON, count the total words one more time and cut sentences if you are over ${maxWords}.`}
${isAutoDuration
    ? `- Do NOT pad, repeat yourself, or invent tangential sub-points just to reach a longer runtime. Never exceed ${maxWords} words either — if the topic is huge, cover the most important parts well rather than everything shallowly.`
    : mode === "affiliate"
      ? `- Do NOT pad this out. This is a short ad — if you run out of real content before ${minWords} words, that means fewer, punchier sentences per point, not more scenes or invented filler. Never exceed ${maxWords} words to "cover everything" — cut a point instead.`
      : `- If the topic alone does not naturally have enough content, you MUST expand it yourself: add more concrete steps/details, examples, comparisons, tips, background context, or elaboration on each point, so the total reaches the required word count without exceeding ${maxWords}. Do not simply repeat the same idea in different words — add genuinely new, useful sub-points.`}
- Each scene.voiceText must be a plain Vietnamese string, 2 to 4 sentences (longer per-scene text is expected for longer videos), no emoji, no URL, no markdown.${modeRules}
- Write numbers and symbols in voiceText as Vietnamese words when possible.

Allowed templateId and required inputs:
- hook: "frame-liquid-bg-hero" with inputs { "kicker", "headline", "subheadline", "cta", "brand" }.
- body: choose varied templates:
  - "frame-build-minimal" inputs { "eyebrow", "hero", "desc", "side_left", "side_right" }.
  - "frame-bold-poster" inputs { "kicker", "date", "figure", "headline", "standfirst", "footer_left", "footer_right" } where headline is an array of up to 3 short strings.
  - "frame-glitch-title" inputs { "title", "subtitle" }.
  - "frame-aicoding-list" inputs { "title", "accent", "subtitle", "items" } where items has 2 to 4 objects { "icon", "title", "desc", "tag", "level" }, level is danger/warn/good/info.
  - "frame-aicoding-comparison" inputs { "badge", "pre", "vs", "post", "left", "right" }.
- outro: "frame-logo-outro" with inputs { "brand_name", "tagline", "primary_url" }.

Keep all on-screen input text short so it fits a vertical video.
Use id values like "hook", "body-1", "body-2", "outro".

Also add a "visualQuery" field to every scene: 2-4 English keywords describing
a stock photo/video that would visually match that scene's narration (used to
search a stock media library). Concrete and visual, not abstract — e.g.
"mountain hiking trail" not "adventure feeling". Example: { "id": "body-1", ...,
"visualQuery": "busy city street night" }.
`;
  return { text: promptText, minWords, maxWords };
}

/** Deterministic safety net for buildPrompt's word-count ceiling (see the
 *  comment at its call site) — cuts trailing sentences from the longest
 *  scenes first until the script fits maxWords, always leaving at least one
 *  sentence per scene. Never touches templateId/inputs/type, so it can't
 *  break the JSON shape the way asking the model to redo the script did. */
function trimScriptToWordBudget(script: TemplateScript, maxWords: number): TemplateScript {
  const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);
  let total = script.scenes.reduce((sum, s) => sum + wordsOf(s.voiceText).length, 0);
  if (total <= maxWords) return script;

  const scenes = script.scenes.map((s) => ({ ...s }));
  // Split each scene into sentences up front so trimming one sentence off
  // never leaves a dangling half-sentence.
  const sentenceSplit = (text: string) => text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
  const sceneSentences = scenes.map((s) => sentenceSplit(s.voiceText));

  // Repeatedly drop the last sentence from whichever scene currently has the
  // most sentences left (spreads the cut across scenes instead of gutting
  // just one), stopping once under budget or every scene is down to its
  // last sentence.
  while (total > maxWords) {
    let longestIdx = -1;
    for (let i = 0; i < sceneSentences.length; i++) {
      if (sceneSentences[i].length > 1 && (longestIdx === -1 || sceneSentences[i].length > sceneSentences[longestIdx].length)) {
        longestIdx = i;
      }
    }
    if (longestIdx === -1) break; // every scene is already a single sentence
    const removed = sceneSentences[longestIdx].pop()!;
    total -= wordsOf(removed).length;
  }

  return {
    ...script,
    scenes: scenes.map((s, i) => ({ ...s, voiceText: sceneSentences[i].join(" ") })),
  };
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export async function callGemini(promptText: string, model: string, maxOutputTokens: number): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env.local");
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await ai.models.generateContent({
    model,
    contents: promptText,
    // responseMimeType constrains Gemini to emit syntactically valid JSON at the
    // API level, instead of hoping a free-text completion happens to be parseable
    // (Vietnamese text with embedded quotes was breaking naive JSON parsing).
    // thinkingBudget: 0 disables Gemini 2.5's internal "thinking" tokens, which
    // otherwise silently eat into maxOutputTokens — on short requests (small
    // token budget) thinking alone could exhaust the whole budget, truncating
    // the actual JSON to a few dozen characters with no visible error.
    config: { maxOutputTokens, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  });
  const finishReason = result.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini response cut short (finishReason: ${finishReason}) — response text: ${(result.text ?? "").slice(0, 200)}`);
  }
  return result.text ?? "";
}

async function callOpenAI(promptText: string, model: string, maxOutputTokens: number): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in .env.local");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: promptText }],
  });
  return completion.choices[0]?.message?.content ?? "";
}

export async function generateScriptFromPrompt(
  userRequest: string,
  options: GenerateScriptOptions = {},
): Promise<GeneratedScriptResult> {
  const prompt = userRequest.trim();
  if (!prompt) throw new Error("Prompt is required");

  const channel = options.channel ?? CHANNEL_NAME;
  const voiceProvider = options.voiceProvider ?? "edge";
  const voiceName = options.voiceName ?? process.env.TTS_VOICE_NAME ?? "vi-VN-HoaiMyNeural";
  const voiceSpeed = options.voiceSpeed ?? Number(process.env.TTS_SPEED ?? 1);
  const targetDurationSec = options.targetDurationSec && options.targetDurationSec > 0 ? options.targetDurationSec : 120;
  const aiProvider = options.aiProvider ?? "gemini";
  // Long requests (many minutes of narration -> many scenes) need headroom in
  // the JSON response so the model isn't silently cut off mid-script. The
  // ceiling is provider-specific: OpenAI's gpt-4o-mini hard-rejects
  // completions above 16384 max_tokens, while Gemini 2.5 Flash supports a
  // much larger output window — capping both at the lower number would make
  // very long (25-30 min) scripts truncate on Gemini too, for no reason.
  const tokensPerSecond = 40;
  const maxOutputTokens = aiProvider === "openai"
    ? Math.min(16000, Math.max(4096, Math.round(targetDurationSec * tokensPerSecond)))
    : Math.min(60000, Math.max(4096, Math.round(targetDurationSec * tokensPerSecond)));
  const mode = options.mode ?? "content";
  const platform = options.platform ?? "generic";
  const durationMode = options.durationMode ?? "fixed";
  const secondVoice = options.secondVoiceProvider && options.secondVoiceName
    ? { provider: options.secondVoiceProvider, name: options.secondVoiceName }
    : undefined;

  const built = buildPrompt(prompt, channel, voiceProvider, voiceName, voiceSpeed, targetDurationSec, options.productFacts, mode, platform, durationMode, secondVoice);

  // Gemini 2.5 Flash occasionally drops a required field (seen: templateId
  // missing on every scene) on an otherwise-fine response — confirmed by
  // hand that re-running the IDENTICAL prompt succeeds most of the time, so
  // this is model-call noise, not a prompt defect. A plain retry (same
  // prompt, unmodified) recovers far more reliably than trying to word-tweak
  // the prompt around it — that was tried and made things worse (asking the
  // model to "fix" its answer caused it to drop the field on purpose).
  let script: TemplateScript | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const responseText = aiProvider === "openai"
        ? await callOpenAI(built.text, options.model ?? DEFAULT_OPENAI_MODEL, maxOutputTokens)
        : await callGemini(built.text, options.model ?? DEFAULT_MODEL, maxOutputTokens);
      const raw = normalizeGeneratedScript(extractJson(responseText));
      script = GeneratedScriptSchema.parse(raw);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!script) throw lastError;

  // Force the authoritative voice selection rather than trusting the model's
  // echo of it — it's asked to copy these fields verbatim into the JSON, but
  // nothing should depend on that being exact. Scenes without a valid
  // "speaker" (single-voice mode, or the model omitting it) default to "A"
  // via the schema.
  script.voice = { provider: voiceProvider, name: voiceName, speed: voiceSpeed };
  script.voice2 = secondVoice ? { ...secondVoice, speed: voiceSpeed } : null;
  if (!secondVoice) {
    script.scenes = script.scenes.map((scene) => ({ ...scene, speaker: "A" }));
  }

  // Affiliate mode is a short ad — a model that ignores the word-count
  // ceiling doesn't just run a bit long, it produces a 70s+ video where the
  // plan calls for 15-45s. Observed in practice (Gemini 2.5 Flash: asked for
  // 64-86 words, returned 257 — nearly 3x over — despite an explicit "HARD
  // REQUIREMENT" in the prompt). Asking the model to retry proved unreliable
  // in testing (it dropped required templateId fields when told to redo the
  // whole thing), so this trims the already schema-valid scenes directly
  // instead of re-prompting: deterministic and can't break the JSON shape.
  if (mode === "affiliate") {
    script = trimScriptToWordBudget(script, built.maxWords);
  }
  const outputDir = join(
    options.outputRoot ?? "output",
    `${toSlug(script.metadata.title || prompt)}-${timestampForPath()}`,
  );
  const scriptPath = join(outputDir, "script.json");

  await mkdir(outputDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script, null, 2), "utf8");

  return { script, outputDir, scriptPath };
}

export interface ProductFactSheet {
  /** 3-6 short, concrete benefit/feature bullets — grounded only in the raw
   *  info given, never invented. */
  features: string[];
  targetAudience: string;
  usage: string;
  /** Claims the raw info implies but doesn't state outright (e.g. a specific
   *  result, %, or timeframe) — surfaced for human review, not silently kept. */
  uncertainClaims: string[];
}

const ProductFactSheetSchema = z.object({
  features: z.array(z.string().min(1)).min(1).max(8),
  targetAudience: z.string().min(1),
  usage: z.string().min(1),
  uncertainClaims: z.array(z.string()).default([]),
});

function buildFactSheetPrompt(rawInfo: {
  productName: string;
  shopName?: string | null;
  priceReference?: string | null;
  keyPoints?: string | null;
  category?: string | null;
}): string {
  return `
Bạn là chuyên gia phân tích sản phẩm cho video affiliate. Dựa CHỈ vào thông tin thô dưới đây (không được tra cứu, không được suy đoán thêm thông số/kết quả không có trong dữ liệu), hãy tổng hợp thành Product Fact Sheet.

Thông tin thô:
- Tên sản phẩm: ${rawInfo.productName}
${rawInfo.shopName ? `- Shop: ${rawInfo.shopName}` : ""}
${rawInfo.priceReference ? `- Giá tham khảo: ${rawInfo.priceReference}` : ""}
${rawInfo.category ? `- Danh mục: ${rawInfo.category}` : ""}
${rawInfo.keyPoints ? `- Điểm nổi bật do người bán/người dùng cung cấp: ${rawInfo.keyPoints}` : "- (Không có điểm nổi bật nào được cung cấp — chỉ dựa vào tên sản phẩm và danh mục.)"}

Trả về JSON đúng cấu trúc:
{
  "features": ["3-6 gạch đầu dòng công dụng/đặc điểm nổi bật, mỗi ý 1 câu ngắn, tiếng Việt, CHỈ dựa vào thông tin thô ở trên"],
  "targetAudience": "1 câu mô tả đối tượng phù hợp dùng sản phẩm này",
  "usage": "1-2 câu hướng dẫn cách dùng cơ bản, chỉ nếu suy ra được hợp lý từ thông tin thô, nếu không đủ dữ kiện thì ghi 'Không đủ thông tin để mô tả cách dùng'",
  "uncertainClaims": ["Liệt kê MỌI con số/kết quả/thời gian cụ thể (%, ngày, mm, hiệu quả...) xuất hiện trong điểm nổi bật thô — để người dùng tự xác nhận trước khi dùng trong video. Để mảng rỗng [] nếu điểm nổi bật không có con số cụ thể nào."]
}
Không thêm trường nào khác. Không bịa thêm thông số ngoài danh sách trên.`;
}

/** AI-assisted Product Fact Sheet (plan section A2/A3): turns the raw fields
 *  a user typed into "Kho sản phẩm" into a structured sheet with uncertain
 *  claims flagged for human approval, instead of the script generator reading
 *  raw free-text key_points directly. Always throws on failure — callers
 *  decide what "fact sheet generation failed" should mean for their UI,
 *  unlike generateScriptFromPrompt which has a local-fallback story. */
export async function generateProductFactSheet(
  rawInfo: {
    productName: string;
    shopName?: string | null;
    priceReference?: string | null;
    keyPoints?: string | null;
    category?: string | null;
  },
  aiProvider: "gemini" | "openai" = "gemini",
): Promise<ProductFactSheet> {
  const promptText = buildFactSheetPrompt(rawInfo);
  const responseText = aiProvider === "openai"
    ? await callOpenAI(promptText, DEFAULT_OPENAI_MODEL, 2048)
    : await callGemini(promptText, DEFAULT_MODEL, 2048);
  const raw = extractJson(responseText);
  return ProductFactSheetSchema.parse(raw);
}

/** The 6 angles from the plan's AI Concept Wizard (A5) — a fixed vocabulary
 *  so the UI can show a stable icon/label per angle regardless of which ones
 *  the model picks for a given product. */
export const CONCEPT_ANGLES = ["problem-solution", "quick-review", "top-benefits", "demo", "pov", "intro"] as const;
export type ConceptAngle = (typeof CONCEPT_ANGLES)[number];

export interface ProductConcept {
  angle: ConceptAngle;
  title: string;
  /** 1-2 sentence pitch shown to the user so they can pick a concept without
   *  having to read a full script first. */
  description: string;
  /** Ready to hand straight to generateScriptFromPrompt as userRequest —
   *  already product-first and fact-sheet-grounded, just needs the concept's
   *  specific angle applied. */
  scriptPrompt: string;
}

const ProductConceptSchema = z.object({
  angle: z.enum(CONCEPT_ANGLES),
  title: z.string().min(1),
  description: z.string().min(1),
  scriptPrompt: z.string().min(1),
});
const ProductConceptsSchema = z.object({ concepts: z.array(ProductConceptSchema).min(3).max(5) });

function buildConceptsPrompt(productName: string, factsBlock: string): string {
  return `
Bạn là chuyên gia content affiliate. Dựa vào thông tin sản phẩm THẬT dưới đây, đề xuất 3 đến 5 concept video khác nhau cho cùng 1 sản phẩm, mỗi concept theo 1 góc độ riêng trong danh sách góc độ cho phép.

Thông tin sản phẩm THẬT (không được bịa thêm ngoài đây):
${factsBlock}

Góc độ cho phép (chỉ dùng đúng các giá trị này cho trường "angle", chọn 3-5 góc phù hợp nhất với sản phẩm này, không cần dùng hết cả 6):
- "problem-solution": mở đầu bằng vấn đề người xem hay gặp, sản phẩm là giải pháp.
- "quick-review": giọng review nhanh, khách quan, có điểm hay và 1 lưu ý thật.
- "top-benefits": liệt kê nhanh các lợi ích nổi bật nhất theo kiểu đếm số.
- "demo": tập trung mô tả cách dùng/thao tác thực tế của sản phẩm.
- "pov": góc nhìn tình huống đời thường dẫn tới nhu cầu dùng sản phẩm (không phải trải nghiệm cá nhân người kể — chỉ là bối cảnh/tình huống chung).
- "intro": giới thiệu trực tiếp, ngắn gọn, đi thẳng vào sản phẩm và lợi ích chính.

Với mỗi concept, trả về:
{
  "angle": "một trong 6 giá trị trên",
  "title": "tên ngắn gọn cho concept, tiếng Việt, dưới 8 từ",
  "description": "1-2 câu mô tả concept này sẽ triển khai video ra sao, để người dùng chọn concept mà không cần đọc script đầy đủ",
  "scriptPrompt": "1 đoạn chỉ dẫn chi tiết bằng tiếng Việt, sẵn sàng đưa thẳng cho AI viết kịch bản: mở đầu thế nào theo đúng góc độ này, nêu ý gì, kết bằng lời mời xem thêm thông tin/giá ở link mô tả — không được nhắc giá cụ thể, không viết như thể người kể đã tự dùng sản phẩm"
}

Trả về JSON: { "concepts": [ ...3 đến 5 object như trên... ] }
Không thêm trường nào khác.`;
}

/** AI Concept Wizard (plan section A5): given one product's real facts,
 *  proposes 3-5 different video angles for the user to pick from before any
 *  script gets written — a product with several concepts can become several
 *  different videos instead of always the same generic pitch. */
export async function generateProductConcepts(
  productName: string,
  factsBlock: string,
  aiProvider: "gemini" | "openai" = "gemini",
): Promise<ProductConcept[]> {
  const promptText = buildConceptsPrompt(productName, factsBlock);
  const responseText = aiProvider === "openai"
    ? await callOpenAI(promptText, DEFAULT_OPENAI_MODEL, 3072)
    : await callGemini(promptText, DEFAULT_MODEL, 3072);
  const raw = extractJson(responseText);
  const parsed = ProductConceptsSchema.parse(raw);
  return parsed.concepts;
}

async function main() {
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt) {
    console.error('Usage: npm run generate -- "review phim Kung Fu Panda 3"');
    process.exit(1);
  }

  try {
    const result = await generateScriptFromPrompt(prompt);
    console.log(`Created: ${result.scriptPath}`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Generated JSON did not match the video script schema:");
      console.error(error.issues);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
