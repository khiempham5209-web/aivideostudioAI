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
  voiceProvider?: "edge" | "omnivoice" | "piper" | "supertonic";
  voiceName?: string;
  voiceSpeed?: number;
  /** Target spoken duration in seconds — shapes requested word count and scene count. */
  targetDurationSec?: number;
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
): string {
  // Affiliate product videos are short-form ads, not long-form content — cap
  // the effective duration regardless of what the project's duration dial
  // was set to (that dial is shared with AI Content mode, which allows up to
  // 30 minutes). This mirrors the plan's explicit rule: "Script 15-45 giây,
  // product-first" — a mandatory constraint of affiliate mode, not a default.
  const effectiveDurationSec = mode === "affiliate"
    ? Math.min(45, Math.max(15, targetDurationSec))
    : targetDurationSec;
  // Vietnamese TTS at normal speed reads roughly 2.4-2.6 words/sec.
  const targetWords = Math.round(effectiveDurationSec * 2.5);
  const minWords = Math.max(60, Math.round(targetWords * 0.85));
  const maxWords = Math.round(targetWords * 1.15);
  // Sized to cover the full duration range the UI allows (up to 1800s/30min
  // -> ~130 scenes at ~14s/scene) rather than an arbitrary lower ceiling.
  const sceneCount = Math.min(150, Math.max(3, Math.round(effectiveDurationSec / 14)));
  const minScenes = Math.max(3, sceneCount - 2);
  const maxScenes = Math.min(155, sceneCount + 2);
  // Plan section 7's rule engine: CTA wording is platform-specific, everything
  // else about the ad is the same regardless of where it's posted.
  const platformCta = platform === "tiktok_shop"
    ? `end on a call-to-action inviting the viewer to check the product pinned/linked below the video (e.g. "xem sản phẩm được gắn bên dưới video này") — do not mention Shopee or any other platform by name`
    : platform === "shopee_aff"
      ? `end on a call-to-action inviting the viewer to check the current price on Shopee via the link in the description/bio (e.g. "xem giá trên Shopee ở link trong mô tả") — do not mention TikTok or any other platform by name`
      : `end on a call-to-action inviting the viewer to check the product info via the link in the video description`;
  const modeRules = mode === "affiliate" ? `
- This is an AFFILIATE PRODUCT AD, not a review/commentary video. Every scene must sell the product itself — no film/topic commentary framing.
- Product-first: the hook scene must open on the product and the problem it solves, not on a generic story intro.
- NEVER write or imply that the narrator personally used, tried, or tested the product ("mình đã dùng", "sau khi trải nghiệm", "mình thấy da mình..."). Speak about the product's stated facts/benefits in third person instead ("sản phẩm này...", "công dụng chính là...").
- Do NOT invent specs, results, or benefits beyond what is listed in "Thông tin sản phẩm THẬT" below. If a claim isn't in that list, don't make it.
- HARD RULE: never state a price, a discount amount, or any number of đồng/VNĐ in ANY scene's voiceText, not even in the outro — prices change and a wrong spoken price is a real compliance risk. The reference price in "Thông tin sản phẩm THẬT" is context for you only, never to be spoken. Invite the viewer to check the current price via the link/description instead (e.g. "xem giá hiện tại ở phần mô tả").
- The last scene (outro) must ${platformCta} — do not say "mua ngay" as a command; invite them to look, not order.
- Keep pacing punchy and short — this is a 15-45 second ad, not a documentary. Every sentence should either state a benefit or move toward the CTA.` : `
- This is a review/commentary video. Do not recreate copyrighted dialogue, do not provide a scene-by-scene substitute for watching the movie, and keep the tone transformative: summary, opinion, themes, strengths, weaknesses, verdict.
- If the user asks to review a film, cover: hook, premise, main conflict, character arc, highlights, weak points, message, verdict.`;
  return `
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
  "voice": { "provider": "${voiceProvider}", "name": "${voiceName}", "speed": ${voiceSpeed} },
  "aspect": "9:16",
  "scenes": []
}

Scene rules:
- Create ${minScenes} to ${maxScenes} scenes total: first scene type "hook", last scene type "outro", the rest type "body".
- HARD REQUIREMENT: the sum of all scene.voiceText combined must be ${minWords} to ${maxWords} Vietnamese words — this is not a suggestion. Count as you write. A script that is shorter than ${minWords} words is a FAILED response, even if the topic feels "covered" — it is not a valid answer.
- If the topic alone does not naturally have enough content, you MUST expand it yourself: add more concrete steps/details, examples, comparisons, tips, background context, or elaboration on each point, so the total reaches the required word count. Do not simply repeat the same idea in different words — add genuinely new, useful sub-points.
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
  const promptText = buildPrompt(prompt, channel, voiceProvider, voiceName, voiceSpeed, targetDurationSec, options.productFacts, options.mode ?? "content", options.platform ?? "generic");
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
