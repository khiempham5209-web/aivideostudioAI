// Runs on every Vercel deploy (triggered by the Render backend's deploy
// hook whenever the owner syncs/updates product data — see
// triggerVercelShopRebuild() in src/api.ts). Fetches the current public
// product list from Render and bakes it into a static products.json file,
// then copies the shared shop.html markup in as this project's index.html.
// The result: visitors always get an instantly-loading page with the
// latest-known data, with zero dependency on Render being awake at the
// moment they load the page — only the interactive bits (click tracking,
// visit counting) still call through to Render live, and only in the
// background (see the fetch calls inside shop.html itself).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDER_API_BASE = process.env.RENDER_API_BASE || "https://aivideostudioaibackend.onrender.com";

async function fetchProductsWithRetry(maxAttempts = 5, delayMs = 8000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(`${RENDER_API_BASE}/api/public/products`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "API returned ok:false");
      return data.products ?? [];
    } catch (error) {
      const isLast = attempt === maxAttempts;
      console.warn(`[build] fetch products attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      if (isLast) throw error;
      // Render's free/starter tier can take up to ~50s to wake from sleep —
      // retry with a real wait instead of failing the whole deploy on the
      // first attempt, which would otherwise happen most of the time.
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return [];
}

async function main() {
  await mkdir(path.join(__dirname, "public"), { recursive: true });

  const products = await fetchProductsWithRetry();
  await writeFile(
    path.join(__dirname, "public", "products.json"),
    JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), products }),
  );
  console.log(`[build] wrote products.json with ${products.length} products`);

  const shopHtmlPath = path.join(__dirname, "..", "public", "shop.html");
  const shopHtml = await readFile(shopHtmlPath, "utf8");
  await writeFile(path.join(__dirname, "public", "index.html"), shopHtml);
  console.log("[build] copied shop.html -> public/index.html");
}

main().catch((error) => {
  console.error("[build] failed:", error);
  process.exit(1);
});
