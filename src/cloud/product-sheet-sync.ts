// Talks to the user's own Google Apps Script Web App (bound to their product
// Google Sheet) — see the .gs code handed to the user separately. This is a
// lightweight alternative to the official Sheets API: no service account,
// no Google Cloud project, just a URL + shared secret the user controls.

export interface SheetProductRow {
  /** Sheet row number (1-based, header is row 1) — present on every row the
   *  Apps Script's doGet returns, used to write back via fillRowFields
   *  without needing to re-match by item_id. */
  _row?: number;
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
  /** Cột "script_text" (Q) — kịch bản người dùng tự chat/viết rồi dán trực
   *  tiếp vào Sheet cho sản phẩm này, dùng thay AI khi muốn. */
  script_text?: string;
}

export interface SheetPushUpdate {
  item_id: string;
  status?: string;
  video_file?: string;
  tiktok_post_url?: string;
  views_clicks_orders?: string;
  commission?: string;
  image_url?: string;
  price_reference?: string;
  product_name?: string;
  shop_name?: string;
  category?: string;
}

function config() {
  const url = process.env.PRODUCT_SHEET_SYNC_URL?.trim();
  const key = process.env.PRODUCT_SHEET_SECRET?.trim();
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

/** Best-effort: bumps today's row in a "BaoCaoTruyCap" tab (auto-created by
 *  the Apps Script) by 1 — one row per calendar day (VN time), incremented
 *  in place rather than appended per-visit, so the tab stays a short daily
 *  summary next to the per-event "BaoCaoClick" tab instead of growing one
 *  row per page load. */
export async function logDailyVisit(): Promise<void> {
  const { url, key } = config();
  if (!url || !key) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "logDailyVisit" }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Best-effort — a visitor's page load must never fail because the report log is down.
  }
}

export async function pushProductUpdatesToSheet(updates: SheetPushUpdate[]): Promise<number> {
  if (!updates.length) return 0;
  const { url, key } = config();
  if (!url || !key) throw new Error("Missing PRODUCT_SHEET_SYNC_URL or PRODUCT_SHEET_SECRET in .env.local");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleepMs(1500);
    try {
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
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---- "KichBanYTB" content-queue tab (AI Content backlog) — same Sheet,
// same Apps Script deployment, different tab. See the .gs code handed to
// the user separately for the actions this calls.

export interface ContentQueueItem {
  row: number;
  ma?: string;
  deTai: string;
  doDai?: string;
  phongCach?: string;
}

export interface ApprovedContentItem {
  row: number;
  projectId: string;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Google Apps Script Web Apps have a real, observed flaky streak — confirmed
 *  directly on this exact deployment (a real render's log showed a plain
 *  "Sheet sync POST failed: HTTP 404" that was gone on the very next call
 *  minutes later, no config change in between). Most likely Apps Script's
 *  own execution-environment cold start or its exec->googleusercontent.com
 *  redirect hiccuping transiently, not anything wrong with the URL/secret
 *  (a genuinely bad secret/URL fails with a stable, real error every time,
 *  which a retry correctly won't paper over). One retry after a short pause
 *  turns a one-off blip into a silent success instead of a user-visible
 *  "0 sản phẩm" that looks like nothing was found, when the check itself
 *  never actually ran. */
async function postAction<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const { url, key } = config();
  if (!url || !key) throw new Error("Missing PRODUCT_SHEET_SYNC_URL or PRODUCT_SHEET_SECRET in .env.local");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleepMs(1500);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, action, ...extra }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`Sheet sync POST failed: HTTP ${resp.status}`);
      const data = (await resp.json()) as { ok: boolean; error?: string } & T;
      if (!data.ok) throw new Error(data.error || "Sheet sync POST failed");
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Rows in "KichBanYTB" with an Đề tài but no kịch bản written yet
 *  (Trạng thái blank or "Chờ viết"). */
export async function fetchPendingContentQueue(): Promise<ContentQueueItem[]> {
  const data = await postAction<{ items?: ContentQueueItem[] }>("listContentQueue");
  return data.items ?? [];
}

export interface SheetRowMissingItemId {
  row: number;
  product_name: string;
  original_url: string;
  shop_name?: string;
}

/** Product-sheet rows that have a link/name but no item_id yet (freshly
 *  pasted rows) — item_id is the key every other write path matches on, so
 *  these are otherwise invisible to upsertProductFromSheet/pushProductUpdatesToSheet
 *  entirely (the Apps Script's normal GET filters out any row with a blank
 *  item_id — see the .gs code's doGet). */
export async function fetchRowsMissingItemId(): Promise<SheetRowMissingItemId[]> {
  const data = await postAction<{ rows?: SheetRowMissingItemId[] }>("listRowsMissingItemId");
  return data.rows ?? [];
}

export interface SheetRowFill {
  row: number;
  item_id?: string;
  image_url?: string;
  product_name?: string;
  price_reference?: string;
  shop_name?: string;
  category?: string;
}

/** Writes directly to a row by its sheet row number rather than matching by
 *  item_id — the one path that can assign a brand-new row's item_id in the
 *  first place, since matching by item_id is impossible before it has one. */
export async function fillSheetRowFields(updates: SheetRowFill[]): Promise<number> {
  if (!updates.length) return 0;
  const data = await postAction<{ updated?: number }>("fillRowFields", { updates });
  return data.updated ?? 0;
}

/** Writes the AI-generated script back to a row and flips its status to
 *  "Đã viết - Chờ duyệt" — the user reads/edits it directly in the Sheet,
 *  then flips Trạng thái to "Đã duyệt" themselves when it's ready for voice. */
export async function writeContentQueueResult(row: number, kichBan: string, projectId: string): Promise<void> {
  await postAction("writeContentResult", { row, kichBan, projectId });
}

/** Rows the user has marked "Đã duyệt" — ready to have voice generated. */
export async function fetchApprovedContentQueue(): Promise<ApprovedContentItem[]> {
  const data = await postAction<{ items?: ApprovedContentItem[] }>("listApprovedContent");
  return data.items ?? [];
}

export async function markContentQueueDone(row: number, videoLink?: string): Promise<void> {
  await postAction("markContentDone", { row, videoLink });
}

export interface ContentQueueRowScript {
  kichBan: string;
  trangThai?: string;
}

/** Re-reads the current "Kịch bản" cell for a row the user may have edited
 *  directly in the Sheet after the AI first wrote it — used by the Voice
 *  page's "Lấy nội dung có sẵn từ Google Sheet" button so approving a
 *  project always uses the latest text in the Sheet, not a stale local
 *  copy from generation time. */
export async function fetchContentQueueRowScript(row: number): Promise<ContentQueueRowScript> {
  const data = await postAction<{ item?: ContentQueueRowScript }>("getContentQueueRow", { row });
  if (!data.item || !data.item.kichBan?.trim()) throw new Error("Chưa có kịch bản nào trên Sheet cho dự án này.");
  return data.item;
}
