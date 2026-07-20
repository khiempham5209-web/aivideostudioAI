import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import dotenv from "dotenv";
import { generateScriptFromPrompt } from "./agent/prompt-to-script.js";
import { runTemplatePipeline } from "./render/template-pipeline.js";
import { renderProjectTimeline } from "./render/timeline-renderer.js";
import { findVoiceOption, VOICE_OPTIONS } from "./tts/voice-catalog.js";
import { createTtsClient } from "./tts/tts-client.js";
import { loadConfig } from "./config.js";
import { toSlug } from "./utils/slug.js";
import { FFMPEG_BIN } from "./utils/binaries.js";
import { getDurationSec } from "./assets/audio-tools.js";
import { deleteR2Object, downloadR2ToFile, isR2Configured, signedR2UploadUrl, signedR2Url, uploadFileToR2 } from "./cloud/r2-storage.js";
import {
  createProject,
  createSession,
  addProjectScene,
  addTrack,
  createAsset,
  createClip,
  createRenderJob,
  deleteClip,
  deleteSession,
  deleteAsset,
  deleteScene,
  deleteTrack,
  getAsset,
  getUserSettings,
  getSession,
  getClip,
  getScene,
  getTrack,
  getLatestJobForProject,
  getProject,
  getStats,
  getPgWriteHealth,
  getUser,
  getUserProject,
  getRenderJob,
  isUserFile,
  listUserStoragePaths,
  listClips,
  listProjects,
  listAssets,
  listRenderJobsForOwner,
  listScenes,
  listTracks,
  moveScene,
  replaceProjectScenes,
  splitClip,
  updateClip,
  updateScene,
  updateProject,
  updateRenderJob,
  updateTrack,
  updateUserSettings,
  upsertUser,
  type TimelineTrackType,
} from "./storage/db.js";

dotenv.config({ path: ".env.local" });

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const PUBLIC_DIR = resolve("public");
const STORAGE_DIR = resolve("storage", "projects");
const OUTPUT_DIR = resolve("output");
const SESSION_COOKIE = "avs_session";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? `http://127.0.0.1:${PORT}/api/auth/google/callback`;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL?.replace(/\/+$/, "") ?? "";
const STORAGE_QUOTA_BYTES = Number(process.env.STORAGE_QUOTA_BYTES ?? 50 * 1024 * 1024 * 1024);
const APP_ENV = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
const IS_PRODUCTION = APP_ENV === "production";
// Fixed, not env-driven: this is always where the real deployed backend
// lives — the desktop build's self-update check compares against this,
// not against APP_PUBLIC_URL (which is self-referential per environment).
const PRODUCTION_BACKEND_URL = "https://aivideostudioaibackend.onrender.com";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const TEMPLATE_PRESETS = [
  { id: "review-film", name: "Review phim", style: "Review phim", description: "Hook, tom tat, diem hay, diem yeu va ket luan co dang xem khong." },
  { id: "sales-short", name: "Ban hang ngan", style: "Quang cao san pham", description: "Neu van de, loi ich, bang chung va CTA." },
  { id: "news-fast", name: "Tin tuc nhanh", style: "Tin tuc", description: "Headline, boi canh, du kien chinh va ket luan." },
  { id: "top-list", name: "Top list", style: "Top 5", description: "Countdown, ly do tung muc va ket luan nhanh." },
  { id: "knowledge", name: "Kien thuc", style: "Giai thich", description: "Mo van de, vi du, phan tich va tong ket." },
  { id: "story-drama", name: "Drama ke chuyen", style: "Ke chuyen kich tinh", description: "Hook to mo, cao trao, twist va thong diep." },
];

interface CreateVideoBody {
  prompt?: string;
  projectName?: string;
  render?: boolean;
  voiceId?: string;
  voiceName?: string;
  voiceSpeed?: number;
  folderName?: string;
  ratio?: string;
  durationSec?: number;
}

interface AuthUser {
  email: string;
  name: string;
  picture: string | null;
}

function isAllowedEmail(email: string): boolean {
  if (ALLOWED_EMAILS.length === 0) return !IS_PRODUCTION;
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}

function signOAuthState(payload: string): string {
  return createHmac("sha256", GOOGLE_CLIENT_SECRET).update(payload).digest("base64url");
}

function createOAuthState(): string {
  const payload = Buffer.from(
    JSON.stringify({
      nonce: randomBytes(16).toString("hex"),
      iat: Date.now(),
    }),
  ).toString("base64url");
  return `${payload}.${signOAuthState(payload)}`;
}

function isValidOAuthState(state: string): boolean {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return false;
  const expected = signOAuthState(payload);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  if (!timingSafeEqual(expectedBuffer, signatureBuffer)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat?: unknown };
    return typeof decoded.iat === "number" && Date.now() - decoded.iat <= 10 * 60 * 1000;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location });
  res.end();
}

function setCookie(res: ServerResponse, name: string, value: string, options = "Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000") {
  appendCookie(res, `${name}=${encodeURIComponent(value)}; ${options}`);
}

function clearCookie(res: ServerResponse, name: string) {
  appendCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function appendCookie(res: ServerResponse, cookie: string) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), cookie]);
    return;
  }
  res.setHeader("Set-Cookie", [String(existing), cookie]);
}

function cookies(req: IncomingMessage) {
  const header = req.headers.cookie ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function currentUser(req: IncomingMessage): AuthUser | null {
  const sessionId = cookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) return null;
  if (!isAllowedEmail(session.email)) return null;
  return { email: session.email, name: session.name, picture: session.picture };
}

function requireUser(req: IncomingMessage, res: ServerResponse): AuthUser | null {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Authentication required", loginUrl: "/api/auth/google/start" });
    return null;
  }
  return user;
}

function sendText(res: ServerResponse, statusCode: number, text: string) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let err = "";
    proc.stderr.on("data", (chunk) => (err += chunk.toString()));
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err}`)));
    proc.on("error", reject);
  });
}

function contentType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".srt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isR2Path(pathname: string) {
  return pathname.startsWith("r2://");
}

function r2Key(ownerEmail: string, projectId: string, category: string, fileName: string) {
  return [
    sanitizeFileName(ownerEmail.replace("@", "_at_")),
    projectId,
    category,
    `${timestampForPath()}-${sanitizeFileName(fileName)}`,
  ].join("/");
}

function isAllowedFilePath(pathname: string, extraRoots: string[] = []): boolean {
  const target = resolve(pathname).toLowerCase();
  const allowedRoots = [resolve("output").toLowerCase(), resolve("storage").toLowerCase(), ...extraRoots.map((root) => resolve(root).toLowerCase())];
  return allowedRoots.some((root) => target === root || target.startsWith(`${root}\\`));
}

async function sendFileByPath(req: IncomingMessage, res: ServerResponse, pathname: string, headOnly = false, extraRoots: string[] = []) {
  const filePath = resolve(pathname);
  if (!isAllowedFilePath(filePath, extraRoots)) {
    sendJson(res, 403, { error: "File path is not allowed" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    const range = req.headers.range;
    const type = contentType(filePath);
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": type,
      "Content-Disposition": `inline; filename="${filePath.split(/[\\/]/).pop() ?? "file"}"`,
      "Cache-Control": "private, max-age=0, no-store",
    };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
      });
      if (headOnly) {
        res.end();
        return;
      }
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Length": info.size,
    });
    if (headOnly) {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

async function folderSize(pathname: string): Promise<number> {
  try {
    const info = await stat(pathname);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    const entries = await readdir(pathname, { withFileTypes: true });
    const sizes = await Promise.all(entries.map((entry) => folderSize(join(pathname, entry.name))));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

function humanBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

async function sendStatic(res: ServerResponse, pathname: string) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (relativePath.includes("..")) {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }

  try {
    const filePath = resolve(PUBLIC_DIR, relativePath);
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<CreateVideoBody> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CreateVideoBody;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function assetType(mimeType: string, fileName: string) {
  const ext = extname(fileName).toLowerCase();
  if (mimeType.startsWith("video/") || [".mp4", ".mov", ".mkv", ".webm"].includes(ext)) return "video" as const;
  if (mimeType.startsWith("audio/") || [".mp3", ".wav", ".m4a", ".aac"].includes(ext)) return "audio" as const;
  if (mimeType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image" as const;
  return "other" as const;
}

function parseMultipart(body: Buffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing multipart boundary");
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const raw = body.toString("binary");
  const parts = raw.split(boundary).slice(1, -1);
  for (const part of parts) {
    const clean = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const [headerText, ...bodyParts] = clean.split("\r\n\r\n");
    const content = bodyParts.join("\r\n\r\n");
    const disposition = headerText.match(/content-disposition:.*name="file".*filename="([^"]+)"/i);
    if (!disposition) continue;
    const mime = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "application/octet-stream";
    return {
      fileName: disposition[1],
      mimeType: mime,
      buffer: Buffer.from(content, "binary"),
    };
  }
  throw new Error("Missing file part");
}

async function handleUploadAsset(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const contentTypeHeader = req.headers["content-type"];
  const contentTypeValue = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  if (!contentTypeValue?.startsWith("multipart/form-data")) {
    sendJson(res, 415, { error: "Expected multipart/form-data" });
    return;
  }
  const body = await readRawBody(req, MAX_UPLOAD_BYTES);
  const file = parseMultipart(body, contentTypeValue);
  const type = assetType(file.mimeType, file.fileName);
  const folder = type === "video" ? "source" : type === "audio" ? "audio" : type === "image" ? "image" : "other";
  const targetDir = resolve(STORAGE_DIR, projectId, folder);
  await mkdir(targetDir, { recursive: true });
  const safeName = `${Date.now()}-${sanitizeFileName(file.fileName)}`;
  const filePath = join(targetDir, safeName);
  await writeFile(filePath, file.buffer);
  const duration = type === "video" || type === "audio" ? await getDurationSec(filePath).catch(() => undefined) : undefined;
  const storedPath = isR2Configured()
    ? await uploadFileToR2(filePath, r2Key(user.email, projectId, folder, file.fileName), file.mimeType)
    : filePath;
  const asset = createAsset({
    projectId,
    type,
    fileName: file.fileName,
    mimeType: file.mimeType,
    filePath: storedPath,
    fileSize: file.buffer.length,
    duration,
  });
  sendJson(res, 201, { ok: true, asset });
}

async function handleCreateDirectAssetUpload(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  if (!isR2Configured()) {
    sendJson(res, 503, { error: "R2 is not configured. Direct upload requires R2 env variables." });
    return;
  }
  const body = await readJsonBody(req) as CreateVideoBody & {
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
  };
  const fileName = sanitizeFileName(String(body.fileName || ""));
  const mimeType = String(body.mimeType || "application/octet-stream");
  const fileSize = Number(body.fileSize || 0);
  if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
    sendJson(res, 400, { error: "fileName and fileSize are required" });
    return;
  }
  const type = assetType(mimeType, fileName);
  const folder = type === "video" ? "source" : type === "audio" ? "audio" : type === "image" ? "image" : "other";
  const objectName = `${Date.now()}-${fileName}`;
  const key = r2Key(user.email, projectId, folder, objectName);
  const upload = await signedR2UploadUrl(key, mimeType, 900);
  sendJson(res, 200, {
    ok: true,
    uploadUrl: upload.uploadUrl,
    filePath: upload.filePath,
    key: upload.key,
    expiresIn: upload.expiresIn,
    asset: {
      type,
      fileName,
      mimeType,
      fileSize,
    },
  });
}

async function handleConfirmDirectAssetUpload(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const body = await readJsonBody(req) as CreateVideoBody & {
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    filePath?: string;
  };
  const fileName = sanitizeFileName(String(body.fileName || ""));
  const mimeType = String(body.mimeType || "application/octet-stream");
  const fileSize = Number(body.fileSize || 0);
  const filePath = String(body.filePath || "");
  if (!fileName || !filePath.startsWith(`r2://${process.env.R2_BUCKET}/`) || !Number.isFinite(fileSize) || fileSize <= 0) {
    sendJson(res, 400, { error: "Invalid direct upload confirmation" });
    return;
  }
  if (!isUserFile(user.email, filePath)) {
    const expectedPrefix = `r2://${process.env.R2_BUCKET}/${sanitizeFileName(user.email.replace("@", "_at_"))}/${projectId}/`;
    if (!filePath.startsWith(expectedPrefix)) {
      sendJson(res, 403, { error: "Uploaded file does not belong to the current project" });
      return;
    }
  }
  const type = assetType(mimeType, fileName);
  let duration: number | undefined;
  if (type === "video" || type === "audio") {
    const probePath = resolve(STORAGE_DIR, projectId, "r2-probe", `${Date.now()}-${sanitizeFileName(fileName)}`);
    try {
      await downloadR2ToFile(filePath, probePath);
      duration = await getDurationSec(probePath);
    } catch {
      // Duration probe is best-effort — an upload should not fail because of it.
    } finally {
      await rm(probePath, { force: true }).catch(() => {});
    }
  }
  const asset = createAsset({
    projectId,
    type,
    fileName,
    mimeType,
    filePath,
    fileSize,
    duration,
  });
  sendJson(res, 201, { ok: true, asset });
}

