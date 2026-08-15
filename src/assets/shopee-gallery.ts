import axios from "axios";

export interface ShopeeGalleryResult {
  imageUrls: string[];
  videoUrls: string[];
  /** Product title and current price, opportunistically read off the same
   *  item-detail response the images/videos already come from — no extra
   *  request. `price` is Shopee's raw integer (VND × 100000, their fixed-
   *  point convention) converted down to plain VND; `undefined` if the
   *  response didn't have a usable value rather than a guessed 0. */
  name?: string;
  price?: number;
  /** Shop's display name, read off a second (best-effort) call to Shopee's
   *  shop/get endpoint using the same shopId — the item/get response the
   *  rest of this function reads doesn't carry it. `undefined` if that
   *  second call fails; never blocks the image/name/price result. */
  shopName?: string;
}

/** Shopee product URLs come in two shapes:
 *  - https://shopee.vn/product/{shopId}/{itemId}
 *  - https://shopee.vn/{slug}-i.{shopId}.{itemId}
 *  Both encode the same two IDs the item-detail API needs. */
function parseShopeeIds(url: string): { shopId: string; itemId: string } | null {
  const productMatch = url.match(/shopee\.[a-z.]+\/product\/(\d+)\/(\d+)/i);
  if (productMatch) return { shopId: productMatch[1], itemId: productMatch[2] };
  const slugMatch = url.match(/-i\.(\d+)\.(\d+)/i);
  if (slugMatch) return { shopId: slugMatch[1], itemId: slugMatch[2] };
  return null;
}

/** The itemId half of parseShopeeIds, exposed for callers that need a
 *  stable per-listing identifier (not the shopId, which repeats across a
 *  shop's whole catalog) — e.g. assigning item_id to a freshly-pasted
 *  product-sheet row that only has a link so far. */
export function deriveShopeeItemId(url: string): string | null {
  return parseShopeeIds(url)?.itemId ?? null;
}

const IMAGE_CDN_BASE = "https://down-vn.img.susercontent.com/file/";

/** Shopee's own (undocumented, unofficial) item-detail endpoint — the same
 *  one the product page itself calls client-side to render its image
 *  gallery. These are the SHOP'S OWN marketing photos for this exact
 *  listing, already public on the product page, so pulling them carries
 *  none of the "used someone else's review/content" copyright risk that
 *  scraping social media would. Fragile by nature (unofficial endpoint,
 *  no stability guarantee, can be blocked or change shape) — every failure
 *  path here returns an empty result rather than throwing, so a broken
 *  scrape never blocks the rest of product/video creation. */
export async function fetchShopeeGallery(productUrl: string): Promise<ShopeeGalleryResult> {
  const ids = parseShopeeIds(productUrl);
  if (!ids) return { imageUrls: [], videoUrls: [] };

  try {
    const resp = await axios.get(
      `https://shopee.vn/api/v4/item/get?itemid=${ids.itemId}&shopid=${ids.shopId}`,
      {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Referer": productUrl,
          "Accept": "application/json",
        },
        validateStatus: (s) => s < 500,
      },
    );
    if (resp.status !== 200 || !resp.data?.data) return { imageUrls: [], videoUrls: [] };

    const data = resp.data.data;
    const imageHashes: string[] = Array.isArray(data.images) && data.images.length ? data.images : (data.image ? [data.image] : []);
    const imageUrls = imageHashes
      .filter((h: unknown): h is string => typeof h === "string" && h.length > 0)
      .slice(0, 9)
      .map((hash: string) => `${IMAGE_CDN_BASE}${hash}`);

    const videoUrls: string[] = [];
    const videoList = data.video_info_list;
    if (Array.isArray(videoList)) {
      for (const entry of videoList) {
        const url = entry?.video_info?.definitions?.[0]?.url ?? entry?.video_url;
        if (typeof url === "string" && url) videoUrls.push(url);
      }
    }

    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
    // Shopee's price fields are all the same fixed-point integer (real VND
    // × 100000); price_min is what's actually charged when a listing has
    // variation-based pricing (price alone can be the lowest/a stale value
    // on those), so prefer it and fall back to price for single-price items.
    const rawPrice = data.price_min ?? data.price;
    const price = typeof rawPrice === "number" && rawPrice > 0 ? Math.round(rawPrice / 100000) : undefined;
    const shopName = await fetchShopeeShopName(ids.shopId, productUrl);

    return { imageUrls, videoUrls, name, price, shopName };
  } catch (error) {
    console.error(`[shopee-gallery] fetch failed for ${productUrl}:`, error instanceof Error ? error.message : String(error));
    return { imageUrls: [], videoUrls: [] };
  }
}

async function fetchShopeeShopName(shopId: string, referer: string): Promise<string | undefined> {
  try {
    const resp = await axios.get(`https://shopee.vn/api/v4/shop/get?shopid=${shopId}`, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": referer,
        "Accept": "application/json",
      },
      validateStatus: (s) => s < 500,
    });
    const name = resp.data?.data?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}
