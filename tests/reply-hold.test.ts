import { describe, it, expect } from 'vitest';
import { DEFAULT_HOLD_KEYWORDS, holdReason, parseHoldKeywords } from '../src/lib/reply-hold';

describe('reply hold', () => {
  it('uses the built-in keywords when the domain has none', () => {
    expect(parseHoldKeywords(null)).toEqual(DEFAULT_HOLD_KEYWORDS);
    expect(parseHoldKeywords('  \n , ')).toEqual(DEFAULT_HOLD_KEYWORDS);
  });

  it('reads keywords split by commas or lines, lower-cased, without duplicates', () => {
    expect(parseHoldKeywords('Giá, bao nhiêu\nGIÁ\n  ship  ')).toEqual(['giá', 'bao nhiêu', 'ship']);
  });

  it('holds a comment with a keyword, as a whole word and in any case', () => {
    const kw = ['giá', 'lừa đảo'];
    expect(holdReason('Thuốc này GIÁ bao nhiêu?', kw)).toBe('Có từ khoá "giá"');
    expect(holdReason('shop lừa đảo à', kw)).toBe('Có từ khoá "lừa đảo"');
    expect(holdReason('Giá.', kw)).toBe('Có từ khoá "giá"');
    // part of another word is not the keyword
    expect(holdReason('giáo viên hỏi', kw)).toBeNull();
    expect(holdReason('Cảm ơn shop', kw)).toBeNull();
  });

  it('matches a keyword typed in a different Unicode form', () => {
    // "giá" typed as g + i + a + combining acute accent
    expect(holdReason('giá sao ạ', ['giá'])).toBe('Có từ khoá "giá"');
  });

  it('holds a comment with a link or a phone number whatever the keywords', () => {
    expect(holdReason('xem ở đây https://spam.example', [])).toBe('Có đường link');
    expect(holdReason('vào www.spam.vn nhé', [])).toBe('Có đường link');
    expect(holdReason('gọi em 0912 345 678', [])).toBe('Có số điện thoại');
    expect(holdReason('gọi em 0912.345.678', [])).toBe('Có số điện thoại');
    expect(holdReason('mua 2 chai 500ml', [])).toBeNull();
  });
});
