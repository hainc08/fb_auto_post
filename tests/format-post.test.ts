import { describe, it, expect } from 'vitest';
import { formatPostText, splitTrailingHashtags, SEPARATOR } from '../src/lib/format-post';

// Real Gemini output from the E2E run (single newlines, hashtags glued to the question)
const REAL_OUTPUT = `Sau những cuộc họp trực tuyến kéo dài, việc đọc lại toàn bộ biên bản để tổng hợp danh sách việc cần làm có thể tốn rất nhiều thời gian. 🤔
Dùng AI để nhanh chóng biến bản ghi chép cuộc họp thành các đầu việc cụ thể.
Prompt mẫu:
Tôi có biên bản của một cuộc họp và muốn bạn tóm tắt thành danh sách việc cần làm.
1. Tên công việc
2. Người chịu trách nhiệm
3. Hạn chót
Không được bịa thêm bất kỳ thông tin nào.

Luôn kiểm tra lại danh sách AI đưa ra với bản gốc biên bản.
Bạn thường làm gì để không bỏ sót các đầu việc quan trọng sau những cuộc họp dài? #AIVanPhong #QuanLyDuAn`;

describe('formatPostText', () => {
  it('puts a blank line between paragraphs', () => {
    expect(formatPostText('Câu mở đầu.\nĐoạn thứ hai.\nĐoạn thứ ba.')).toBe('Câu mở đầu.\n\nĐoạn thứ hai.\n\nĐoạn thứ ba.');
  });

  it('keeps list items together, and attached to a line ending with ":"', () => {
    expect(formatPostText('Gồm các bước:\n1. Một\n2. Hai\nKết thúc.')).toBe('Gồm các bước:\n1. Một\n2. Hai\n\nKết thúc.');
  });

  it('removes Markdown the Facebook composer cannot render', () => {
    expect(formatPostText('## Tiêu đề\n**Đậm** và __gạch__\n- ý một\n* ý hai')).toBe('Tiêu đề\n\nĐậm và gạch\n\n• ý một\n• ý hai');
  });

  it('never treats hashtags as Markdown headings', () => {
    expect(formatPostText('Nội dung\n#AIVanPhong #ThuThuat')).toBe('Nội dung\n\n#AIVanPhong #ThuThuat');
  });

  it('collapses runs of blank lines and trailing spaces', () => {
    expect(formatPostText('A   \n\n\n\nB\t\n')).toBe('A\n\nB');
  });

  it('frames a separator-delimited prompt and keeps its inner line breaks', () => {
    const input = `Mở đầu.\n📋 Prompt mẫu:\n───────────\nDòng 1\nDòng 2\n\n[Dán vào đây]\n───────────\n✅ Kiểm tra lại.`;
    expect(formatPostText(input)).toBe(
      `Mở đầu.\n\n📋 Prompt mẫu:\n${SEPARATOR}\nDòng 1\nDòng 2\n\n[Dán vào đây]\n${SEPARATOR}\n\n✅ Kiểm tra lại.`
    );
  });

  it('moves text written on the label line into the prompt body', () => {
    expect(formatPostText(`**Prompt mẫu:** Hãy tóm tắt [văn bản]\n${SEPARATOR}`)).toBe(
      `📋 Prompt mẫu:\n${SEPARATOR}\nHãy tóm tắt [văn bản]\n${SEPARATOR}`
    );
  });

  it('keeps an unframed prompt together until the first blank line (real Gemini output)', () => {
    const out = formatPostText(REAL_OUTPUT);
    expect(out).toContain('tốn rất nhiều thời gian. 🤔\n\nDùng AI để');
    expect(out).toContain(
      '📋 Prompt mẫu:\nTôi có biên bản của một cuộc họp và muốn bạn tóm tắt thành danh sách việc cần làm.\n1. Tên công việc\n2. Người chịu trách nhiệm\n3. Hạn chót\nKhông được bịa thêm bất kỳ thông tin nào.\n\nLuôn kiểm tra'
    );
    expect(out).toContain('bản gốc biên bản.\n\nBạn thường làm gì');
  });

  it('normalises bullet spacing written by the model ("•   x")', () => {
    expect(formatPostText('Gồm:\n•   Một\n•Hai')).toBe('Gồm:\n• Một\n•Hai');
  });

  it('is idempotent', () => {
    const once = formatPostText(REAL_OUTPUT);
    expect(formatPostText(once)).toBe(once);
  });
});

describe('splitTrailingHashtags', () => {
  it('splits hashtags glued to the last sentence', () => {
    const { body, hashtags } = splitTrailingHashtags('Bạn nghĩ sao? #AIVanPhong #QuanLyDuAn');
    expect(body).toBe('Bạn nghĩ sao?');
    expect(hashtags).toEqual(['AIVanPhong', 'QuanLyDuAn']);
  });

  it('handles Vietnamese letters and a separate hashtag line, de-duplicating', () => {
    const { body, hashtags } = splitTrailingHashtags('Nội dung.\n\n#ThủThuật #AI #AI');
    expect(body).toBe('Nội dung.');
    expect(hashtags).toEqual(['ThủThuật', 'AI']);
  });

  it('leaves hashtags that are inside sentences', () => {
    const { body, hashtags } = splitTrailingHashtags('Dùng #AI để viết email nhanh hơn.');
    expect(body).toBe('Dùng #AI để viết email nhanh hơn.');
    expect(hashtags).toEqual([]);
  });
});
