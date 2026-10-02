import { describe, it, expect } from 'vitest';
import { buildAss, buildLines, countSpokenWords, displayWords, type ReelWord } from '../src/lib/reel/subtitles';

/** Words 200 ms long, back to back from 0 */
const marks = (texts: string[]): ReelWord[] => texts.map((text, i) => ({ text, startMs: i * 200, durationMs: 200 }));

describe('displayWords', () => {
  it('shows the script as written (case and punctuation) when the counts match', () => {
    const shown = displayWords('Bạn mất bao lâu? — Thử ngay!', marks(['Bạn', 'mất', 'bao', 'lâu', 'Thử', 'ngay']));
    expect(shown.map((w) => w.text)).toEqual(['Bạn', 'mất', 'bao', 'lâu?', 'Thử', 'ngay!']);
    expect(shown[3]).toMatchObject({ startMs: 600, durationMs: 200 });
  });

  it('falls back to the spoken words when the counts differ', () => {
    // Edge read "&" as a word and reports it XML-escaped
    const shown = displayWords('Giá chỉ 15% & rẻ', marks(['Giá', 'chỉ', '15%', '&amp;', 'rẻ', 'thêm']));
    expect(shown.map((w) => w.text)).toEqual(['Giá', 'chỉ', '15%', '&', 'rẻ', 'thêm']);
  });
});

describe('countSpokenWords', () => {
  it('ignores tokens with no letter or digit', () => {
    expect(countSpokenWords('  Bạn — mất 15% 🙂 thời gian  ')).toBe(5);
    expect(countSpokenWords('')).toBe(0);
  });
});

describe('buildLines', () => {
  const texts = (lines: ReelWord[][]) => lines.map((l) => l.map((w) => w.text).join(' '));

  it('puts at most 4 words on a line and breaks after punctuation', () => {
    const lines = buildLines(marks(['Bạn', 'mất', 'bao', 'lâu', 'để', 'viết', 'email?', 'Với', 'vài', 'câu', 'lệnh,', 'AI']));
    expect(texts(lines)).toEqual(['Bạn mất bao lâu', 'để viết email?', 'Với vài câu lệnh,', 'AI']);
  });

  it('keeps a line under 24 characters', () => {
    expect(texts(buildLines(marks(['tự-động-hoá-công-việc', 'nhanh'])))).toEqual(['tự-động-hoá-công-việc', 'nhanh']);
  });

  it('does not leave a lone word before a comma', () => {
    expect(texts(buildLines(marks(['Vâng,', 'đúng', 'vậy'])))).toEqual(['Vâng, đúng vậy']);
  });

  it('returns no line for no word', () => {
    expect(buildLines([])).toEqual([]);
  });
});

describe('buildAss', () => {
  const two: ReelWord[][] = [[{ text: 'A', startMs: 0, durationMs: 300 }, { text: 'B', startMs: 500, durationMs: 300 }]];

  it('times each word until the next one and holds the last line a moment', () => {
    const ass = buildAss(two, { withImage: false });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.20,K,,0,0,0,,{\\k50}A {\\k70}B');
  });

  it('ends a line where the next one starts', () => {
    const ass = buildAss([...two, [{ text: 'C', startMs: 2000, durationMs: 500 }]], { withImage: false });
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,K,,0,0,0,,{\\k50}A {\\k150}B');
    expect(ass).toContain('Dialogue: 0,0:00:02.00,0:00:02.90,K,,0,0,0,,{\\k90}C');
  });

  it('puts the text under the picture, or in the middle without one', () => {
    expect(buildAss(two, { withImage: true })).toMatch(/^Style: K,Arial,.*,2,80,80,430,1$/m);
    expect(buildAss(two, { withImage: false })).toMatch(/^Style: K,Arial,.*,5,80,80,0,1$/m);
    expect(buildAss(two, { withImage: false, font: 'Be Vietnam Pro' })).toMatch(/^Style: K,Be Vietnam Pro,/m);
  });

  it('removes subtitle syntax from the words', () => {
    const ass = buildAss([[{ text: '{\\b1}Giá\\N', startMs: 0, durationMs: 100 }]], { withImage: false });
    expect(ass).toContain('{\\k50}b1GiáN');
  });
});
