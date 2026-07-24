// Talks to the user's own Google Apps Script Web App (bound to their product
// Google Sheet) — see the .gs code handed to the user separately. This is a
// lightweight alternative to the official Sheets API: no service account,
// no Google Cloud project, just a URL + shared secret the user controls.

export interface SheetProductRow {
  item_id: string;
  product_name: string;
  shop_name?: string;
  original_url?: string;
  affiliate_url?: string;
  variation?: string;
  price_reference?: string;
  commission_type?: string;
  key_points?: string;
  image_url?: string;
  category?: string;
}

export interface SheetPushUpdate {
  item_id: string;
  status?: string;
  video_file?: string;
  tiktok_post_url?: string;
  views_clicks_orders?: string;
  commission?: string;
}

function config() {
  const url = process.env.PRODUCT_SHEET_SYNC_URL;
  const key = process.env.PRODUCT_SHEET_SECRET;
  return { url, key };
}

export function isProductSheetConfigured(): boolean {
  const { url, key } = config();
  return Boolean(url && key);
}

export async function fetchProductsFromSheet(): Promise<SheetProductRow[]> {
  const { url, key } = config();
  if (!url || !key) throw new Error("Missing PRODUCT_SHEET_SYNC_URL or PRODUCT_SHEET_SECRET in .env.local");
  const resp = await fetch(`${url}?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`Sheet sync GET failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as { ok: boolean; error?: string; products?: SheetProductRow[] };
  if (!data.ok) throw new Error(data.error || "Sheet sync GET failed");
  return data.products ?? [];
}

/** Best-effort: logs a landing-page click as a new row in a separate
 *  "BaoCaoClick" tab of the same Sheet (created automatically by the Apps
 *  Script if it doesn't exist yet) — a running click report the user can
 *  open directly in Google Sheets, independent of the main product tab. */
export async function logProductClick(itemId: string, productName: string): Promise<void> {
  const { url, key } = config();
  if (!url || !key) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "logClick", item_id: itemId, product_name: productName }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Best-effort — a click must never fail because the report log is down.
  }
}

export async function pushProductUpdatesToSheet(updates: SheetPushUpdate[]): Promise<number> {
  if (!updates.length) return 0;
  const { url, key } = config();
  if (!url || !key) throw new Error("Missing PRODUCT_SHEET_SYNC_URL or PRODUCT_SHEET_SECRET in .env.local");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, updates }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`Sheet sync POST failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as { ok: boolean; error?: string; updated?: number };
  if (!data.ok) throw new Error(data.error || "Sheet sync POST failed");
  return data.updated ?? 0;
}
