// Real native desktop wrapper for AI Video Studio — replaces the old
// "spawn the server, open Edge in --app= mode" approach. That still showed
// up as Microsoft Edge everywhere that matters (taskbar icon, Task
// Manager, Alt-Tab) because it was Edge, just with the address bar hidden.
// This is an actual separate process with its own icon and window chrome,
// no browser identity anywhere.
//
// It does NOT reimplement server startup — it spawns the exact same
// scripts/launch-desktop.mjs the old wscript launcher used (env var
// SKIP_OPEN_BROWSER=true tells that script not to also open a browser),
// then points its own BrowserWindow at the resulting local server. All the
// port/config/auto-sync/edge-tts-setup logic stays in one place.

const { app, BrowserWindow, Tray, Menu } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, mkdirSync, openSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

// electron-main.cjs sits at DIFFERENT depths depending on context:
// - Packaged (real usage): prepare-desktop-build.mjs copies it to the
//   staging root itself, sitting right next to dist/public/scripts/node —
//   so __dirname IS the app root.
// - Source repo (desktop/electron-main.cjs, only ever used for ad-hoc local
//   testing before packaging): one level below the actual repo root.
// Getting this wrong doesn't error loudly — every path built from it just
// silently points at the wrong place, which is exactly what happened here:
// dist/api.js resolved to .../resources/dist/api.js instead of
// .../resources/app/dist/api.js, so the server crashed on MODULE_NOT_FOUND
// on every single launch and every diagnostic log went to the wrong folder
// too, which is why none of the log-file checks ever found anything.
const ROOT = existsSync(join(__dirname, "dist", "api.js")) ? __dirname : join(__dirname, "..");

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

function isServerUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Held at module scope so the child never loses its last reference (and
// so it can be explicitly killed on app quit instead of relying on Windows
// process-tree/job-object cleanup, which is what kept silently tearing
// down the server in earlier attempts that routed through an intermediate
// launcher script — see the long comment history in git blame for exactly
// what was tried and why it didn't hold).
let serverProcess = null;

async function ensureServerRunning(port) {
  if (await isServerUp(port)) return;

  // In the SOURCE repo, the portable runtime lives at desktop/node/node.exe
  // (relative to repo root). Once staged/packaged, prepare-desktop-build.mjs
  // flattens that to a top-level node/ next to dist/public/scripts — so ROOT
  // here (which IS the staging root once packaged) needs the non-"desktop/"
  // path. Check both so this keeps working for local dev testing too.
  const packagedNode = join(ROOT, "node", "node.exe");
  const devNode = join(ROOT, "desktop", "node", "node.exe");
  const nodeExe = existsSync(packagedNode) ? packagedNode : existsSync(devNode) ? devNode : "node";

  // Goes through scripts/launch-desktop.mjs rather than spawning dist/api.js
  // directly — that script also auto-syncs .env.local (real secrets pulled
  // fresh from the account's production config via DEVICE_SYNC_TOKEN, never
  // baked into the installer) and does first-run edge-tts venv setup, and
  // skipping it silently left the packaged app with no working DB config the
  // moment a repackage wiped a .env.local that had only ever existed because
  // an earlier run's auto-sync had created it. SKIP_OPEN_BROWSER=true also
  // tells launch-desktop.mjs to keep its own server-spawn attached rather
  // than detached (see that file's own comment on this) — a detached+unref'd
  // grandchild reliably died the moment this intermediate script exited,
  // which looked exactly like a Windows job-object issue before the real
  // culprit (a wrong ROOT path here causing MODULE_NOT_FOUND) was found.
  const launcher = join(ROOT, "scripts", "launch-desktop.mjs");
  const logDir = join(ROOT, "logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort
  }
  const logPath = join(logDir, "electron-server.log");
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = "ignore";
  }

  serverProcess = spawn(nodeExe, [launcher], {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env, SKIP_OPEN_BROWSER: "true" },
  });
  serverProcess.on("error", (err) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] SPAWN ERROR: ${err?.stack || err}\n`);
    } catch {
      // best-effort
    }
  });
  serverProcess.on("exit", (code, signal) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] Server process exited: code=${code} signal=${signal}\n`);
    } catch {
      // best-effort
    }
  });

  const ready = await waitForServer(port, 5 * 60 * 1000);
  if (!ready) {
    throw new Error("Server did not become ready within 5 minutes — check logs/electron-server.log for what's stuck");
  }
}

let mainWindow;
let tray;
// Closing the window (X button) used to fully quit the app, which killed
// the server too — meaning every reopen paid the full ~10-20s startup cost
// (connect to Postgres, mirror project data) again, not just the very
// first launch. Closing now just hides the window instead; the server and
// its data stay warm in the background, so reopening is instant. Only the
// tray menu's "Thoát" (or an OS-level quit) actually shuts it down.
let isQuitting = false;

async function createWindow() {
  const port = readPort();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: "AI Video Studio",
    icon: join(__dirname, "icon.ico"),
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Matches the real app's own branding (same gradient logo, same dark
  // background with purple/cyan glow, same font stack) instead of a plain
  // generic "loading" screen — so the very first launch (the only time this
  // is ever seen now that closing the window hides instead of quitting)
  // reads as "the app is opening" rather than a separate Electron splash.
  mainWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:'Segoe UI',Arial,sans-serif;color:#f8fafc;background:
          radial-gradient(circle at 22% 8%, rgba(124,58,237,0.22), transparent 34%),
          radial-gradient(circle at 88% 14%, rgba(34,211,238,0.1), transparent 30%),
          #070a10;">
          <div style="text-align:center;">
            <div style="width:56px;height:56px;margin:0 auto 18px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#7c3aed,#ec4899);box-shadow:0 0 40px rgba(124,58,237,0.45);font-size:26px;">▶</div>
            <h1 style="font-size:20px;margin:0 0 8px;">AI Video Studio</h1>
            <p style="opacity:.65;margin:0;font-size:13px;">Đang tải dữ liệu...</p>
            <div style="width:120px;height:3px;margin:22px auto 0;border-radius:3px;background:rgba(148,163,184,0.18);overflow:hidden;">
              <div style="width:40%;height:100%;border-radius:3px;background:linear-gradient(90deg,#7c3aed,#22d3ee);animation:slide 1.1s ease-in-out infinite;"></div>
            </div>
          </div>
          <style>@keyframes slide{0%{transform:translateX(-120%)}100%{transform:translateX(340%)}}</style>
        </body>`,
      ),
  );

  try {
    await ensureServerRunning(port);
    mainWindow.loadURL(`http://127.0.0.1:${port}`);
  } catch (error) {
    mainWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="background:#0b0b0f;color:#fff;font-family:sans-serif;padding:40px;">
            <h2>Không khởi động được server</h2>
            <p>${String(error?.message || error)}</p>
            <p>Xem chi tiết trong logs/desktop-launcher.log và logs/server.log.</p>
          </body>`,
        ),
    );
  }

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(join(__dirname, "icon.ico"));
  tray.setToolTip("AI Video Studio");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Mở AI Video Studio",
        click: () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: "separator" },
      {
        label: "Thoát",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("before-quit", () => {
  isQuitting = true;
});

// No window-all-closed -> app.quit() anymore: the window's own "close"
// handler hides instead of destroying it, so this normally never fires
// with a real user-initiated close. Only the tray's "Thoát" (or an OS
// shutdown/task-kill) should end the process now.

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
