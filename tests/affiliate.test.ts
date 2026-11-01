import { describe, it, expect } from 'vitest';
import { linkBlock, platformOf, productPromptBlock, renderFirstComment, replyLinksAllowed, withLinkBlock, type LinkProduct } from '../src/lib/affiliate';

const p: LinkProduct = { name: 'Bình xịt 16L', url: 'https://s.shopee.vn/a', platform: 'SHOPEE' };
const BLOCK = '🛒 Mua ở đây:\n👉 Bình xịt 16L (Shopee): https://s.shopee.vn/a';

describe('affiliate', () => {
  it('guesses the platform from the link host', () => {
    expect(platformOf('https://s.shopee.vn/abc')).toBe('SHOPEE');
    expect(platformOf('https://shope.ee/xyz')).toBe('SHOPEE');
    expect(platformOf('https://c.lazada.vn/t/c.x')).toBe('LAZADA');
    expect(platformOf('https://vt.tiktok.com/ZS1/')).toBe('TIKTOK');
    expect(platformOf('https://example.com')).toBeNull();
    expect(platformOf('https://notshopee.vn/x')).toBeNull();
    expect(platformOf('not a url')).toBeNull();
  });

  it('builds one link line per product', () => {
    expect(linkBlock([])).toBe('');
    expect(linkBlock([p, { name: 'Phân bón', url: 'https://c.lazada.vn/b', platform: 'LAZADA' }])).toBe(
      '🛒 Mua ở đây:\n👉 Bình xịt 16L (Shopee): https://s.shopee.vn/a\n👉 Phân bón (Lazada): https://c.lazada.vn/b'
    );
  });

  it('adds the block after the message', () => {
    expect(withLinkBlock('Bài viết', [])).toBe('Bài viết');
    expect(withLinkBlock('Bài viết', [p])).toBe(`Bài viết\n\n${BLOCK}`);
  });

  it('renders the first comment with or without the placeholder', () => {
    expect(renderFirstComment('Link mua:\n{san_pham}\nCảm ơn cả nhà', [p])).toBe(`Link mua:\n${BLOCK}\nCảm ơn cả nhà`);
    expect(renderFirstComment('Link mua:\n{san_pham}\nCảm ơn cả nhà', [])).toBe('Link mua:\nCảm ơn cả nhà');
    expect(renderFirstComment('{san_pham}', [])).toBe('');
    expect(renderFirstComment('Ghé shop nhé', [p])).toBe(`Ghé shop nhé\n\n${BLOCK}`);
    expect(renderFirstComment(null, [p])).toBe(BLOCK);
    expect(renderFirstComment('Ghé shop nhé', [])).toBe('Ghé shop nhé');
    expect(renderFirstComment('  ', [])).toBe('');
  });

  it('tells the AI about the products without links', () => {
    expect(productPromptBlock([])).toBe('');
    const block = productPromptBlock([{ ...p, price: '450.000đ', highlights: 'pin 12 tiếng' }, { ...p, name: 'Phân bón' }]);
    expect(block).toContain('Sản phẩm cần giới thiệu trong bài');
    expect(block).toContain('không viết đường link');
    expect(block).toContain('- Bình xịt 16L — giá 450.000đ: pin 12 tiếng');
    expect(block).toMatch(/^- Phân bón$/m);
    expect(block).not.toContain('https://');
  });

  it('accepts a reply only when its links are exactly the allowed ones', () => {
    expect(replyLinksAllowed('Dạ link đây ạ: https://s.shopee.vn/a.', ['https://s.shopee.vn/a'])).toBe(true);
    expect(replyLinksAllowed('(https://s.shopee.vn/a)', ['https://s.shopee.vn/a'])).toBe(true);
    expect(replyLinksAllowed('https://s.shopee.vn/a?x=1', ['https://s.shopee.vn/a'])).toBe(false);
    expect(replyLinksAllowed('https://evil.example', [])).toBe(false);
    expect(replyLinksAllowed('Dạ mời anh nhắn tin', [])).toBe(true);
  });
});
