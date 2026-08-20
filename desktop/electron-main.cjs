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
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const ROOT = join(__dirname, "..");

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

async function ensureServerRunning(port) {
  if (await isServerUp(port)) return;

  const portableNode = join(ROOT, "desktop", "node", "node.exe");
  const nodeExe = existsSync(portableNode) ? portableNode : "node";
  const launcher = join(ROOT, "scripts", "launch-desktop.mjs");

  spawn(nodeExe, [launcher], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, SKIP_OPEN_BROWSER: "true" },
  }).unref();

  const ready = await waitForServer(port, 45000);
  if (!ready) {
    throw new Error("Server did not become ready within 45s");
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

  mainWindow.loadURL("about:blank");

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

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