async function handleCreatePresetSfx(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const body = await readJsonBody(req);
  const preset = ((body as { preset?: string }).preset || "whoosh").toLowerCase();
  const presets: Record<string, { freq: number; duration: number; label: string }> = {
    whoosh: { freq: 520, duration: 0.55, label: "whoosh-transition.mp3" },
    hit: { freq: 110, duration: 0.35, label: "impact-hit.mp3" },
    ding: { freq: 980, duration: 0.45, label: "ding-highlight.mp3" },
    riser: { freq: 740, duration: 0.9, label: "riser-short.mp3" },
  };
  const spec = presets[preset] ?? presets.whoosh;
  const targetDir = resolve(STORAGE_DIR, projectId, "audio");
  await mkdir(targetDir, { recursive: true });
  const fileName = `${Date.now()}-${spec.label}`;
  const filePath = join(targetDir, fileName);
  await runProcess(FFMPEG_BIN, [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=${spec.freq}:duration=${spec.duration}`,
    "-filter:a", "volume=0.35,afade=t=out:st=0.25:d=0.25",
    "-q:a", "5",
    filePath,
  ]);
  const info = await stat(filePath);
  const storedPath = isR2Configured()
    ? await uploadFileToR2(filePath, r2Key(user.email, projectId, "audio", spec.label), "audio/mpeg")
    : filePath;
  const asset = createAsset({
    projectId,
    type: "audio",
    fileName: spec.label,
    mimeType: "audio/mpeg",
    filePath: storedPath,
    fileSize: info.size,
    duration: spec.duration,
  });
  sendJson(res, 201, { ok: true, asset });
}

function resultPaths(outputDir: string) {
  const absOutputDir = resolve(outputDir);
  return {
    outputDir: absOutputDir,
    scriptJson: resolve(outputDir, "script.json"),
    scriptText: resolve(outputDir, "script.txt"),
    audio: resolve(outputDir, "voice.mp3"),
    subtitle: resolve(outputDir, "subtitles", "subtitle.srt"),
    video: resolve(outputDir, "video.mp4"),
  };
}

async function localFileForRender(ownerEmail: string, projectId: string, filePath: string, fileName: string) {
  if (!isR2Path(filePath)) return filePath;
  const targetPath = resolve(
    STORAGE_DIR,
    projectId,
    "r2-cache",
    `${Date.now()}-${sanitizeFileName(fileName)}`,
  );
  await downloadR2ToFile(filePath, targetPath);
  return targetPath;
}

async function publishResultPaths(ownerEmail: string, projectId: string, paths: ReturnType<typeof resultPaths>) {
  const localPaths = await copyResultToSaveRoot(ownerEmail, projectId, paths);
  if (!isR2Configured()) return localPaths;
  const uploadIfExists = async (localPath: string, fileName: string, mimeType: string) => {
    const info = await stat(localPath).catch(() => null);
    if (!info?.isFile()) return localPath;
    return uploadFileToR2(localPath, r2Key(ownerEmail, projectId, "output", fileName), mimeType);
  };
  const [scriptJson, scriptText, audio, subtitle, video] = await Promise.all([
    uploadIfExists(localPaths.scriptJson, "script.json", "application/json"),
    uploadIfExists(localPaths.scriptText, "script.txt", "text/plain; charset=utf-8"),
    uploadIfExists(localPaths.audio, "voice.mp3", "audio/mpeg"),
    uploadIfExists(localPaths.subtitle, "subtitle.srt", "text/plain; charset=utf-8"),
    uploadIfExists(localPaths.video, "video.mp4", "video/mp4"),
  ]);
  return {
    ...localPaths,
    scriptJson,
    scriptText,
    audio,
    subtitle,
    video,
  };
}

function timestampForPath(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sceneTemplateInputs(voiceText: string, index: number, count: number) {
  const headline = voiceText.length > 58 ? `${voiceText.slice(0, 55).trim()}...` : voiceText;
  if (index === 0) {
    return {
      templateId: "frame-liquid-bg-hero",
      inputs: { kicker: "AI Video", headline, subheadline: "Kịch bản đã chỉnh trong web app", cta: "Bắt đầu", brand: "AI Video Studio" },
    };
  }
  if (index === count - 1) {
    return {
      templateId: "frame-logo-outro",
      inputs: { brand_name: "AI Video Studio", tagline: headline, primary_url: "local://export" },
    };
  }
  return {
    templateId: "frame-build-minimal",
    inputs: {
      eyebrow: `Scene ${index + 1}`,
      hero: headline,
      desc: voiceText,
      side_left: "Voice",
      side_right: "Video",
    },
  };
}

function buildLocalProjectScript(project: NonNullable<ReturnType<typeof getProject>>) {
  const topic = project.topic.trim() || "video mới";
  const title = project.title?.trim() || `Video: ${topic.slice(0, 70)}`;
  const sceneTexts = [
    `Mở đầu bằng câu hỏi gây tò mò về ${topic}. Người xem cần biết video này sẽ trả lời điều gì và vì sao đáng xem đến cuối.`,
    `Giới thiệu nhanh bối cảnh chính của chủ đề, nhấn vào điểm khiến nội dung này nổi bật so với các video thông thường.`,
    `Phân tích phần hấp dẫn nhất: cảm xúc, tình huống hoặc lợi ích chính mà người xem có thể nhận được.`,
    `Nêu một điểm cần cân nhắc hoặc hạn chế để nội dung có góc nhìn thật, không chỉ là lời quảng cáo một chiều.`,
    `Đưa ra nhận xét tổng hợp, kết nối các ý chính thành một thông điệp rõ ràng, dễ nhớ và phù hợp với khán giả.`,
    `Kết luận bằng lời khuyên hoặc lời kêu gọi hành động ngắn gọn: có nên xem, làm theo, mua, lưu lại hoặc chia sẻ hay không.`,
  ];
  return {
    script: {
      metadata: {
        title,
        source: { url: "local://fallback-script", domain: "local", image: null },
        channel: "AI Video Studio",
      },
      scenes: sceneTexts.map((voiceText, index) => ({
        id: index === 0 ? "hook" : index === sceneTexts.length - 1 ? "outro" : `body-${index}`,
        type: index === 0 ? "hook" : index === sceneTexts.length - 1 ? "outro" : "body",
        voiceText,
        templateId: sceneTemplateInputs(voiceText, index, sceneTexts.length).templateId,
      })),
    },
    outputDir: "",
    scriptPath: "",
  };
}

async function generateProjectScript(project: NonNullable<ReturnType<typeof getProject>>, aiProvider?: "gemini" | "openai") {
  try {
    const generated = await generateScriptFromPrompt(project.topic, {
      voiceProvider: "edge",
      voiceName: project.voice_name,
      voiceSpeed: project.voice_speed,
      targetDurationSec: project.target_duration_sec,
      aiProvider,
    });
    return { ...generated, usedFallback: false as const, fallbackReason: null as string | null };
  } catch (error) {
    return {
      ...buildLocalProjectScript(project),
      usedFallback: true as const,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeProjectScriptFromScenes(projectId: string, folderName?: string) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const scenes = listScenes(projectId);
  if (scenes.length < 3) {
    throw new Error("Cần ít nhất 3 scene trước khi tạo MP3/MP4");
  }
  const requestedFolder = folderName?.trim() ? sanitizeFileName(folderName.trim()) : "";
  // Stable per project (not timestamped): a crashed/interrupted render can be
  // retried by just re-triggering "Xuất video" and it will resume from
  // whichever scenes/clips already finished (see the REUSE checks in
  // runTemplatePipeline) instead of starting over from scratch every time.
  const baseFolder = requestedFolder || `${toSlug(project.title || project.topic || "video")}-${projectId}`;
  const outputDir = resolve("output", baseFolder);
  const scriptPath = join(outputDir, "script.json");
  const scriptScenes = scenes.map((scene, index) => {
    const normalizedType = index === 0 ? "hook" : index === scenes.length - 1 ? "outro" : "body";
    const fallback = sceneTemplateInputs(scene.voice_text, index, scenes.length);
    return {
      id: scene.scene_key || `scene-${index + 1}`,
      type: normalizedType,
      voiceText: scene.voice_text,
      templateId: fallback.templateId,
      inputs: fallback.inputs,
    };
  });
  const script = {
    version: "1.0",
    renderer: "hyperframes",
    metadata: {
      title: project.title || "Untitled video",
      source: { url: "local://web-app-project", domain: "local", image: null },
      channel: "AI Video Studio",
    },
    voice: { provider: "edge", name: project.voice_name || "vi-VN-HoaiMyNeural", speed: project.voice_speed || 1 },
    aspect: project.aspect_ratio || "9:16",
    scenes: scriptScenes,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script, null, 2), "utf8");
  return { outputDir, scriptPath };
}

/** Maps pipeline scene ids (scene_key, or "scene-N" fallback — see writeProjectScriptFromScenes)
 *  back to real scene DB rows, and stores the TTS-measured duration so the
 *  timeline's subtitle sync can anchor to real audio instead of guessing. */
function persistSceneDurations(projectId: string, sceneDurations: Record<string, number>) {
  const scenes = listScenes(projectId);
  scenes.forEach((scene, index) => {
    const pipelineId = scene.scene_key || `scene-${index + 1}`;
    const duration = sceneDurations[pipelineId];
    if (duration && duration > 0) {
      updateScene(scene.id, { voice_duration_sec: duration });
    }
  });
}

async function copyResultToSaveRoot(ownerEmail: string, projectId: string, paths: ReturnType<typeof resultPaths>) {
  const settings = getUserSettings(ownerEmail);
  if (!settings.save_root?.trim()) return paths;
  const safeEmail = sanitizeFileName(ownerEmail.replace("@", "_at_"));
  const targetDir = resolve(settings.save_root, safeEmail, projectId);
  await mkdir(targetDir, { recursive: true });
  const copied = {
    outputDir: targetDir,
    scriptJson: join(targetDir, "script.json"),
    scriptText: join(targetDir, "script.txt"),
    audio: join(targetDir, "voice.mp3"),
    subtitle: join(targetDir, "subtitle.srt"),
    video: join(targetDir, "video.mp4"),
  };
  await Promise.all([
    copyFile(paths.scriptJson, copied.scriptJson).catch(() => undefined),
    copyFile(paths.scriptText, copied.scriptText).catch(() => undefined),
    copyFile(paths.audio, copied.audio).catch(() => undefined),
    copyFile(paths.subtitle, copied.subtitle).catch(() => undefined),
    copyFile(paths.video, copied.video).catch(() => undefined),
  ]);
  return copied;
}

function jobResponse(projectId: string, jobId: string) {
  return {
    project: getProject(projectId),
    job: getRenderJob(jobId),
  };
}

function startRenderJob(projectId: string, jobId: string, folderName?: string, burnSubtitles = false) {
  void (async () => {
    const project = getProject(projectId);
    if (!project) return;
    const isCancelled = () => getRenderJob(jobId)?.status === "cancelled";
    try {
      if (isCancelled()) return;
      updateProject(projectId, { status: "generating_script", error_message: null });
      updateRenderJob(jobId, {
        status: "running",
        progress: 5,
        current_step: "Preparing edited script",
        started_at: new Date().toISOString(),
        error_message: null,
      });

      const generated = await writeProjectScriptFromScenes(projectId, folderName);
      if (isCancelled()) return;

      updateProject(projectId, {
        status: "rendering",
      });
      updateRenderJob(jobId, {
        progress: 25,
        current_step: "Rendering video",
        output_dir: resolve(generated.outputDir),
        script_path: resolve(generated.scriptPath),
      });

      const assets = listAssets(projectId);
      const scenes = listScenes(projectId);
      const footageEntries = await Promise.all(
        scenes
          .map(async (scene, index) => {
            const asset = assets.find((item) => item.id === scene.source_asset_id && item.type === "video");
            if (!asset) return null;
            const sceneId = scene.scene_key || `scene-${index + 1}`;
            const path = await localFileForRender(project.owner_email, projectId, asset.file_path, asset.file_name);
            return [sceneId, { path, startSec: scene.source_start, endSec: scene.source_end }];
          })
      );
      const footagePlan = Object.fromEntries(
        footageEntries.filter(Boolean) as Array<[string, { path: string; startSec: number | null; endSec: number | null }]>,
      );
      const hasVideoAssets = assets.some((asset) => asset.type === "video");
      const backgroundAudio = assets.find((asset) => asset.type === "audio" && !asset.file_name.startsWith("voiceover-"));
      const backgroundAudioPath = backgroundAudio
        ? await localFileForRender(project.owner_email, projectId, backgroundAudio.file_path, backgroundAudio.file_name)
        : undefined;
      const pipelineResult = await runTemplatePipeline(generated.scriptPath, {
        footageDir: hasVideoAssets ? resolve(STORAGE_DIR, projectId, "source") : undefined,
        footagePlan,
        backgroundAudioPath,
        burnSubtitles,
        onProgress: (step, progress) => {
          if (isCancelled()) return;
          updateRenderJob(jobId, { current_step: step, progress: Math.min(95, 25 + Math.round((progress / 100) * 70)) });
        },
      });
      if (isCancelled()) return;
      if (pipelineResult?.sceneDurations) persistSceneDurations(projectId, pipelineResult.sceneDurations);

      const paths = await publishResultPaths(project.owner_email, projectId, resultPaths(generated.outputDir));
      updateProject(projectId, {
        status: "completed",
        output_path: paths.video,
      });
      updateRenderJob(jobId, {
        status: "completed",
        progress: 100,
        current_step: "Completed",
        output_dir: paths.outputDir,
        script_path: paths.scriptJson,
        video_path: paths.video,
        audio_path: paths.audio,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProject(projectId, {
        status: "failed",
        error_message: message,
      });
      updateRenderJob(jobId, {
        status: "failed",
        progress: 100,
        current_step: "Failed",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
    }
  })();
}

function startTimelineRenderJob(projectId: string, jobId: string) {
  void (async () => {
    const project = getProject(projectId);
    if (!project) return;
    const isCancelled = () => getRenderJob(jobId)?.status === "cancelled";
    try {
      if (isCancelled()) return;
      updateProject(projectId, { status: "rendering", error_message: null });
      updateRenderJob(jobId, {
        status: "running",
        progress: 5,
        current_step: "Chuẩn bị render timeline",
        started_at: new Date().toISOString(),
        error_message: null,
      });

      const baseFolder = toSlug(project.title || project.topic || "timeline");
      const outputDir = resolve("output", `${baseFolder}-timeline-${timestampForPath()}`);
      const aspect = (["16:9", "9:16", "1:1"].includes(project.aspect_ratio) ? project.aspect_ratio : "9:16") as "16:9" | "9:16" | "1:1";

      const result = await renderProjectTimeline(
        projectId,
        outputDir,
        aspect,
        (asset) => localFileForRender(project.owner_email, projectId, asset.file_path, asset.file_name),
        (step, progress) => {
          if (isCancelled()) return;
          updateRenderJob(jobId, { current_step: step, progress: Math.min(89, progress) });
        },
      );
      if (isCancelled()) return;

      const paths = await publishResultPaths(project.owner_email, projectId, {
        outputDir: result.outputDir,
        scriptJson: resolve(result.outputDir, "script.json"),
        scriptText: resolve(result.outputDir, "script.txt"),
        audio: result.audioPath,
        subtitle: result.subtitlePath ?? resolve(result.outputDir, "subtitles", "subtitle.srt"),
        video: result.videoPath,
      });

      updateProject(projectId, { status: "completed", output_path: paths.video });
      updateRenderJob(jobId, {
        status: "completed",
        progress: 100,
        current_step: "Hoàn tất",
        output_dir: paths.outputDir,
        video_path: paths.video,
        audio_path: paths.audio,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProject(projectId, { status: "failed", error_message: message });
      updateRenderJob(jobId, {
        status: "failed",
        progress: 100,
        current_step: "Failed",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
    }
  })();
}

function startAudioJob(projectId: string, jobId: string) {
  void (async () => {
    const project = getProject(projectId);
    if (!project) return;
    const isCancelled = () => getRenderJob(jobId)?.status === "cancelled";
    try {
      updateRenderJob(jobId, {
        status: "running",
        progress: 10,
        current_step: "Preparing edited script",
        started_at: new Date().toISOString(),
        error_message: null,
      });
      const generated = await writeProjectScriptFromScenes(projectId);
      if (isCancelled()) return;
      updateRenderJob(jobId, {
        progress: 35,
        current_step: "Generating MP3 voice",
        output_dir: resolve(generated.outputDir),
        script_path: resolve(generated.scriptPath),
      });
      const pipelineResult = await runTemplatePipeline(generated.scriptPath, {
        audioOnly: true,
        onProgress: (step, progress) => {
          if (isCancelled()) return;
          updateRenderJob(jobId, { current_step: step, progress: Math.min(90, 35 + Math.round((progress / 100) * 55)) });
        },
      });
      if (isCancelled()) return;
      if (pipelineResult?.sceneDurations) persistSceneDurations(projectId, pipelineResult.sceneDurations);
      const localPaths = await copyResultToSaveRoot(project.owner_email, projectId, resultPaths(generated.outputDir));
      const audioInfo = await stat(localPaths.audio).catch(() => null);
      const paths = await publishResultPaths(project.owner_email, projectId, resultPaths(generated.outputDir));
      if (audioInfo?.isFile()) {
        const duration = await getDurationSec(localPaths.audio).catch(() => undefined);
        createAsset({
          projectId,
          type: "audio",
          fileName: `voiceover-${timestampForPath()}.mp3`,
          mimeType: "audio/mpeg",
          filePath: paths.audio,
          fileSize: audioInfo.size,
          duration,
        });
      }
      updateRenderJob(jobId, {
        status: "completed",
        progress: 100,
        current_step: "MP3 completed",
        output_dir: paths.outputDir,
        script_path: paths.scriptJson,
        audio_path: paths.audio,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateRenderJob(jobId, {
        status: "failed",
        progress: 100,
        current_step: "Failed",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
    }
  })();
}

async function handleCreateVideo(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const prompt = body.prompt?.trim();
  if (!prompt) {
    sendJson(res, 400, { error: 'Missing "prompt" in JSON body' });
    return;
  }
  const selectedVoice = findVoiceOption(body.voiceId ?? body.voiceName);
  if (selectedVoice.status !== "ready") {
    sendJson(res, 400, {
      error: "Voice preset is not ready",
      voice: selectedVoice,
      nextStep: "Enable an OmniVoice / voice-clone API before using this preset.",
    });
    return;
  }

  const generated = await generateScriptFromPrompt(prompt, {
    voiceProvider: selectedVoice.provider,
    voiceName: selectedVoice.runtimeVoiceName,
    voiceSpeed: body.voiceSpeed,
  });
  const shouldRender = body.render !== false;

  if (shouldRender) {
    await runTemplatePipeline(generated.scriptPath);
  }

  sendJson(res, 200, {
    ok: true,
    rendered: shouldRender,
    title: generated.script.metadata.title,
    paths: resultPaths(generated.outputDir),
    scenes: generated.script.scenes.length,
  });
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const prompt = body.prompt?.trim();
  if (!prompt) {
    sendJson(res, 400, { error: 'Missing "prompt" in JSON body' });
    return;
  }
  const selectedVoice = findVoiceOption(body.voiceId ?? body.voiceName);
  if (selectedVoice.status !== "ready") {
    sendJson(res, 400, {
      error: "Voice preset is not ready",
      voice: selectedVoice,
      nextStep: "Enable an OmniVoice / voice-clone API before using this preset.",
    });
    return;
  }
  const ratio = typeof body.ratio === "string" && ["16:9", "9:16", "1:1"].includes(body.ratio) ? body.ratio : undefined;
  const durationSec = Number(body.durationSec);
  const project = createProject({
    ownerEmail: user.email,
    topic: prompt,
    voiceId: selectedVoice.id,
    voiceName: selectedVoice.runtimeVoiceName,
    voiceSpeed: body.voiceSpeed ?? 1,
    aspectRatio: ratio,
    targetDurationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
  });
  if (body.projectName?.trim()) {
    updateProject(project.id, { title: body.projectName.trim() });
    project.title = body.projectName.trim();
  }
  if (body.render === true) {
    const job = createRenderJob(project.id);
    startRenderJob(project.id, job.id);
    sendJson(res, 202, { ok: true, project, job });
    return;
  }
  sendJson(res, 201, { ok: true, project, job: null });
}

async function handleStartProjectRender(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const runningJob = getLatestJobForProject(projectId);
  if (runningJob && (runningJob.status === "queued" || runningJob.status === "running")) {
    sendJson(res, 409, { error: "Project already has a running job", job: runningJob });
    return;
  }
  const body = await readJsonBody(req);
  const folderName = typeof (body as { folderName?: unknown }).folderName === "string"
    ? (body as { folderName: string }).folderName
    : undefined;
  const burnSubtitles = (body as { burnSubtitles?: unknown }).burnSubtitles === true;
  const job = createRenderJob(projectId);
  startRenderJob(projectId, job.id, folderName, burnSubtitles);
  sendJson(res, 202, { ok: true, project, job });
}

async function handleStartProjectAudio(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const runningJob = getLatestJobForProject(projectId);
  if (runningJob && (runningJob.status === "queued" || runningJob.status === "running")) {
    sendJson(res, 409, { error: "Project already has a running job", job: runningJob });
    return;
  }
  const job = createRenderJob(projectId);
  startAudioJob(projectId, job.id);
  sendJson(res, 202, { ok: true, project, job });
}

async function handleGenerateProjectScript(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const user = requireUser(req, res);
  if (!user) return;
  const project = getUserProject(user.email, projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
  const aiProvider = (body as { aiProvider?: unknown }).aiProvider === "openai" ? "openai" : "gemini";
  updateProject(projectId, { status: "generating_script", error_message: null });
  const generated = await generateProjectScript(project, aiProvider);
  const scenes = replaceProjectScenes(projectId, generated.script.scenes);
  updateProject(projectId, {
    title: generated.script.metadata.title,
    status: "draft",
  });
  sendJson(res, 200, {
    ok: true,
    project: getProject(projectId),
    scenes,
    title: generated.script.metadata.title,
    usedFallback: generated.usedFallback,
    fallbackReason: generated.fallbackReason,
    paths: {
      outputDir: generated.outputDir ? resolve(generated.outputDir) : null,
      scriptJson: generated.scriptPath ? resolve(generated.scriptPath) : null,
    },
  });
}

async function handleGoogleStart(req: IncomingMessage, res: ServerResponse) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    sendJson(res, 501, {
      error: "Google OAuth is not configured",
      requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
    });
    return;
  }
  if (IS_PRODUCTION && ALLOWED_EMAILS.length === 0) {
    sendJson(res, 503, {
      error: "Private app is not configured",
      requiredEnv: ["ALLOWED_EMAILS"],
      hint: "Set ALLOWED_EMAILS before exposing the deployed app URL.",
    });
    return;
  }
  const state = createOAuthState();
  setCookie(res, "avs_oauth_state", state, "Path=/; HttpOnly; SameSite=Lax; Max-Age=600");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state,
  });
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function handleGoogleCallback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies(req).avs_oauth_state;
  const cookieMatches = Boolean(expectedState && state && state === expectedState);
  if (!code || !state || (!cookieMatches && !isValidOAuthState(state))) {
    sendJson(res, 400, { error: "Invalid Google OAuth response" });
    return;
  }
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    sendJson(res, 502, { error: "Google token exchange failed", details: await tokenResp.text() });
    return;
  }
  const token = (await tokenResp.json()) as { access_token?: string };
  const userResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userResp.ok) {
    sendJson(res, 502, { error: "Google userinfo failed", details: await userResp.text() });
    return;
  }
  const googleUser = (await userResp.json()) as { email?: string; name?: string; picture?: string };
  if (!googleUser.email) {
    sendJson(res, 400, { error: "Google account has no email" });
    return;
  }
  const email = googleUser.email.toLowerCase();
  if (!isAllowedEmail(email)) {
    sendJson(res, 403, {
      error: "This Gmail is not allowed to use this private app",
      email,
      hint: "Add this email to ALLOWED_EMAILS in the server environment.",
    });
    return;
  }
  const user = upsertUser({
    email,
    name: googleUser.name ?? googleUser.email,
    picture: googleUser.picture ?? null,
    provider: "google",
  });
  const session = createSession(user.email);
  setCookie(res, SESSION_COOKIE, session.id);
  clearCookie(res, "avs_oauth_state");
  redirect(res, APP_PUBLIC_URL || "/");
}

async function handleDevLogin(req: IncomingMessage, res: ServerResponse) {
  if (process.env.ALLOW_DEV_LOGIN !== "true") {
    sendJson(res, 403, { error: "Dev login is disabled. Use Google OAuth." });
    return;
  }
  const body = await readJsonBody(req);
  const email = (body as { email?: string }).email?.trim().toLowerCase();
  if (!email || !email.endsWith("@gmail.com")) {
    sendJson(res, 400, { error: "Use a gmail.com email for dev login" });
    return;
  }
  if (!isAllowedEmail(email)) {
    sendJson(res, 403, { error: "This Gmail is not allowed to use this private app", email });
    return;
  }
  // Preserve a real display name/picture if one is already on record (e.g.
  // pushed in by the desktop-provisioning handshake) instead of overwriting
  // it with the email-prefix placeholder on every dev-login.
  const existing = getUser(email);
  const user = upsertUser({
    email,
    name: existing?.name || email.split("@")[0],
    picture: existing?.picture ?? null,
    provider: "dev",
  });
  const session = createSession(user.email);
  setCookie(res, SESSION_COOKIE, session.id);
  sendJson(res, 200, { ok: true, user });
}

interface DesktopVersionInfo {
  version: string;
  downloadUrl: string;
  notes?: string;
}

async function readDesktopVersionFile(): Promise<DesktopVersionInfo> {
  const text = await readFile(resolve("desktop", "version.json"), "utf8");
  return JSON.parse(text) as DesktopVersionInfo;
}

async function handleDesktopVersion(_req: IncomingMessage, res: ServerResponse) {
  try {
    const info = await readDesktopVersionFile();
    sendJson(res, 200, info);
  } catch {
    sendJson(res, 200, { version: "0.0.0", downloadUrl: "" });
  }
}

/** Local-desktop-only: fetches the installer the live backend currently
 *  points to and launches it, then exits so the installer can overwrite
 *  files that are locked while this process is running. Never runs on the
 *  real deployed backend (IS_PRODUCTION guard) — self-replacing the live
 *  Render service would make no sense and would be dangerous. */
async function handleDesktopSelfUpdate(req: IncomingMessage, res: ServerResponse) {
  if (IS_PRODUCTION) {
    sendJson(res, 403, { error: "Self-update is only available on the local desktop build" });
    return;
  }
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const latestRes = await fetch(`${PRODUCTION_BACKEND_URL}/api/desktop/version`, { signal: AbortSignal.timeout(10000) });
    if (!latestRes.ok) throw new Error(`Version check failed: HTTP ${latestRes.status}`);
    const latest = (await latestRes.json()) as DesktopVersionInfo;
    if (!latest.downloadUrl) throw new Error("No download URL published yet");

    const installerRes = await fetch(latest.downloadUrl, { signal: AbortSignal.timeout(120000) });
    if (!installerRes.ok || !installerRes.body) throw new Error(`Download failed: HTTP ${installerRes.status}`);
    const installerPath = join(os.tmpdir(), `AI-Video-Studio-Setup-${latest.version}.exe`);
    const fileBuffer = Buffer.from(await installerRes.arrayBuffer());
    await writeFile(installerPath, fileBuffer);

    sendJson(res, 200, { ok: true, version: latest.version });

    // Give the response time to flush to the browser before this process
    // exits (needed so the installer can safely overwrite the running node.exe).
    setTimeout(() => {
      spawn(installerPath, [], { detached: true, stdio: "ignore" }).unref();
      process.exit(0);
    }, 1500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
}

// Only the frontend origins this app is actually deployed on may call the
// local receive-config endpoint cross-origin — narrows who can push config
// into a locally running instance to "pages this app itself serves".
const DESKTOP_PROVISION_ALLOWED_ORIGINS = new Set([
  "https://videostudioai-iota.vercel.app",
  PRODUCTION_BACKEND_URL,
]);

/** Production-only in practice: returns this deployment's own secrets to
 *  the currently authenticated (allow-listed) user, so their local desktop
 *  build can configure itself without them typing anything. Deliberately
 *  narrow — only what the local instance needs, and notably NOT the Google
 *  OAuth client secret: the local build uses dev-login instead (bypasses
 *  Google entirely), since the OAuth redirect URI is registered for the
 *  production domain only and a localhost redirect would just fail anyway. */
async function handleDesktopProvisionConfig(req: IncomingMessage, res: ServerResponse) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, {
    email: user.email,
    displayName: user.name,
    picture: user.picture ?? "",
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.OPENAI_MODEL ?? "",
    databaseUrl: process.env.DATABASE_URL ?? "",
    allowedEmails: process.env.ALLOWED_EMAILS ?? "",
    ttsVoiceName: process.env.TTS_VOICE_NAME ?? "",
    ttsSpeed: process.env.TTS_SPEED ?? "",
    edgeTtsMode: process.env.EDGE_TTS_MODE ?? "edge-first",
    channelName: process.env.CHANNEL_NAME ?? "",
  });
}

/** Local-desktop-only: receives config pushed from an authenticated browser
 *  tab on the real web app (see DESKTOP_PROVISION_ALLOWED_ORIGINS), writes
 *  it to .env.local next to this install, then restarts itself so the new
 *  env actually takes effect. CORS-enabled for exactly those origins since
 *  the call is a genuine cross-origin request (production page -> localhost). */
async function handleDesktopReceiveConfig(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && DESKTOP_PROVISION_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  if (IS_PRODUCTION) {
    sendJson(res, 403, { error: "Only available on the local desktop build" });
    return;
  }
  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
    const lines = [
      "APP_ENV=development",
      "NODE_ENV=development",
      `API_PORT=${PORT}`,
      "ALLOW_DEV_LOGIN=true",
      `ALLOWED_EMAILS=${str("allowedEmails")}`,
      `APP_PUBLIC_URL=http://127.0.0.1:${PORT}`,
      `GEMINI_API_KEY=${str("geminiApiKey")}`,
      `GEMINI_MODEL=${str("geminiModel") || "gemini-2.5-flash"}`,
      `OPENAI_API_KEY=${str("openaiApiKey")}`,
      `OPENAI_MODEL=${str("openaiModel") || "gpt-4o-mini"}`,
      `DATABASE_URL=${str("databaseUrl")}`,
      `EDGE_TTS_MODE=${str("edgeTtsMode") || "edge-first"}`,
      `TTS_VOICE_NAME=${str("ttsVoiceName")}`,
      `TTS_SPEED=${str("ttsSpeed")}`,
      `CHANNEL_NAME=${str("channelName")}`,
      "",
    ].join("\n");
    await writeFile(resolve(".env.local"), lines, "utf8");

    // Seed the real display name/picture now, before the restart — otherwise
    // the first dev-login would fall back to the email-prefix placeholder.
    const email = str("email");
    if (email) {
      upsertUser({ email, name: str("displayName") || email.split("@")[0], picture: str("picture") || null, provider: "dev" });
    }

    sendJson(res, 200, { ok: true });

    setTimeout(() => {
      const distEntry = resolve("dist", "api.js");
      spawn(process.execPath, [distEntry], { cwd: resolve("."), detached: true, stdio: "ignore", windowsHide: true }).unref();
      process.exit(0);
    }, 1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop/version") {
      await handleDesktopVersion(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/desktop/self-update") {
      await handleDesktopSelfUpdate(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/desktop/provision-config") {
      await handleDesktopProvisionConfig(req, res);
      return;
    }

    if (url.pathname === "/api/desktop/receive-config") {
      if (req.method === "OPTIONS") {
        const origin = req.headers.origin;
        if (origin && DESKTOP_PROVISION_ALLOWED_ORIGINS.has(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "POST") {
        await handleDesktopReceiveConfig(req, res);
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const user = currentUser(req);
      sendJson(res, 200, {
        authenticated: Boolean(user),
        user,
        googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        devLoginEnabled: process.env.ALLOW_DEV_LOGIN === "true",
        privateAccessEnabled: ALLOWED_EMAILS.length > 0,
        privateAccessRequired: IS_PRODUCTION,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/system/status") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        ok: true,
        appEnv: APP_ENV,
        googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        privateAccessEnabled: ALLOWED_EMAILS.length > 0,
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        r2Configured: isR2Configured(),
        databaseConfigured: Boolean(process.env.DATABASE_URL),
        ffmpegBin: FFMPEG_BIN,
        ttsProvider: process.env.TTS_PROVIDER || "edge",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/google/start") {
      await handleGoogleStart(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
      await handleGoogleCallback(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/dev-login") {
      await handleDevLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const sessionId = cookies(req)[SESSION_COOKIE];
      if (sessionId) deleteSession(sessionId);
      clearCookie(res, SESSION_COOKIE);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/voices") {
      sendJson(res, 200, {
        voices: VOICE_OPTIONS,
        defaultVoice: VOICE_OPTIONS[0].id,
        defaultSpeed: 1,
        readyProviders: ["edge"],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/voices/preview") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const voiceId = String((body as { voiceId?: unknown }).voiceId || "");
      const voice = VOICE_OPTIONS.find((item) => item.id === voiceId);
      if (!voice) {
        sendJson(res, 404, { error: "Voice not found" });
        return;
      }
      if (voice.status !== "ready") {
        sendJson(res, 400, { error: `Giọng "${voice.label}" cần cấu hình server riêng (${voice.source}), chưa preview được.` });
        return;
      }
      const rawText = typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : "";
      const text = (rawText.trim() || "Xin chào, đây là giọng đọc thử trong AI Video Studio.").slice(0, 220);
      const speed = Math.min(2, Math.max(0.5, Number((body as { speed?: unknown }).speed) || 1));
      // Cached by (voice, speed, text) — the common case is the same default
      // demo phrase at speed 1 for a given voice, so after the first request
      // ever made for that combo, every later preview is instant instead of
      // re-running TTS from scratch each click.
      const previewDir = resolve("storage", "voice-previews");
      await mkdir(previewDir, { recursive: true });
      const textHash = createHash("sha1").update(text).digest("hex").slice(0, 16);
      const previewPath = join(previewDir, `${voice.id}-${speed}-${textHash}.mp3`);
      try {
        if (!existsSync(previewPath)) {
          const client = createTtsClient(loadConfig(), { provider: "edge", voiceName: voice.runtimeVoiceName, speed });
          await client.generate(text, previewPath);
        }
        const audioBuffer = await readFile(previewPath);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audioBuffer.length),
          "Cache-Control": "private, max-age=86400",
        });
        res.end(audioBuffer);
      } catch (error) {
        sendJson(res, 502, { error: `Tạo preview thất bại: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/templates") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { templates: TEMPLATE_PRESETS });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/files") {
      const user = requireUser(req, res);
      if (!user) return;
      const path = url.searchParams.get("path");
      if (!path) {
        sendJson(res, 400, { error: "Missing path" });
        return;
      }
      if (isR2Path(path)) {
        if (!isUserFile(user.email, path)) {
          sendJson(res, 403, { error: "File does not belong to the current user" });
          return;
        }
        const url = await signedR2Url(path, 900);
        res.writeHead(302, { Location: url, "Cache-Control": "private, max-age=0, no-store" });
        res.end();
        return;
      }
      const resolvedPath = resolve(path);
      if (!isUserFile(user.email, resolvedPath)) {
        sendJson(res, 403, { error: "File does not belong to the current user" });
        return;
      }
      const settings = getUserSettings(user.email);
      const extraRoots = settings.save_root ? [settings.save_root] : [];
      await sendFileByPath(req, res, resolvedPath, req.method === "HEAD", extraRoots);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/files/open-folder") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const path = (body as { path?: string }).path;
      if (!path) {
        sendJson(res, 400, { error: "Missing path" });
        return;
      }
      const resolvedPath = resolve(path);
      if (!isUserFile(user.email, resolvedPath)) {
        sendJson(res, 403, { error: "File does not belong to the current user" });
        return;
      }
      const info = await stat(resolvedPath).catch(() => null);
      const folder = info?.isDirectory() ? resolvedPath : resolvedPath.replace(/[\\/][^\\/]+$/, "");
      if (process.platform === "win32") {
        spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" }).unref();
        sendJson(res, 200, { ok: true, opened: folder, mode: "local-desktop" });
        return;
      }
      sendJson(res, 409, { error: "Open folder is only available on local Windows desktop mode", folder });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const user = requireUser(req, res);
      if (!user) return;
      const stats = getStats(user.email);
      const settings = getUserSettings(user.email);
      const storagePaths = [...new Set(listUserStoragePaths(user.email).map((pathname) => resolve(pathname)))];
      const storageBytes = (await Promise.all(storagePaths.map((pathname) => folderSize(pathname)))).reduce((sum, bytes) => sum + bytes, 0);
      sendJson(res, 200, {
        ...stats,
        credits: settings.credits,
        storage: {
          usedBytes: storageBytes,
          quotaBytes: settings.storage_quota_bytes || STORAGE_QUOTA_BYTES,
          usedHuman: humanBytes(storageBytes),
          quotaHuman: humanBytes(settings.storage_quota_bytes || STORAGE_QUOTA_BYTES),
          percent: settings.storage_quota_bytes > 0 ? Math.round((storageBytes / settings.storage_quota_bytes) * 1000) / 10 : 0,
          measuredPaths: storagePaths.length,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { settings: getUserSettings(user.email) });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const settings = updateUserSettings(user.email, {
        credits: typeof (body as { credits?: unknown }).credits === "number" ? (body as { credits: number }).credits : undefined,
        storage_quota_bytes: typeof (body as { storageQuotaGb?: unknown }).storageQuotaGb === "number"
          ? Math.max(1, (body as { storageQuotaGb: number }).storageQuotaGb) * 1024 * 1024 * 1024
          : undefined,
        default_language: typeof (body as { defaultLanguage?: unknown }).defaultLanguage === "string" ? (body as { defaultLanguage: string }).defaultLanguage : undefined,
        default_ratio: typeof (body as { defaultRatio?: unknown }).defaultRatio === "string" ? (body as { defaultRatio: string }).defaultRatio : undefined,
        default_quality: typeof (body as { defaultQuality?: unknown }).defaultQuality === "string" ? (body as { defaultQuality: string }).defaultQuality : undefined,
        theme: typeof (body as { theme?: unknown }).theme === "string" ? (body as { theme: string }).theme : undefined,
        ui_scale: typeof (body as { uiScale?: unknown }).uiScale === "number"
          ? Math.min(1.35, Math.max(0.8, (body as { uiScale: number }).uiScale))
          : undefined,
        storage_mode: typeof (body as { storageMode?: unknown }).storageMode === "string" ? (body as { storageMode: string }).storageMode : undefined,
        save_root: typeof (body as { saveRoot?: unknown }).saveRoot === "string"
          ? ((body as { saveRoot: string }).saveRoot.trim() || null)
          : undefined,
      });
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/status") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        ffmpegBin: FFMPEG_BIN,
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
        geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
        openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        edgeTtsMode: process.env.EDGE_TTS_MODE === "edge-first" ? "edge-first" : "fallback-first",
        r2Configured: isR2Configured(),
        databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
        databaseWriteHealth: getPgWriteHealth(),
        readyVoices: VOICE_OPTIONS.filter((v) => v.status === "ready").map((v) => v.label),
      });
      return;
    }

    const settingsTestMatch = url.pathname.match(/^\/api\/settings\/test\/(ai|openai|tts|ffmpeg|storage)$/);
    if (req.method === "POST" && settingsTestMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const target = settingsTestMatch[1];
      try {
        if (target === "ai") {
          if (!process.env.GEMINI_API_KEY?.trim()) {
            sendJson(res, 200, { ok: false, message: "Chưa cấu hình GEMINI_API_KEY trong .env.local — kịch bản AI sẽ không tạo được." });
            return;
          }
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
          const started = Date.now();
          await ai.models.generateContent({ model, contents: "Reply with exactly one word: OK" });
          sendJson(res, 200, { ok: true, message: `Gemini (${model}) phản hồi thật sau ${Date.now() - started}ms.` });
          return;
        }
        if (target === "openai") {
          if (!process.env.OPENAI_API_KEY?.trim()) {
            sendJson(res, 200, { ok: false, message: "Chưa cấu hình OPENAI_API_KEY trong .env.local — chưa dùng được ChatGPT để viết kịch bản." });
            return;
          }
          const { default: OpenAI } = await import("openai");
          const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
          const started = Date.now();
          await client.chat.completions.create({ model, messages: [{ role: "user", content: "Reply with exactly one word: OK" }] });
          sendJson(res, 200, { ok: true, message: `ChatGPT (${model}) phản hồi thật sau ${Date.now() - started}ms.` });
          return;
        }
        if (target === "tts") {
          const voice = VOICE_OPTIONS.find((v) => v.status === "ready");
          if (!voice) {
            sendJson(res, 200, { ok: false, message: "Không có giọng nào ở trạng thái sẵn sàng." });
            return;
          }
          const previewDir = resolve("storage", "voice-previews");
          await mkdir(previewDir, { recursive: true });
          const testPath = join(previewDir, `healthcheck-${Date.now()}.mp3`);
          const started = Date.now();
          const client = createTtsClient(loadConfig(), { provider: "edge", voiceName: voice.runtimeVoiceName, speed: 1 });
          await client.generate("Test", testPath);
          const info = await stat(testPath).catch(() => null);
          void rm(testPath, { force: true }).catch(() => undefined);
          if (!info?.isFile() || info.size === 0) {
            sendJson(res, 200, { ok: false, message: "TTS chạy nhưng không tạo ra file audio." });
            return;
          }
          sendJson(res, 200, { ok: true, message: `Tạo được ${info.size} bytes audio thật (${voice.label}) sau ${Date.now() - started}ms.` });
          return;
        }
        if (target === "ffmpeg") {
          try {
            const version = await new Promise<string>((resolveVersion, rejectVersion) => {
              const proc = spawn(FFMPEG_BIN, ["-version"]);
              let out = "";
              proc.stdout.on("data", (d) => (out += d.toString()));
              proc.on("error", rejectVersion);
              proc.on("close", (code) => (code === 0 ? resolveVersion(out) : rejectVersion(new Error(`exit ${code}`))));
            });
            const firstLine = version.split("\n")[0]?.trim() || "ffmpeg";
            sendJson(res, 200, { ok: true, message: `${firstLine} (${FFMPEG_BIN})` });
          } catch (error) {
            sendJson(res, 200, { ok: false, message: `Không chạy được ffmpeg tại ${FFMPEG_BIN}: ${error instanceof Error ? error.message : String(error)}` });
          }
          return;
        }
        if (target === "storage") {
          const testFile = resolve(STORAGE_DIR, `.write-test-${Date.now()}`);
          await mkdir(STORAGE_DIR, { recursive: true });
          await writeFile(testFile, "ok", "utf8");
          await rm(testFile, { force: true });
          sendJson(res, 200, { ok: true, message: `Ghi/xóa file thử thành công tại ${STORAGE_DIR}.` });
          return;
        }
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        projects: listProjects(user.email).map((project) => ({
          ...project,
          latestJob: getLatestJobForProject(project.id),
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      await handleCreateProject(req, res);
      return;
    }

    const renderMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/render$/);
    if (req.method === "POST" && renderMatch) {
      await handleStartProjectRender(req, res, renderMatch[1]);
      return;
    }

    const audioMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/audio$/);
    if (req.method === "POST" && audioMatch) {
      await handleStartProjectAudio(req, res, audioMatch[1]);
      return;
    }

    const generateScriptMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generate-script$/);
    if (req.method === "POST" && generateScriptMatch) {
      await handleGenerateProjectScript(req, res, generateScriptMatch[1]);
      return;
    }

    const applyTemplateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/apply-template$/);
    if (req.method === "POST" && applyTemplateMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, applyTemplateMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody(req);
      const templateId = String((body as { templateId?: unknown }).templateId || "");
      const template = TEMPLATE_PRESETS.find((item) => item.id === templateId);
      if (!template) {
        sendJson(res, 404, { error: "Template not found" });
        return;
      }
      const nextTopic = project.topic.includes(template.name)
        ? project.topic
        : `${project.topic}\n\nTemplate: ${template.name}. ${template.description}`;
      updateProject(project.id, { topic: nextTopic });
      sendJson(res, 200, { ok: true, template, project: getProject(project.id) });
      return;
    }

    const projectHistoryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/history$/);
    if (req.method === "GET" && projectHistoryMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, projectHistoryMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const latestJob = getLatestJobForProject(project.id);
      const items = [
        { type: "project", label: "Tao/cap nhat project", at: project.updated_at, detail: project.status },
        ...listScenes(project.id).map((scene) => ({ type: "scene", label: `Scene ${scene.scene_order + 1}`, at: scene.updated_at, detail: scene.voice_text.slice(0, 120) })),
        ...listAssets(project.id).map((asset) => ({ type: "asset", label: asset.file_name, at: asset.created_at, detail: `${asset.type} - ${asset.file_size} bytes` })),
        ...(latestJob ? [{ type: "job", label: "Render/voice job gan nhat", at: latestJob.updated_at, detail: `${latestJob.status} ${latestJob.progress}%` }] : []),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      sendJson(res, 200, { history: items });
      return;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "GET" && projectMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, projectMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      sendJson(res, 200, {
        project,
        latestJob: getLatestJobForProject(project.id),
        assets: listAssets(project.id),
        scenes: listScenes(project.id),
      });
      return;
    }

    if (req.method === "PUT" && projectMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, projectMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody(req);
      const selectedVoice = typeof (body as { voiceId?: unknown }).voiceId === "string"
        ? findVoiceOption((body as { voiceId: string }).voiceId)
        : undefined;
      const ratio = typeof (body as { ratio?: unknown }).ratio === "string" && ["16:9", "9:16", "1:1"].includes((body as { ratio: string }).ratio)
        ? (body as { ratio: string }).ratio
        : undefined;
      const durationSecRaw = Number((body as { durationSec?: unknown }).durationSec);
      updateProject(project.id, {
        title: typeof (body as { title?: unknown }).title === "string" ? (body as { title: string }).title.trim() : undefined,
        topic: typeof (body as { topic?: unknown }).topic === "string" ? (body as { topic: string }).topic.trim() : undefined,
        voice_id: selectedVoice?.status === "ready" ? selectedVoice.id : undefined,
        voice_name: selectedVoice?.status === "ready" ? selectedVoice.runtimeVoiceName : undefined,
        voice_speed: typeof (body as { voiceSpeed?: unknown }).voiceSpeed === "number" ? (body as { voiceSpeed: number }).voiceSpeed : undefined,
        aspect_ratio: ratio,
        target_duration_sec: Number.isFinite(durationSecRaw) && durationSecRaw > 0 ? Math.round(durationSecRaw) : undefined,
      });
      sendJson(res, 200, { ok: true, project: getProject(project.id) });
      return;
    }

    const scenesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/scenes$/);
    if (req.method === "GET" && scenesMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, scenesMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      sendJson(res, 200, { scenes: listScenes(project.id) });
      return;
    }

    if (req.method === "POST" && scenesMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, scenesMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody(req);
      const voiceText = (body as { voiceText?: string }).voiceText?.trim();
      if (!voiceText) {
        sendJson(res, 400, { error: "Missing voiceText" });
        return;
      }
      const scene = addProjectScene(project.id, { voiceText });
      sendJson(res, 201, { ok: true, scene });
      return;
    }

    const sceneMatch = url.pathname.match(/^\/api\/scenes\/([^/]+)$/);
    if (req.method === "PUT" && sceneMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const scene = getScene(sceneMatch[1]);
      if (!scene) {
        sendJson(res, 404, { error: "Scene not found" });
        return;
      }
      const project = getUserProject(user.email, scene.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Scene does not belong to the current user" });
        return;
      }
      const body = await readJsonBody(req);
      const updated = updateScene(sceneMatch[1], {
        voice_text: typeof (body as { voiceText?: unknown }).voiceText === "string" ? (body as { voiceText: string }).voiceText : undefined,
        source_asset_id: typeof (body as { sourceAssetId?: unknown }).sourceAssetId === "string" ? (body as { sourceAssetId: string }).sourceAssetId : undefined,
        source_start: typeof (body as { sourceStart?: unknown }).sourceStart === "number" ? (body as { sourceStart: number }).sourceStart : undefined,
        source_end: typeof (body as { sourceEnd?: unknown }).sourceEnd === "number" ? (body as { sourceEnd: number }).sourceEnd : undefined,
      });
      sendJson(res, 200, { ok: true, scene: updated });
      return;
    }

    const sceneMoveMatch = url.pathname.match(/^\/api\/scenes\/([^/]+)\/move$/);
    if (req.method === "POST" && sceneMoveMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const scene = getScene(sceneMoveMatch[1]);
      if (!scene) {
        sendJson(res, 404, { error: "Scene not found" });
        return;
      }
      const project = getUserProject(user.email, scene.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Scene does not belong to the current user" });
        return;
      }
      const body = await readJsonBody(req);
      const direction = (body as { direction?: string }).direction === "down" ? "down" : "up";
      const moved = moveScene(scene.id, direction);
      sendJson(res, 200, { ok: true, scene: moved, scenes: listScenes(project.id) });
      return;
    }

    if (req.method === "DELETE" && sceneMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const scene = getScene(sceneMatch[1]);
      if (!scene) {
        sendJson(res, 404, { error: "Scene not found" });
        return;
      }
      const project = getUserProject(user.email, scene.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Scene does not belong to the current user" });
        return;
      }
      const deleted = deleteScene(sceneMatch[1]);
      sendJson(res, 200, { ok: true, scene: deleted });
      return;
    }

    const timelineMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, timelineMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      sendJson(res, 200, { tracks: listTracks(project.id), clips: listClips(project.id) });
      return;
    }

    const timelineTracksMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline\/tracks$/);
    if (req.method === "POST" && timelineTracksMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, timelineTracksMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody(req);
      const type = (body as { type?: string }).type;
      const label = (body as { label?: string }).label?.trim();
      const validTypes: TimelineTrackType[] = ["video", "overlay", "text", "subtitle", "voice", "music", "sfx", "transition", "effect", "marker"];
      if (!type || !validTypes.includes(type as TimelineTrackType) || !label) {
        sendJson(res, 400, { error: "Missing or invalid type/label" });
        return;
      }
      const track = addTrack(project.id, type as TimelineTrackType, label);
      sendJson(res, 201, { ok: true, track });
      return;
    }

    const timelineTrackMatch = url.pathname.match(/^\/api\/timeline-tracks\/([^/]+)$/);
    if (req.method === "PUT" && timelineTrackMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const track = getTrack(timelineTrackMatch[1]);
      if (!track) {
        sendJson(res, 404, { error: "Track not found" });
        return;
      }
      const project = getUserProject(user.email, track.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Track does not belong to the current user" });
        return;
      }
      const body = await readJsonBody(req);
      const trackNumberField = (key: string) => (typeof (body as Record<string, unknown>)[key] === "number" ? (body as Record<string, number>)[key] : undefined);
      const trackStringField = (key: string) => (typeof (body as Record<string, unknown>)[key] === "string" ? (body as Record<string, string>)[key] : undefined);
      const updated = updateTrack(track.id, {
        label: typeof (body as { label?: unknown }).label === "string" ? (body as { label: string }).label : undefined,
        muted: typeof (body as { muted?: unknown }).muted === "boolean" ? ((body as { muted: boolean }).muted ? 1 : 0) : undefined,
        locked: typeof (body as { locked?: unknown }).locked === "boolean" ? ((body as { locked: boolean }).locked ? 1 : 0) : undefined,
        sub_pos_x: trackNumberField("subPosX"),
        sub_pos_y: trackNumberField("subPosY"),
        sub_width_pct: trackNumberField("subWidthPct"),
        sub_font_size: trackNumberField("subFontSize"),
        sub_color: trackStringField("subColor"),
        sub_bg_color: trackStringField("subBgColor"),
        sub_font_family: trackStringField("subFontFamily"),
      });
      sendJson(res, 200, { ok: true, track: updated });
      return;
    }

    if (req.method === "DELETE" && timelineTrackMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const track = getTrack(timelineTrackMatch[1]);
      if (!track) {
        sendJson(res, 404, { error: "Track not found" });
        return;
      }
      const project = getUserProject(user.email, track.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Track does not belong to the current user" });
        return;
      }
      const deleted = deleteTrack(track.id);
      sendJson(res, 200, { ok: true, track: deleted });
      return;
    }

    const timelineClipsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline\/clips$/);
    if (req.method === "POST" && timelineClipsMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, timelineClipsMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const body = await readJsonBody(req) as Record<string, unknown>;
      const trackId = typeof body.trackId === "string" ? body.trackId : undefined;
      const label = typeof body.label === "string" ? body.label : undefined;
      const startTime = typeof body.startTime === "number" ? body.startTime : undefined;
      const duration = typeof body.duration === "number" ? body.duration : undefined;
      if (!trackId || !label || startTime === undefined || duration === undefined) {
        sendJson(res, 400, { error: "Missing trackId/label/startTime/duration" });
        return;
      }
      const track = getTrack(trackId);
      if (!track || track.project_id !== project.id) {
        sendJson(res, 404, { error: "Track not found" });
        return;
      }
      const clip = createClip({
        projectId: project.id,
        trackId,
        sceneId: typeof body.sceneId === "string" ? body.sceneId : undefined,
        sourceAssetId: typeof body.sourceAssetId === "string" ? body.sourceAssetId : undefined,
        label,
        textContent: typeof body.textContent === "string" ? body.textContent : undefined,
        startTime,
        duration,
        trimIn: typeof body.trimIn === "number" ? body.trimIn : undefined,
        trimOut: typeof body.trimOut === "number" ? body.trimOut : undefined,
      });
      sendJson(res, 201, { ok: true, clip });
      return;
    }

    const timelineClipMatch = url.pathname.match(/^\/api\/timeline-clips\/([^/]+)$/);
    if (req.method === "PUT" && timelineClipMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const clip = getClip(timelineClipMatch[1]);
      if (!clip) {
        sendJson(res, 404, { error: "Clip not found" });
        return;
      }
      const project = getUserProject(user.email, clip.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Clip does not belong to the current user" });
        return;
      }
      const body = await readJsonBody(req) as Record<string, unknown>;
      if (typeof body.trackId === "string") {
        const targetTrack = getTrack(body.trackId);
        if (!targetTrack || targetTrack.project_id !== project.id) {
          sendJson(res, 400, { error: "Invalid trackId" });
          return;
        }
      }
      const numberField = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : undefined);
      const stringField = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
      const updated = updateClip(clip.id, {
        track_id: stringField("trackId"),
        label: stringField("label"),
        text_content: stringField("textContent"),
        source_asset_id: stringField("sourceAssetId"),
        start_time: numberField("startTime"),
        duration: numberField("duration"),
        trim_in: numberField("trimIn"),
        trim_out: numberField("trimOut"),
        pos_x: numberField("posX"),
        pos_y: numberField("posY"),
        scale: numberField("scale"),
        rotation: numberField("rotation"),
        opacity: numberField("opacity"),
        volume: numberField("volume"),
        speed: numberField("speed"),
        animation: stringField("animation"),
        sub_font_size: numberField("subFontSize"),
        sub_color: stringField("subColor"),
        sub_font_family: stringField("subFontFamily"),
      });
      sendJson(res, 200, { ok: true, clip: updated });
      return;
    }

    if (req.method === "DELETE" && timelineClipMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const clip = getClip(timelineClipMatch[1]);
      if (!clip) {
        sendJson(res, 404, { error: "Clip not found" });
        return;
      }
      const project = getUserProject(user.email, clip.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Clip does not belong to the current user" });
        return;
      }
      const deleted = deleteClip(clip.id);
      sendJson(res, 200, { ok: true, clip: deleted });
      return;
    }

    const timelineRenderMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline\/render$/);
    if (req.method === "POST" && timelineRenderMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, timelineRenderMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      const runningJob = getLatestJobForProject(project.id);
      if (runningJob && (runningJob.status === "queued" || runningJob.status === "running")) {
        sendJson(res, 409, { error: "Project already has a running job", job: runningJob });
        return;
      }
      const clips = listClips(project.id);
      if (clips.length === 0) {
        sendJson(res, 400, { error: "Timeline is empty — add at least one clip before rendering" });
        return;
      }
      const job = createRenderJob(project.id);
      startTimelineRenderJob(project.id, job.id);
      sendJson(res, 202, { ok: true, project, job });
      return;
    }

    const timelineClipSplitMatch = url.pathname.match(/^\/api\/timeline-clips\/([^/]+)\/split$/);
    if (req.method === "POST" && timelineClipSplitMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const clip = getClip(timelineClipSplitMatch[1]);
      if (!clip) {
        sendJson(res, 404, { error: "Clip not found" });
        return;
      }
      const project = getUserProject(user.email, clip.project_id);
      if (!project) {
        sendJson(res, 403, { error: "Clip does not belong to the current user" });
        return;
      }
      const body = await readJsonBody(req);
      const atTime = (body as { atTime?: unknown }).atTime;
      if (typeof atTime !== "number") {
        sendJson(res, 400, { error: "Missing atTime" });
        return;
      }
      const result = splitClip(clip.id, atTime);
      if (!result) {
        sendJson(res, 400, { error: "Split point must be inside the clip" });
        return;
      }
      sendJson(res, 200, { ok: true, left: result.left, right: result.right });
      return;
    }

    const sfxMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sfx$/);
    if (req.method === "POST" && sfxMatch) {
      await handleCreatePresetSfx(req, res, sfxMatch[1]);
      return;
    }

    const directAssetUploadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/direct-upload$/);
    if (req.method === "POST" && directAssetUploadMatch) {
      await handleCreateDirectAssetUpload(req, res, directAssetUploadMatch[1]);
      return;
    }

    const confirmAssetUploadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/confirm-upload$/);
    if (req.method === "POST" && confirmAssetUploadMatch) {
      await handleConfirmDirectAssetUpload(req, res, confirmAssetUploadMatch[1]);
      return;
    }

    const assetsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
    if (req.method === "GET" && assetsMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const project = getUserProject(user.email, assetsMatch[1]);
      if (!project) {
        sendJson(res, 404, { error: "Project not found" });
        return;
      }
      sendJson(res, 200, { assets: listAssets(project.id) });
      return;
    }

    if (req.method === "POST" && assetsMatch) {
      await handleUploadAsset(req, res, assetsMatch[1]);
      return;
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === "DELETE" && assetMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const asset = getAsset(assetMatch[1]);
      if (!asset) {
        sendJson(res, 404, { error: "Asset not found" });
        return;
      }
      if (!getUserProject(user.email, asset.project_id)) {
        sendJson(res, 403, { error: "Asset does not belong to the current user" });
        return;
      }
      const deleted = deleteAsset(asset.id);
      if (deleted?.file_path.startsWith("r2://")) {
        try {
          await deleteR2Object(deleted.file_path);
        } catch (error) {
          console.warn(`Failed to delete R2 object for asset ${deleted.id}:`, error);
        }
      }
      sendJson(res, 200, { ok: true, asset: deleted });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/render-jobs") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { jobs: listRenderJobsForOwner(user.email) });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/render-jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const job = getRenderJob(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "Render job not found" });
        return;
      }
      if (!getUserProject(user.email, job.project_id)) {
        sendJson(res, 403, { error: "Render job does not belong to the current user" });
        return;
      }
      sendJson(res, 200, jobResponse(job.project_id, job.id));
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/render-jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const job = getRenderJob(cancelMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "Render job not found" });
        return;
      }
      if (!getUserProject(user.email, job.project_id)) {
        sendJson(res, 403, { error: "Render job does not belong to the current user" });
        return;
      }
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        sendJson(res, 409, { error: "Job is not cancellable", job });
        return;
      }
      updateRenderJob(job.id, {
        status: "cancelled",
        current_step: "Cancelled",
        finished_at: new Date().toISOString(),
      });
      updateProject(job.project_id, {
        status: "failed",
        error_message: "Render cancelled",
      });
      sendJson(res, 200, jobResponse(job.project_id, job.id));
      return;
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      await sendStatic(res, url.pathname);
      return;
    }

    if (req.method === "POST" && (url.pathname === "/create-video" || url.pathname === "/generate-script")) {
      if (url.pathname === "/generate-script") {
        const body = await readJsonBody(req);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(res, 400, { error: 'Missing "prompt" in JSON body' });
          return;
        }
        const selectedVoice = findVoiceOption(body.voiceId ?? body.voiceName);
        if (selectedVoice.status !== "ready") {
          sendJson(res, 400, {
            error: "Voice preset is not ready",
            voice: selectedVoice,
            nextStep: "Enable an OmniVoice / voice-clone API before using this preset.",
          });
          return;
        }
        const generated = await generateScriptFromPrompt(prompt, {
          voiceProvider: selectedVoice.provider,
          voiceName: selectedVoice.runtimeVoiceName,
          voiceSpeed: body.voiceSpeed,
        });
        sendJson(res, 200, {
          ok: true,
          rendered: false,
          title: generated.script.metadata.title,
          paths: { outputDir: resolve(generated.outputDir), scriptJson: resolve(generated.scriptPath) },
          scenes: generated.script.scenes.length,
        });
        return;
      }

      await handleCreateVideo(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
}

const DEFAULT_VOICE_PREVIEW_TEXT = "Xin chào, đây là giọng đọc thử trong AI Video Studio.";

/** Pre-generates the default demo-phrase preview for every ready voice at
 *  startup, so the very first "nghe thử giọng" click a user makes is
 *  already served from cache instead of waiting on a live TTS call. */
async function warmVoicePreviewCache() {
  const previewDir = resolve("storage", "voice-previews");
  await mkdir(previewDir, { recursive: true });
  const textHash = createHash("sha1").update(DEFAULT_VOICE_PREVIEW_TEXT).digest("hex").slice(0, 16);
  for (const voice of VOICE_OPTIONS) {
    if (voice.status !== "ready") continue;
    const previewPath = join(previewDir, `${voice.id}-1-${textHash}.mp3`);
    if (existsSync(previewPath)) continue;
    try {
      const client = createTtsClient(loadConfig(), { provider: "edge", voiceName: voice.runtimeVoiceName, speed: 1 });
      await client.generate(DEFAULT_VOICE_PREVIEW_TEXT, previewPath);
      console.log(`Warmed voice preview cache: ${voice.label}`);
    } catch (error) {
      console.log(`Voice preview warmup skipped for ${voice.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

createServer((req, res) => {
  void handleRequest(req, res);
}).listen(PORT, () => {
  console.log(`AI video API listening on http://127.0.0.1:${PORT}`);
  console.log("POST /create-video with JSON body: { \"prompt\": \"...\" }");
  void warmVoicePreviewCache();
});
