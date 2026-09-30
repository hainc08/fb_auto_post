import { describe, it, expect } from 'vitest';
import {
  splitCaption,
  publishProgress,
  shortError,
  visibleTags,
  inTimeRange,
  matchesFilters,
  statusCounts,
  type ListPost,
} from '../client/src/lib/post-display';
import { statusMeta } from '../client/src/lib/post-status';

describe('splitCaption', () => {
  it('first line is the title, the rest is the preview', () => {
    expect(splitCaption('AI Agent 24/7: từ chatbot thành "nhân viên AI"\n\nThay vì chỉ hỏi chatbot từng câu,\nAI Agent tự xử lý.')).toEqual({
      title: 'AI Agent 24/7: từ chatbot thành "nhân viên AI"',
      preview: 'Thay vì chỉ hỏi chatbot từng câu, AI Agent tự xử lý.',
    });
  });

  it('a long first line is cut at the first sentence end, the rest goes to the preview', () => {
    const text =
      'Sau một cuộc họp dài, việc đọc lại biên bản rất tốn thời gian. Thủ thuật AI này giúp bạn biến biên bản thành việc cần làm chỉ trong vài giây nhờ một câu lệnh ngắn.';
    const { title, preview } = splitCaption(text);
    expect(title).toBe('Sau một cuộc họp dài, việc đọc lại biên bản rất tốn thời gian.');
    expect(preview.startsWith('Thủ thuật AI này')).toBe(true);
  });

  it('one long paragraph without a sentence end is cut at a word with "…", never empty or duplicated', () => {
    const text = 'từ '.repeat(80).trim();
    const { title, preview } = splitCaption(text);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(111);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview).not.toBe(title);
  });

  it('empty caption → empty title and preview', () => {
    expect(splitCaption(null)).toEqual({ title: '', preview: '' });
  });
});

describe('publishProgress', () => {
  const t = (status: 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED') => ({ status });
  it('says nothing for one Page or no targets', () => {
    expect(publishProgress([t('PUBLISHED')])).toBeNull();
    expect(publishProgress(undefined)).toBeNull();
  });
  it('reads like a person would say it', () => {
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED')])).toEqual({ label: 'Đã đăng 4/4', tone: 'success' });
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHED'), t('PUBLISHED'), t('FAILED')])).toEqual({ label: '3/4 thành công', tone: 'error' });
    expect(publishProgress([t('PUBLISHED'), t('PUBLISHING'), t('PENDING')])).toEqual({ label: 'Đang đăng 1/3', tone: 'progress' });
    expect(publishProgress([t('PENDING'), t('PENDING')])).toEqual({ label: '2 Page', tone: 'neutral' });
  });
});

describe('shortError', () => {
  it('maps Facebook errors to short Vietnamese labels', () => {
    expect(shortError('Error validating access token: Session has expired')).toBe('Token hết hạn');
    expect(shortError('(#200) Requires pages_manage_posts permission')).toBe('Thiếu quyền');
    expect(shortError('Token do Facebook App khác cấp (123).')).toBe('Token của App cũ');
    expect(shortError('Something odd')).toBe('Đăng thất bại');
    expect(shortError(null)).toBe('Đăng thất bại');
  });
});

describe('visibleTags', () => {
  it('shows two hashtags and counts the rest', () => {
    expect(visibleTags(['AIAgent', '#TuDongHoa', 'AI', 'X'])).toEqual({ shown: ['#AIAgent', '#TuDongHoa'], more: 2 });
    expect(visibleTags(null)).toEqual({ shown: [], more: 0 });
  });
});

describe('inTimeRange', () => {
  const now = new Date(2026, 8, 30, 15, 0); // local time
  it('today, 7 and 30 days, and future scheduled posts', () => {
    expect(inTimeRange(new Date(2026, 8, 30, 1, 0).toISOString(), 'today', now)).toBe(true);
    expect(inTimeRange(new Date(2026, 8, 29, 23, 0).toISOString(), 'today', now)).toBe(false);
    expect(inTimeRange(new Date(2026, 8, 24, 16, 0).toISOString(), '7d', now)).toBe(true);
    expect(inTimeRange(new Date(2026, 8, 20, 0, 0).toISOString(), '7d', now)).toBe(false);
    expect(inTimeRange(new Date(2026, 9, 3, 8, 0).toISOString(), '7d', now)).toBe(true); // scheduled ahead
    expect(inTimeRange('2020-01-01T00:00:00Z', '', now)).toBe(true);
  });
});

describe('matchesFilters and statusCounts', () => {
  const base = { publishedAt: null, scheduledAt: null, createdAt: '2026-09-30T05:00:00Z', domain: null };
  const posts: ListPost[] = [
    {
      ...base,
      status: 'PUBLISHED',
      caption: 'Rầy nâu trên lúa',
      page: { id: 'p1' },
      targets: [
        { status: 'PUBLISHED', page: { id: 'p1', pageName: 'A' } },
        { status: 'PUBLISHED', page: { id: 'p2', pageName: 'B' } },
      ],
    },
    { ...base, status: 'READY', caption: 'Sâu tơ trên rau', page: { id: 'p1' } }, // old post: no targets
    { ...base, status: 'READY', caption: 'Rầy nâu mùa mưa', page: { id: 'p3' }, targets: [{ status: 'PENDING', page: { id: 'p3', pageName: 'C' } }] },
  ];
  const now = new Date('2026-09-30T08:00:00Z');

  it('a secondary Page matches, and old posts match through their main Page', () => {
    expect(posts.filter((p) => matchesFilters(p, { q: '', pageId: 'p2', time: '' }, now))).toHaveLength(1);
    expect(posts.filter((p) => matchesFilters(p, { q: '', pageId: 'p1', time: '' }, now))).toHaveLength(2);
  });

  it('search + Page combine; counts ignore only the status tab', () => {
    const shown = posts.filter((p) => matchesFilters(p, { q: 'rầy', pageId: 'p3', time: '' }, now));
    expect(shown).toHaveLength(1);
    expect(statusCounts(posts.filter((p) => matchesFilters(p, { q: 'rầy', pageId: '', time: '' }, now)))).toEqual({ '': 2, PUBLISHED: 1, READY: 1 });
  });
});

describe('statusMeta', () => {
  it('uses the agreed status colours', () => {
    expect(statusMeta('DRAFT').cls).toBe('badge-draft');
    expect(statusMeta('READY')).toEqual({ label: 'Chờ duyệt', cls: 'badge-ready' });
    expect(statusMeta('SCHEDULED').cls).toBe('badge-scheduled');
    expect(statusMeta('PUBLISHED').cls).toBe('badge-published');
    expect(statusMeta('FAILED').cls).toBe('badge-failed');
    expect(statusMeta('WHATEVER')).toEqual({ label: 'WHATEVER', cls: 'badge-draft' });
  });
});
