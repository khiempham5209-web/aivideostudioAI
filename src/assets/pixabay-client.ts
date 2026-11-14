import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Free-license stock media (Pixabay — no attribution required, personal or
 * commercial use OK) — second-choice source tried when Pexels has no match
 * for a scene's derived query, before falling back to the AI-drawn template.
 * Mirrors pexels-client.ts's shape/contract (never throws, returns null on
 * any failure so a missed match just falls through to the next source).
 */

const PIXABAY_VIDEO_SEARCH = "https://pixabay.com/api/videos/";
const PIXABAY_PHOTO_SEARCH = "https://pixabay.com/api/";

export type PixabayMediaType = "video" | "image";

export interface PixabayFetchResult {
  path: string;
  type: PixabayMediaType;
}

function apiKey(): string | undefined {
  return process.env.PIXABAY_API_KEY?.trim() || undefined;
}

export function isPixabayConfigured(): boolean {
  return Boolean(apiKey());
}

interface PixabayVideoFile {
  url: string;
  width: number;
  height: number;
}

interface PixabayVideoHit {
  videos: { large: PixabayVideoFile; medium: PixabayVideoFile; small: PixabayVideoFile; tiny: PixabayVideoFile };
}

async function searchPixabayVideo(query: string): Promise<string | undefined> {
  const key = apiKey();
  if (!key) return undefined;
  const url = `${PIXABAY_VIDEO_SEARCH}?key=${key}&q=${encodeURIComponent(query)}&per_page=5&safesearch=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { hits?: PixabayVideoHit[] };
  const hit = data.hits?.[0];
  if (!hit) return undefined;
  // Prefer a mid-size (~medium/large) file — Pixabay's "large" is often
  // already HD, and there's no benefit downloading bigger for a short
  // scene clip that gets re-encoded down anyway.
  const candidates = [hit.videos.large, hit.videos.medium, hit.videos.small, hit.videos.tiny].filter(Boolean);
  const preferred = candidates.find((f) => f.height >= 480 && f.height <= 1080) ?? candidates[0];
  return preferred?.url;
}

interface PixabayPhotoHit {
  largeImageURL: string;
}

async function searchPixabayPhoto(query: string): Promise<string | undefined> {
  const key = apiKey();
  if (!key) return undefined;
  const url = `${PIXABAY_PHOTO_SEARCH}?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&per_page=5&safesearch=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { hits?: PixabayPhotoHit[] };
  return data.hits?.[0]?.largeImageURL;
}

async function downloadTo(url: string, targetPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Pixabay download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(targetPath, buffer);
}

/**
 * Fetches one stock clip/photo for `query`, downloads it to `cacheDir`, and
 * returns its local path + type. Caches by (query, aspect) — a separate
 * cache directory from Pexels' since the same query text could otherwise
 * collide on filename between the two sources. Returns null if Pixabay
 * isn't configured or has no match — callers should try the next source
 * (or fall back to the AI-drawn template) in that case.
 */
export async function fetchPixabayMedia(
  query: string,
  aspect: "9:16" | "16:9" | "1:1",
  cacheDir: string,
): Promise<PixabayFetchResult | null> {
  if (!isPixabayConfigured() || !query.trim()) return null;

  const safeName = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "scene";
  const cachedVideo = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.mp4`);
  if (existsSync(cachedVideo)) return { path: cachedVideo, type: "video" };
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const cachedPhoto = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.${ext}`);
    if (existsSync(cachedPhoto)) return { path: cachedPhoto, type: "image" };
  }

  try {
    const videoUrl = await searchPixabayVideo(query);
    if (videoUrl) {
      await downloadTo(videoUrl, cachedVideo);
      return { path: cachedVideo, type: "video" };
    }
    const photoUrl = await searchPixabayPhoto(query);
    if (photoUrl) {
      const ext = photoUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)?.[1]?.toLowerCase() || "jpg";
      const path = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.${ext}`);
      await downloadTo(photoUrl, path);
      return { path, type: "image" };
    }
  } catch (error) {
    console.warn(`Pixabay fetch failed for "${query}": ${error instanceof Error ? error.message : error}`);
  }
  return null;
}
