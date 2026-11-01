/**
 * Affiliate products (Shopee, Lazada, TikTok Shop) in posts, first comments and reply drafts (pure;
 * tests/affiliate.test.ts). Links only ever come from the member's product library: the AI never writes them.
 */

export type AffiliatePlatform = 'SHOPEE' | 'LAZADA' | 'TIKTOK';

export const PLATFORM_LABEL: Record<AffiliatePlatform, string> = { SHOPEE: 'Shopee', LAZADA: 'Lazada', TIKTOK: 'TikTok Shop' };

export interface LinkProduct {
  name: string;
  url: string;
  platform: AffiliatePlatform;
  price?: string | null;
  highlights?: string | null;
}

/** Where the first comment's product links go */
export const PRODUCTS_PLACEHOLDER = '{san_pham}';

const HOSTS: Array<[AffiliatePlatform, string[]]> = [
  ['SHOPEE', ['shopee.vn', 'shope.ee']],
  ['LAZADA', ['lazada.vn']],
  ['TIKTOK', ['tiktok.com']],
];

/** The platform a link belongs to, guessed from its host (the domain or one of its subdomains) */
export function platformOf(url: string): AffiliatePlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [platform, domains] of HOSTS) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return platform;
  }
  return null;
}

/** "🛒 Mua ở đây:" and one line per product; '' without products */
export function linkBlock(products: LinkProduct[]): string {
  if (!products.length) return '';
  return ['🛒 Mua ở đây:', ...products.map((p) => `👉 ${p.name} (${PLATFORM_LABEL[p.platform]}): ${p.url}`)].join('\n');
}

/** The post's message with the product links at the end */
export function withLinkBlock(message: string, products: LinkProduct[]): string {
  const block = linkBlock(products);
  return block ? `${message.trim()}\n\n${block}`.trim() : message;
}

/**
 * The first comment from the domain's template: {san_pham} becomes the links (its lines go when the post has no
 * product), a template without it gets the links appended. '' = post nothing.
 */
export function renderFirstComment(template: string | null, products: LinkProduct[]): string {
  const text = (template ?? '').trim();
  const block = linkBlock(products);
  if (text.includes(PRODUCTS_PLACEHOLDER)) {
    if (!block) {
      return text
        .split('\n')
        .filter((line) => !line.includes(PRODUCTS_PLACEHOLDER))
        .join('\n')
        .trim();
    }
    return text.split(PRODUCTS_PLACEHOLDER).join(block).trim();
  }
  return [text, block].filter(Boolean).join('\n\n');
}

/** What the AI is told about the post's products; '' without products */
export function productPromptBlock(products: LinkProduct[]): string {
  if (!products.length) return '';
  const lines = products.map((p) => {
    const price = p.price?.trim() ? ` — giá ${p.price.trim()}` : '';
    const highlights = p.highlights?.trim() ? `: ${p.highlights.trim()}` : '';
    return `- ${p.name}${price}${highlights}`;
  });
  return [
    'Sản phẩm cần giới thiệu trong bài (nhắc tên và lợi ích một cách tự nhiên; không viết đường link; không bịa giá, khuyến mãi hay công dụng ngoài thông tin dưới đây — link mua hàng được thêm tự động cuối bài):',
    ...lines,
  ].join('\n');
}

/** Every link in the reply is exactly one of the allowed ones (trailing punctuation aside) */
export function replyLinksAllowed(reply: string, allowedUrls: string[]): boolean {
  const links = reply.match(/https?:\/\/\S+/gi) ?? [];
  return links.every((link) => allowedUrls.includes(link.replace(/[.,;:!?)]+$/, '')));
}
