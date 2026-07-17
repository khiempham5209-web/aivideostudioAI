import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import dotenv from "dotenv";
import { generateScriptFromPrompt } from "./agent/prompt-to-script.js";
import { runTemplatePipeline } from "./render/template-pipeline.js";
import { findVoiceOption, VOICE_OPTIONS } from "./tts/voice-catalog.js";
import { toSlug } from "./utils/slug.js";
import { FFMPEG_BIN } from "./utils/binaries.js";
import {
  createProject,
  createSession,
  addProjectScene,
  createAsset,
  createRenderJob,
  deleteSession,
  deleteScene,
  getUserSettings,
  getSession,
  getScene,
  getLatestJobForProject,
  getProject,
  getStats,
  getUserProject,
  getRenderJob,
  isUserFile,
  listUserStoragePaths,
  listProjects,
  listAssets,
  listScenes,
  moveScene,
  replaceProjectScenes,
  updateScene,
  updateProject,
  updateRenderJob,
  updateUserSettings,
  upsertUser,
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
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

interface CreateVideoBody {
  prompt?: string;
  projectName?: string;
  render?: boolean;
  voiceId?: string;
  voiceName?: string;
  voiceSpeed?: number;
  folderName?: string;
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

function isAllowedFilePath(pathname: string, extraRoots: string[] = []): boolean {
  const target = resolve(pathname).toLowerCase();
  const allowedRoots = [resolve("output").toLowerCase(), resolve("storage").toLowerCase(), ...extraRoots.map((root) => resolve(root).toLowerCase())];
  return allowedRoots.some((root) => target === root || target.startsWith(`${root}\\`));
}

async function sendFileByPath(res: ServerResponse, pathname: string, headOnly = false, extraRoots: string[] = []) {
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
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": info.size,
      "Content-Disposition": `inline; filename="${filePath.split(/[\\/]/).pop() ?? "file"}"`,
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
  const asset = createAsset({
    projectId,
    type,
    fileName: file.fileName,
    mimeType: file.mimeType,
    filePath,
    fileSize: file.buffer.length,
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
  const asset = createAsset({
    projectId,
    type: "audio",
    fileName: spec.label,
    mimeType: "audio/mpeg",
    filePath,
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

async function generateProjectScript(project: NonNullable<ReturnType<typeof getProject>>) {
  try {
    return await generateScriptFromPrompt(project.topic, {
      voiceProvider: "edge",
      voiceName: project.voice_name,
      voiceSpeed: project.voice_speed,
    });
  } catch {
    return buildLocalProjectScript(project);
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
  const baseFolder = requestedFolder || toSlug(project.title || project.topic || "video");
  const outputDir = resolve("output", `${baseFolder}-${timestampForPath()}`);
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
    aspect: getUserSettings(project.owner_email).default_ratio || "9:16",
    scenes: scriptScenes,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(scriptPath, JSON.stringify(script, null, 2), "utf8");
  return { outputDir, scriptPath };
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

function startRenderJob(projectId: string, jobId: string, folderName?: string) {
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
      const footagePlan = Object.fromEntries(
        scenes
          .map((scene, index) => {
            const asset = assets.find((item) => item.id === scene.source_asset_id && item.type === "video");
            if (!asset) return null;
            const sceneId = scene.scene_key || `scene-${index + 1}`;
            return [sceneId, { path: asset.file_path, startSec: scene.source_start, endSec: scene.source_end }];
          })
          .filter(Boolean) as Array<[string, { path: string; startSec: number | null; endSec: number | null }]>,
      );
      const hasVideoAssets = assets.some((asset) => asset.type === "video");
      const backgroundAudio = assets.find((asset) => asset.type === "audio");
      await runTemplatePipeline(generated.scriptPath, {
        footageDir: hasVideoAssets ? resolve(STORAGE_DIR, projectId, "source") : undefined,
        footagePlan,
        backgroundAudioPath: backgroundAudio?.file_path ?? undefined,
      });
      if (isCancelled()) return;

      const paths = await copyResultToSaveRoot(project.owner_email, projectId, resultPaths(generated.outputDir));
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
      const assets = listAssets(projectId);
      const backgroundAudio = assets.find((asset) => asset.type === "audio");
      await runTemplatePipeline(generated.scriptPath, {
        backgroundAudioPath: backgroundAudio?.file_path ?? undefined,
        audioOnly: true,
      });
      if (isCancelled()) return;
      const paths = await copyResultToSaveRoot(project.owner_email, projectId, resultPaths(generated.outputDir));
      const audioInfo = await stat(paths.audio).catch(() => null);
      if (audioInfo?.isFile()) {
        createAsset({
          projectId,
          type: "audio",
          fileName: `voice-${timestampForPath()}.mp3`,
          mimeType: "audio/mpeg",
          filePath: paths.audio,
          fileSize: audioInfo.size,
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
  const project = createProject({
    ownerEmail: user.email,
    topic: prompt,
    voiceId: selectedVoice.id,
    voiceName: selectedVoice.runtimeVoiceName,
    voiceSpeed: body.voiceSpeed ?? 1,
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
  const job = createRenderJob(projectId);
  startRenderJob(projectId, job.id, folderName);
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
  updateProject(projectId, { status: "generating_script", error_message: null });
  const generated = await generateProjectScript(project);
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
  const state = randomBytes(16).toString("hex");
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
  if (!code || !state || state !== expectedState) {
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
  const user = upsertUser({ email, name: email.split("@")[0], picture: null, provider: "dev" });
  const session = createSession(user.email);
  setCookie(res, SESSION_COOKIE, session.id);
  sendJson(res, 200, { ok: true, user });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
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

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/files") {
      const user = requireUser(req, res);
      if (!user) return;
      const path = url.searchParams.get("path");
      if (!path) {
        sendJson(res, 400, { error: "Missing path" });
        return;
      }
      const resolvedPath = resolve(path);
      if (!isUserFile(user.email, resolvedPath)) {
        sendJson(res, 403, { error: "File does not belong to the current user" });
        return;
      }
      const settings = getUserSettings(user.email);
      const extraRoots = settings.save_root ? [settings.save_root] : [];
      await sendFileByPath(res, resolvedPath, req.method === "HEAD", extraRoots);
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
          ? Math.min(1.25, Math.max(0.85, (body as { uiScale: number }).uiScale))
          : undefined,
        storage_mode: typeof (body as { storageMode?: unknown }).storageMode === "string" ? (body as { storageMode: string }).storageMode : undefined,
        save_root: typeof (body as { saveRoot?: unknown }).saveRoot === "string"
          ? ((body as { saveRoot: string }).saveRoot.trim() || null)
          : undefined,
      });
      sendJson(res, 200, { ok: true, settings });
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
      updateProject(project.id, {
        title: typeof (body as { title?: unknown }).title === "string" ? (body as { title: string }).title.trim() : undefined,
        topic: typeof (body as { topic?: unknown }).topic === "string" ? (body as { topic: string }).topic.trim() : undefined,
        voice_id: selectedVoice?.status === "ready" ? selectedVoice.id : undefined,
        voice_name: selectedVoice?.status === "ready" ? selectedVoice.runtimeVoiceName : undefined,
        voice_speed: typeof (body as { voiceSpeed?: unknown }).voiceSpeed === "number" ? (body as { voiceSpeed: number }).voiceSpeed : undefined,
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

    const sfxMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sfx$/);
    if (req.method === "POST" && sfxMatch) {
      await handleCreatePresetSfx(req, res, sfxMatch[1]);
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

createServer((req, res) => {
  void handleRequest(req, res);
}).listen(PORT, () => {
  console.log(`AI video API listening on http://127.0.0.1:${PORT}`);
  console.log("POST /create-video with JSON body: { \"prompt\": \"...\" }");
});
