// Desktop launcher: starts the server hidden (no console window) and opens
// the app in the default browser once it's ready. Meant to be invoked via
// scripts/hidden-launch.vbs, which suppresses the console window; running
// this script directly with `node` will still show a console.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, openSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_BACKEND_URL = "https://aivideostudioaibackend.onrender.com";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOG_DIR = join(ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "desktop-launcher.log");
// The server itself used to run with stdio: "ignore" — every console.log/
// console.warn from api.ts (including error detail from TTS/render
// failures) vanished with no way to see it after the fact, since the
// hidden-launch.vbs path shows no console window either. Redirecting to a
// plain file here means a real diagnosis is possible after something goes
// wrong instead of having to blind-guess or manually reproduce.
const SERVER_LOG_FILE = join(LOG_DIR, "server.log");

function log(message) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // best-effort logging only — nothing to show the user if this fails
  }
}

function readPort() {
  const envPath = join(ROOT, ".env.local");
  if (existsSync(envPath)) {
    try {
      const text = readFileSync(envPath, "utf8");
      const match = text.match(/^API_PORT=(\d+)/m);
      if (match) return Number(match[1]);
    } catch {
      // fall through to default
    }
  }
  return 8787;
}

function readEnvValue(key) {
  const envPath = join(ROOT, ".env.local");
  if (!existsSync(envPath)) return "";
  try {
    const text = readFileSync(envPath, "utf8");
    const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

/** Silently pulls the latest config from the account this device was
 *  originally connected to (see /api/desktop/provision-config and
 *  /api/desktop/receive-config in api.ts) and rewrites .env.local — so
 *  the user never has to redo the interactive "Kết nối" browser handshake
 *  just because a new field (e.g. R2 keys) got added later. Best-effort:
 *  if production is asleep/unreachable, silently keeps the existing config
 *  instead of blocking startup — Render's free tier can take ~50s to wake
 *  from a cold start, and the app should still open instantly either way. */
async function autoSyncConfig() {
  const token = readEnvValue("DEVICE_SYNC_TOKEN");
  if (!token) return;
  try {
    const res = await fetch(`${PRODUCTION_BACKEND_URL}/api/desktop/sync-config?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log(`Auto-sync skipped: server responded HTTP ${res.status}`);
      return;
    }
    const config = await res.json();
    const str = (key) => (typeof config[key] === "string" ? config[key] : "");
    const port = readPort();
    const lines = [
      "APP_ENV=development",
      "NODE_ENV=development",
      `API_PORT=${port}`,
      "ALLOW_DEV_LOGIN=true",
      `ALLOWED_EMAILS=${str("allowedEmails")}`,
      `APP_PUBLIC_URL=http://127.0.0.1:${port}`,
      `GEMINI_API_KEY=${str("geminiApiKey")}`,
      `GEMINI_MODEL=${str("geminiModel") || "gemini-2.5-flash"}`,
      `OPENAI_API_KEY=${str("openaiApiKey")}`,
      `OPENAI_MODEL=${str("openaiModel") || "gpt-4o-mini"}`,
      `DATABASE_URL=${str("databaseUrl")}`,
      `EDGE_TTS_MODE=${str("edgeTtsMode") || "edge-first"}`,
      `TTS_VOICE_NAME=${str("ttsVoiceName")}`,
      `TTS_SPEED=${str("ttsSpeed")}`,
      `CHANNEL_NAME=${str("channelName")}`,
      `PRODUCT_SHEET_SYNC_URL=${str("productSheetSyncUrl")}`,
      `PRODUCT_SHEET_SECRET=${str("productSheetSecret")}`,
      `R2_ACCOUNT_ID=${str("r2AccountId")}`,
      `R2_ACCESS_KEY_ID=${str("r2AccessKeyId")}`,
      `R2_SECRET_ACCESS_KEY=${str("r2SecretAccessKey")}`,
      `R2_BUCKET=${str("r2Bucket")}`,
      `R2_PUBLIC_BASE_URL=${str("r2PublicBaseUrl")}`,
      `PEXELS_API_KEY=${str("pexelsApiKey")}`,
      `DEVICE_SYNC_TOKEN=${token}`,
      "",
    ].join("\n");
    writeFileSync(join(ROOT, ".env.local"), lines, "utf8");
    log("Auto-sync: .env.local refreshed from account.");
  } catch (error) {
    log(`Auto-sync skipped (production unreachable, likely asleep): ${error?.message || error}`);
  }
}

async function isServerUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  // The Electron wrapper (desktop/electron-main.cjs) spawns this same
  // launcher to start the server, then opens its own native window instead
  // of an Edge one — skip Edge entirely in that case so the user doesn't
  // get two windows.
  if (process.env.SKIP_OPEN_BROWSER === "true") {
    log("SKIP_OPEN_BROWSER set — not opening a browser window (Electron will open its own)");
    return;
  }
  // Edge's --app= mode strips the address bar/tabs/bookmarks bar, so the
  // window reads as a standalone desktop app instead of "a browser tab" —
  // no Electron rewrite needed for that. msedge.exe is registered as a
  // Windows App Path on virtually every install; fall back to the plain
  // default-browser open (full browser chrome) if that resolution fails.
  //
  // --app= only actually produces a chrome-less window when it starts a
  // NEW browser process. If the user already has any Edge window open
  // (the common case — this isn't their only browser tab of the day),
  // Chromium forwards the request to that existing process instead of
  // spawning a new one, and it just opens as an ordinary tab there,
  // address bar and all. A dedicated --user-data-dir forces a genuinely
  // separate process every time, so --app= always gets honored regardless
  // of what else the user has open in their regular Edge profile.
  const appProfileDir = join(ROOT, "edge-app-profile");
  const edge = spawn(
    "cmd",
    ["/c", "start", "", "msedge", `--user-data-dir=${appProfileDir}`, "--new-window", `--app=${url}`],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  edge.on("error", () => {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  });
  edge.unref();
}

async function waitForServer(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const port = readPort();
  const url = `http://127.0.0.1:${port}`;
  log(`Launcher starting, target port ${port}`);

  if (await isServerUp(port)) {
    log("Server already running — opening browser only");
    openBrowser(url);
    return;
  }

  const distEntry = join(ROOT, "dist", "api.js");
  if (!existsSync(distEntry)) {
    log(`ERROR: ${distEntry} not found — run "npm run build" first`);
    return;
  }

  await autoSyncConfig();

  // Edge TTS runs through a Python virtualenv (created by
  // scripts/install-edge-tts.mjs), which isn't portable between machines —
  // it references an absolute path to whatever Python built it. On a fresh
  // install, build it against THIS machine's Python the first time the app
  // runs. Requires Python 3 to already be installed; if it's missing this
  // fails and TTS falls back to gTTS (see tts-client.ts), logged here since
  // there's no visible console to show it in.
  const venvDir = join(ROOT, ".edge-tts-venv");
  const installTtsScript = join(ROOT, "scripts", "install-edge-tts.mjs");
  if (!existsSync(venvDir) && existsSync(installTtsScript)) {
    log("First run: setting up edge-tts (needs Python 3 on this machine)...");
    try {
      const output = execFileSync(process.execPath, [installTtsScript], { cwd: ROOT, encoding: "utf8" });
      log(`edge-tts setup output:\n${output}`);
    } catch (error) {
      log(`WARNING: edge-tts setup failed (will fall back to gTTS voice): ${error?.stderr || error?.message || error}`);
    }
  }

  log(`Spawning server: node ${distEntry}`);
  // Cap the log at ~10MB by starting a fresh file instead of appending
  // forever — this process can stay running for weeks between restarts.
  try {
    if (existsSync(SERVER_LOG_FILE) && statSync(SERVER_LOG_FILE).size > 10 * 1024 * 1024) {
      writeFileSync(SERVER_LOG_FILE, "", "utf8");
    }
  } catch {
    // best-effort — an oversized log is better than a launch failure
  }
  const serverLogFd = openSync(SERVER_LOG_FILE, "a");
  // Detached+unref only makes sense when THIS launcher is itself a
  // short-lived process meant to exit immediately (the old wscript path) —
  // the server needs to keep running after its own parent is gone. Under
  // Electron (SKIP_OPEN_BROWSER=true), this launcher's own parent is the
  // long-lived Electron process, and Windows silently tears down a
  // detached+unref'd grandchild along with its intermediate parent's job
  // object membership when that parent process exits — observed directly:
  // the server logs "listening", starts warming caches, then vanishes with
  // no error the moment this script's main() returns. Keeping the child
  // attached (and keeping this whole script alive below) sidesteps that
  // entirely instead of fighting Windows job-object semantics.
  const keepAttached = process.env.SKIP_OPEN_BROWSER === "true";
  const child = spawn(process.execPath, [distEntry], {
    cwd: ROOT,
    detached: !keepAttached,
    stdio: ["ignore", serverLogFd, serverLogFd],
    windowsHide: true,
  });
  if (!keepAttached) child.unref();

  const ready = await waitForServer(port, 30000);
  if (!ready) {
    log("ERROR: server did not become ready within 30s");
    return;
  }
  log("Server ready — opening browser");
  openBrowser(url);
}

main().catch((error) => log(`ERROR: ${error?.stack || error}`));
