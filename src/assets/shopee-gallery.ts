import axios from "axios";

export interface ShopeeGalleryResult {
  imageUrls: string[];
  videoUrls: string[];
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

    return { imageUrls, videoUrls };
  } catch (error) {
    console.error(`[shopee-gallery] fetch failed for ${productUrl}:`, error instanceof Error ? error.message : String(error));
    return { imageUrls: [], videoUrls: [] };
  }
}
