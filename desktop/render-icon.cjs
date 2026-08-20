// Renders an app icon that matches the in-app logo exactly (public/index.html
// .logo class: blue->purple->pink gradient rounded square with a white play
// triangle) — the repo's assets/logo.svg is generic "AI CODING" template
// branding, not this app's actual visual identity.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync, existsSync, unlinkSync } = require("node:fs");

const SIZE = 512;
app.disableHardwareAcceleration();
const OUT_PATH = join(__dirname, "icon-source-512.png");
if (existsSync(OUT_PATH)) unlinkSync(OUT_PATH);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
      <html><body style="margin:0;background:transparent;width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;">
        <div style="
          width:${SIZE}px;height:${SIZE}px;
          border-radius:${SIZE * 0.22}px;
          background:linear-gradient(135deg,#2563eb,#7c3aed,#ec4899);
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 0 ${SIZE * 0.08}px rgba(124,58,237,0.5);
        ">
          <div style="
            width:0;height:0;
            border-top:${SIZE * 0.17}px solid transparent;
            border-bottom:${SIZE * 0.17}px solid transparent;
            border-left:${SIZE * 0.27}px solid white;
            margin-left:${SIZE * 0.04}px;
          "></div>
        </div>
      </body></html>
    `),
  );
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  writeFileSync(OUT_PATH, image.toPNG());
  console.log("wrote desktop/icon-source-512.png");
  app.exit(0);
});
