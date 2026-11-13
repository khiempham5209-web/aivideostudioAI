import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import type { GenerateVideosOperation } from "@google/genai";

// Veo 3.1 GA model id (Gemini API). veo-3.0-generate-001 is past its
// retirement window and veo-3.1-generate-preview was discontinued
// 2026-04-02 — veo-3.1-generate-001 is the current stable GA endpoint.
// Check https://ai.google.dev/gemini-api/docs/models before changing this.
export const VEO_MODEL = "veo-3.1-generate-001";

export interface VeoReferenceImage {
  /** Raw image bytes (e.g. a PNG/JPEG read from disk). */
  bytes: Buffer;
  mimeType: string;
}

export interface StartVeoGenerationOptions {
  prompt: string;
  referenceImage?: VeoReferenceImage;
  aspectRatio?: "9:16" | "16:9" | "1:1";
  durationSeconds?: number;
  /** Mute by default — the app's own TTS supplies the real voice track
   *  separately and mixes it onto this clip afterward (see the AI Prompt
   *  page's AUDIO block, which always asks Veo for an ambient/no-dialogue
   *  clip unless "Khớp môi" is explicitly chosen). */
  generateAudio?: boolean;
}

function requireClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY — không gọi được Veo3.");
  return new GoogleGenAI({ apiKey });
}

/** Kicks off a Veo3 generation and returns immediately with the
 *  long-running operation's name — the actual video is not ready yet.
 *  Persist the returned name (VideoGenJobRecord.operation_name) and poll
 *  it later with pollVeoOperation(), since the SDK's own Operation object
 *  cannot be kept across separate HTTP requests. */
export async function startVeoGeneration(opts: StartVeoGenerationOptions): Promise<{ operationName: string; done: boolean }> {
  const ai = requireClient();
  const operation = await ai.models.generateVideos({
    model: VEO_MODEL,
    prompt: opts.prompt,
    config: {
      aspectRatio: opts.aspectRatio ?? "9:16",
      durationSeconds: opts.durationSeconds ?? 8,
      generateAudio: opts.generateAudio ?? false,
      personGeneration: "allow_adult",
      referenceImages: opts.referenceImage
        ? [{
            image: { imageBytes: opts.referenceImage.bytes.toString("base64"), mimeType: opts.referenceImage.mimeType },
            referenceType: VideoGenerationReferenceType.ASSET,
          }]
        : undefined,
    },
  });
  if (!operation.name) throw new Error("Veo3 không trả về operation name — không poll được kết quả.");
  return { operationName: operation.name, done: operation.done ?? false };
}

export interface VeoPollResult {
  done: boolean;
  /** Set once done === true and generation succeeded. */
  videoUri?: string;
  videoBytes?: Buffer;
  /** Set once done === true if generation failed (RAI filter, quota, etc.) */
  errorMessage?: string;
}

/** Polls an in-flight Veo3 operation by name. Call repeatedly (e.g. every
 *  10s from a frontend poll loop) until result.done === true. */
export async function pollVeoOperation(operationName: string): Promise<VeoPollResult> {
  const ai = requireClient();
  // The SDK's getVideosOperation() only reads `.name` off the operation it
  // is given back (confirmed from @google/genai's own type definitions) —
  // a plain {name} stand-in is enough to resume polling from a fresh
  // request/process, we don't need the original in-memory Operation object.
  const stub = { name: operationName } as GenerateVideosOperation;
  const operation = await ai.operations.getVideosOperation({ operation: stub });
  if (!operation.done) return { done: false };
  if (operation.error) {
    return { done: true, errorMessage: JSON.stringify(operation.error).slice(0, 500) };
  }
  const generated = operation.response?.generatedVideos?.[0];
  if (!generated?.video) {
    const raiReason = operation.response?.raiMediaFilteredReasons?.[0];
    return { done: true, errorMessage: raiReason ? `Bị lọc nội dung: ${raiReason}` : "Veo3 không trả về video nào." };
  }
  if (generated.video.videoBytes) {
    return { done: true, videoBytes: Buffer.from(generated.video.videoBytes, "base64") };
  }
  if (generated.video.uri) {
    return { done: true, videoUri: generated.video.uri };
  }
  return { done: true, errorMessage: "Video trả về không có dữ liệu (không uri, không bytes)." };
}

/** Downloads a ready (operation.done === true) video's bytes to a local
 *  file path. Only call this after pollVeoOperation() returned done with
 *  a videoUri — if it already returned videoBytes, just write those. */
export async function downloadVeoVideoFromUri(videoUri: string, destPath: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  // Veo file URIs need the API key as a query param/header to fetch —
  // the SDK's ai.files.download() expects a File/GeneratedVideo object,
  // not a bare URI string in every version, so fetch directly instead
  // for a URI we already have.
  const sep = videoUri.includes("?") ? "&" : "?";
  const resp = await fetch(`${videoUri}${sep}key=${encodeURIComponent(apiKey)}`);
  if (!resp.ok) throw new Error(`Tải video Veo3 thất bại: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destPath, buffer);
}
