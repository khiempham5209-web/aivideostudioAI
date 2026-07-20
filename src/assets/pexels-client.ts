import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Free-license stock media (Pexels — no attribution required, personal or
 * commercial use OK) for scenes with no manually assigned footage/image and
 * no local footage folder. Prefers real video clips over stills; a still
 * still gets the Ken Burns treatment downstream (see template-pipeline.ts).
 */

const PEXELS_VIDEO_SEARCH = "https://api.pexels.com/videos/search";
const PEXELS_PHOTO_SEARCH = "https://api.pexels.com/v1/search";

export type PexelsMediaType = "video" | "image";

export interface PexelsFetchResult {
  path: string;
  type: PexelsMediaType;
}

function orientationFor(aspect: "9:16" | "16:9" | "1:1"): "portrait" | "landscape" | "square" {
  if (aspect === "16:9") return "landscape";
  if (aspect === "1:1") return "square";
  return "portrait";
}

function apiKey(): string | undefined {
  return process.env.PEXELS_API_KEY?.trim() || undefined;
}

export function isPexelsConfigured(): boolean {
  return Boolean(apiKey());
}

interface PexelsVideoFile {
  link: string;
  quality: string;
  width: number;
  height: number;
  file_type: string;
}

interface PexelsVideoItem {
  video_files: PexelsVideoFile[];
}

async function searchPexelsVideo(query: string, aspect: "9:16" | "16:9" | "1:1"): Promise<string | undefined> {
  const key = apiKey();
  if (!key) return undefined;
  const url = `${PEXELS_VIDEO_SEARCH}?query=${encodeURIComponent(query)}&orientation=${orientationFor(aspect)}&per_page=5`;
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { videos?: PexelsVideoItem[] };
  const video = data.videos?.[0];
  if (!video) return undefined;
  // Prefer an HD-ish mp4 file, not the largest 4K (slower to download, no
  // visual benefit once re-encoded down for a short vertical scene clip).
  const mp4Files = video.video_files.filter((f) => f.file_type === "video/mp4");
  const preferred =
    mp4Files.find((f) => f.height >= 720 && f.height <= 1080) ??
    mp4Files.sort((a, b) => b.height - a.height)[0];
  return preferred?.link;
}

interface PexelsPhotoItem {
  src: { large2x: string; large: string; original: string };
}

async function searchPexelsPhoto(query: string, aspect: "9:16" | "16:9" | "1:1"): Promise<string | undefined> {
  const key = apiKey();
  if (!key) return undefined;
  const url = `${PEXELS_PHOTO_SEARCH}?query=${encodeURIComponent(query)}&orientation=${orientationFor(aspect)}&per_page=5`;
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { photos?: PexelsPhotoItem[] };
  const photo = data.photos?.[0];
  return photo?.src.large2x ?? photo?.src.large ?? photo?.src.original;
}

async function downloadTo(url: string, targetPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Pexels download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(targetPath, buffer);
}

/**
 * Fetches one stock clip/photo for `query`, downloads it to `cacheDir`, and
 * returns its local path + type. Caches by (query, aspect) so the same
 * scene keyword across re-renders/retries doesn't re-hit the API or
 * re-download. Returns null if Pexels isn't configured or has no match —
 * callers should fall back to the AI-drawn template in that case.
 */
export async function fetchPexelsMedia(
  query: string,
  aspect: "9:16" | "16:9" | "1:1",
  cacheDir: string,
): Promise<PexelsFetchResult | null> {
  if (!isPexelsConfigured() || !query.trim()) return null;

  const safeName = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "scene";
  const cachedVideo = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.mp4`);
  if (existsSync(cachedVideo)) return { path: cachedVideo, type: "video" };
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const cachedPhoto = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.${ext}`);
    if (existsSync(cachedPhoto)) return { path: cachedPhoto, type: "image" };
  }

  try {
    const videoUrl = await searchPexelsVideo(query, aspect);
    if (videoUrl) {
      await downloadTo(videoUrl, cachedVideo);
      return { path: cachedVideo, type: "video" };
    }
    const photoUrl = await searchPexelsPhoto(query, aspect);
    if (photoUrl) {
      const ext = photoUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)?.[1]?.toLowerCase() || "jpg";
      const path = join(cacheDir, `${safeName}-${aspect.replace(":", "x")}.${ext}`);
      await downloadTo(photoUrl, path);
      return { path, type: "image" };
    }
  } catch (error) {
    console.warn(`Pexels fetch failed for "${query}": ${error instanceof Error ? error.message : error}`);
  }
  return null;
}
