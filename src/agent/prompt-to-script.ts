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

const CHANNEL_NAME = process.env.CHANNEL_NAME ?? "Khiempham AI";
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

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
  voiceProvider?: "edge" | "omnivoice" | "piper";
  voiceName?: string;
  voiceSpeed?: number;
  /** Target spoken duration in seconds — shapes requested word count and scene count. */
  targetDurationSec?: number;
  /** Which AI writes the script. Defaults to Gemini. */
  aiProvider?: "gemini" | "openai";
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

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // With responseMimeType "application/json" this should already be pure JSON;
  // try it directly first before falling back to a lenient substring extraction.
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Gemini did not return a JSON object");
  }

  return JSON.parse(cleaned.slice(first, last + 1));
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
  voiceProvider: "edge" | "omnivoice" | "piper",
  voiceName: string,
  voiceSpeed: number,
  targetDurationSec: number,
): string {
  // Vietnamese TTS at normal speed reads roughly 2.4-2.6 words/sec.
  const targetWords = Math.round(targetDurationSec * 2.5);
  const minWords = Math.max(60, Math.round(targetWords * 0.85));
  const maxWords = Math.round(targetWords * 1.15);
  // Sized to cover the full duration range the UI allows (up to 1800s/30min
  // -> ~130 scenes at ~14s/scene) rather than an arbitrary lower ceiling.
  const sceneCount = Math.min(150, Math.max(3, Math.round(targetDurationSec / 14)));
  const minScenes = Math.max(3, sceneCount - 2);
  const maxScenes = Math.min(155, sceneCount + 2);
  return `
You create Vietnamese short review videos as JSON for an existing renderer.

User request:
${userRequest}

Return ONLY valid JSON matching this exact structure:
{
  "version": "1.0",
  "renderer": "hyperframes",
  "metadata": {
    "title": "...",
    "source": { "url": "local://user-request", "domain": "local", "image": null },
    "channel": "${channel}"
  },
  "voice": { "provider": "${voiceProvider}", "name": "${voiceName}", "speed": ${voiceSpeed} },
  "aspect": "9:16",
  "scenes": []
}

Scene rules:
- Create ${minScenes} to ${maxScenes} scenes total: first scene type "hook", last scene type "outro", the rest type "body".
- HARD REQUIREMENT: the sum of all scene.voiceText combined must be ${minWords} to ${maxWords} Vietnamese words — this is not a suggestion. Count as you write. A script that is shorter than ${minWords} words is a FAILED response, even if the topic feels "covered" — it is not a valid answer.
- If the topic alone does not naturally have enough content, you MUST expand it yourself: add more concrete steps/details, examples, comparisons, tips, background context, or elaboration on each point, so the total reaches the required word count. Do not simply repeat the same idea in different words — add genuinely new, useful sub-points.
- Each scene.voiceText must be a plain Vietnamese string, 2 to 4 sentences (longer per-scene text is expected for longer videos), no emoji, no URL, no markdown.
- This is a review/commentary video. Do not recreate copyrighted dialogue, do not provide a scene-by-scene substitute for watching the movie, and keep the tone transformative: summary, opinion, themes, strengths, weaknesses, verdict.
- If the user asks to review a film, cover: hook, premise, main conflict, character arc, highlights, weak points, message, verdict.
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
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

async function callGemini(promptText: string, model: string, maxOutputTokens: number): Promise<string> {
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
    config: { maxOutputTokens, responseMimeType: "application/json" },
  });
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
  const promptText = buildPrompt(prompt, channel, voiceProvider, voiceName, voiceSpeed, targetDurationSec);
  const responseText = aiProvider === "openai"
    ? await callOpenAI(promptText, options.model ?? DEFAULT_OPENAI_MODEL, maxOutputTokens)
    : await callGemini(promptText, options.model ?? DEFAULT_MODEL, maxOutputTokens);

  const raw = normalizeGeneratedScript(extractJson(responseText));
  const script = GeneratedScriptSchema.parse(raw);
  const outputDir = join(
    options.outputRoot ?? "output",
    `${toSlug(script.metadata.title || prompt)}-${timestampForPath()}`,
  );
  const scriptPath = join(outputDir, "script.json");

  await mkdir(outputDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script, null, 2), "utf8");

  return { script, outputDir, scriptPath };
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
