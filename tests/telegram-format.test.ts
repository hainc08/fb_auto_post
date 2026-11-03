import { describe, it, expect } from 'vitest';
import {
  approveKeyboard,
  digestDue,
  digestHeader,
  parseCallback,
  postCard,
  splitText,
  vnDay,
  type CardPost,
} from '../src/lib/telegram-format';

const ID = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
const base: CardPost = {
  id: ID,
  caption: 'Lúa vàng lá',
  scheduledAt: new Date('2026-11-04T01:00:00Z'), // 08:00 in Vietnam
  pageNames: ['Nhà nông', 'Hợp Phú'],
  productNames: ['Bình xịt 16L'],
  hasVideo: false,
};

describe('telegram format', () => {
  it('builds the card of a waiting post', () => {
    expect(postCard(base)).toBe('📝 Nhà nông, Hợp Phú · đăng 08:00 04/11\n\nLúa vàng lá\n\n🛒 Bình xịt 16L');
    expect(postCard({ ...base, scheduledAt: null })).toContain('đăng chưa có giờ');
    expect(postCard({ ...base, hasVideo: true })).toContain('\n🎬 Bài có video');
    expect(postCard({ ...base, productNames: [] })).not.toContain('🛒');
  });

  it('cuts a long caption and never escapes special characters', () => {
    const long = postCard({ ...base, caption: 'a'.repeat(2000) });
    expect(long).toContain(`${'a'.repeat(700)}…`);
    expect(long).not.toContain('a'.repeat(701));
    expect(postCard({ ...base, caption: '<b>a_b*c</b>' })).toContain('<b>a_b*c</b>');
  });

  it('writes the morning header', () => {
    expect(digestHeader(3, 3)).toBe('☀️ Chào buổi sáng! Có 3 bài đang chờ bạn duyệt.');
    expect(digestHeader(14, 10)).toContain('Đang hiện 10 bài đầu — còn 4 bài');
  });

  it('splits long text at line ends, and hard when a line is too long', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Dòng số ${i} của một bài viết dài`).join('\n');
    const chunks = splitText(lines);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join('\n')).toBe(lines);
    const hard = splitText('x'.repeat(5000));
    expect(hard.map((c) => c.length)).toEqual([4096, 904]);
    expect(splitText('')).toEqual([]);
  });

  it('offers approve and full text, and the web link only on https', () => {
    expect(approveKeyboard(ID, 'https://app.test').inline_keyboard).toEqual([
      [
        { text: '✅ Duyệt', callback_data: `a:${ID}` },
        { text: '📄 Xem đủ', callback_data: `f:${ID}` },
      ],
      [{ text: '🌐 Mở trên web', url: `https://app.test/posts?selected=${ID}` }],
    ]);
    expect(approveKeyboard(ID, 'http://localhost:5173').inline_keyboard).toHaveLength(1);
    expect(approveKeyboard(ID, null).inline_keyboard).toHaveLength(1);
    for (const button of approveKeyboard(ID, null).inline_keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data ?? '')).toBeLessThanOrEqual(64);
    }
  });

  it('reads the callback of a button', () => {
    expect(parseCallback(`a:${ID}`)).toEqual({ action: 'approve', postId: ID });
    expect(parseCallback(`f:${ID}`)).toEqual({ action: 'full', postId: ID });
    expect(parseCallback('noop')).toEqual({ action: 'noop' });
    for (const bad of ['a:not-a-uuid', `x:${ID}`, '', `a:${ID}extra`]) expect(parseCallback(bad)).toBeNull();
  });

  it('knows the day in Vietnam and when the morning digest is due', () => {
    expect(vnDay(new Date('2026-11-03T17:30:00Z'))).toBe('2026-11-04');
    const at = (iso: string) => new Date(iso);
    expect(digestDue(at('2026-11-04T01:00:00Z'), '08:00', null)).toBe(true);
    expect(digestDue(at('2026-11-04T00:59:00Z'), '08:00', null)).toBe(false); // 07:59
    expect(digestDue(at('2026-11-04T01:00:00Z'), '08:00', '2026-11-04')).toBe(false);
    expect(digestDue(at('2026-11-04T01:00:00Z'), '08:00', '2026-11-03')).toBe(true);
    expect(digestDue(at('2026-11-04T14:00:00Z'), '08:00', null)).toBe(true); // 21:00: the app was asleep, it catches up
  });
});
