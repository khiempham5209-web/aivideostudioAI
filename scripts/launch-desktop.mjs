// Desktop launcher: starts the server hidden (no console window) and opens
// the app in the default browser once it's ready. Meant to be invoked via
// scripts/hidden-launch.vbs, which suppresses the console window; running
// this script directly with `node` will still show a console.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOG_DIR = join(ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "desktop-launcher.log");

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

async function isServerUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
  const child = spawn(process.execPath, [distEntry], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const ready = await waitForServer(port, 30000);
  if (!ready) {
    log("ERROR: server did not become ready within 30s");
    return;
  }
  log("Server ready — opening browser");
  openBrowser(url);
}

main().catch((error) => log(`ERROR: ${error?.stack || error}`));
