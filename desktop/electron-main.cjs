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

const { app, BrowserWindow } = require("electron");
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

  mainWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="background:#0b0b0f;color:#fff;font-family:sans-serif;padding:40px;display:grid;place-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <div style="font-size:32px;">▶</div>
            <p style="opacity:.8;margin-top:12px;">Đang khởi động... (lần đầu có thể mất vài phút để cài đặt giọng đọc)</p>
          </div>
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
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
