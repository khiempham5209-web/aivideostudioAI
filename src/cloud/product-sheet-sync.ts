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
