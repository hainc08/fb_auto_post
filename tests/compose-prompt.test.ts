import { describe, it, expect } from 'vitest';
import { buildIdeaPrompt, composePrompt, mergeHashtags, styledImagePrompt, type PromptDomain, type PromptFormat } from '../src/lib/compose-prompt';

const domain: PromptDomain = {
  name: 'Tiếng Nhật',
  description: 'Học tiếng Nhật cho người đi làm',
  audience: 'Nhân viên văn phòng 25–35 tuổi',
  voice: 'Thân thiện, dí dỏm',
  rules: 'Luôn có 1 ví dụ tiếng Nhật kèm phiên âm',
  imageStyle: 'flat illustration, pastel colors',
};
const format: PromptFormat = {
  name: 'Hỏi đáp',
  instructions: 'Mở bằng câu hỏi, trả lời ngắn, giải thích 3 câu.',
  example: 'Hỏi: "Sumimasen" dùng khi nào?',
  length: 'MEDIUM',
  withImage: true,
  legacyPrompt: false,
};

describe('composePrompt', () => {
  it('builds every block in order and appends the idea when no field uses it', () => {
    const prompt = composePrompt({ domain, format, idea: '  Cách chào sếp  ' });
    expect(prompt).toBe(
      [
        'Bạn là người viết nội dung Facebook cho lĩnh vực "Tiếng Nhật" — Học tiếng Nhật cho người đi làm.',
        'Đối tượng độc giả: Nhân viên văn phòng 25–35 tuổi',
        'Giọng văn: Thân thiện, dí dỏm',
        'Quy tắc bắt buộc: Luôn có 1 ví dụ tiếng Nhật kèm phiên âm',
        '',
        'Định dạng bài "Hỏi đáp":',
        'Mở bằng câu hỏi, trả lời ngắn, giải thích 3 câu.',
        'Độ dài: khoảng 150–250 từ.',
        '',
        'Bài mẫu để tham khảo phong cách (không chép lại):',
        'Hỏi: "Sumimasen" dùng khi nào?',
        '',
        'image_prompt: tiếng Anh; mô tả chủ thể, bối cảnh, ánh sáng; phong cách: flat illustration, pastel colors; không chữ, không logo, không người nổi tiếng.',
        'Chỉ trả về JSON đúng schema.',
        '',
        'Ý tưởng bài viết: Cách chào sếp',
      ].join('\n')
    );
  });

  it('drops empty blocks', () => {
    const prompt = composePrompt({
      domain: { name: 'Chung' },
      format: { ...format, example: '  ', length: 'SHORT' },
      idea: 'x',
    });
    expect(prompt).not.toMatch(/Đối tượng|Giọng văn|Quy tắc|Bài mẫu|phong cách:/);
    expect(prompt).toMatch(/^Bạn là người viết nội dung Facebook cho lĩnh vực "Chung"\.\n\nĐịnh dạng bài/);
    expect(prompt).toMatch(/khoảng 80–120 từ/);
  });

  it('fills {{idea}}, {{topic}}, n8n and {{page_name}}/{{audience}} variables, and then does not append the idea', () => {
    const prompt = composePrompt({
      domain: { ...domain, rules: 'Nhắc tên {{ page_name }} ở cuối' },
      format: { ...format, instructions: 'Chủ đề: {{idea}}. Viết cho {{audience}}. Nhắc lại {{ $json["nội dung"] }}', example: null },
      idea: 'Chào sếp',
      pageName: 'Nihongo Mỗi Ngày',
    });
    expect(prompt).toMatch('Quy tắc bắt buộc: Nhắc tên Nihongo Mỗi Ngày ở cuối');
    expect(prompt).toMatch('Chủ đề: Chào sếp. Viết cho Nhân viên văn phòng 25–35 tuổi. Nhắc lại Chào sếp');
    expect(prompt).not.toMatch('Ý tưởng bài viết:');
  });

  it('text-only formats drop the image_prompt line', () => {
    expect(composePrompt({ domain, format: { ...format, withImage: false }, idea: 'x' })).not.toMatch('image_prompt');
  });

  it('legacy formats use the old system prompt verbatim', () => {
    const legacy = { ...format, legacyPrompt: true, instructions: 'Prompt cũ {{topic}} hết.' };
    expect(composePrompt({ domain, format: legacy, idea: ' Ý ' })).toBe(buildIdeaPrompt('Prompt cũ {{topic}} hết.', ' Ý '));
    expect(composePrompt({ domain, format: legacy, idea: ' Ý ' })).toBe('Prompt cũ Ý hết.');
  });
});

describe('mergeHashtags', () => {
  it('adds defaults without "#", drops case-insensitive duplicates, caps at 30', () => {
    expect(mergeHashtags(['Tieng Nhat', 'hoc'], ['#Hoc', ' NhatNgu ', '', 5])).toEqual(['TiengNhat', 'hoc', 'NhatNgu']);
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(mergeHashtags(many, ['x'])).toHaveLength(30);
  });

  it('returns the AI tags untouched when the domain has no defaults (legacy output stays identical)', () => {
    const ai = ['A', 'a', 'B'];
    expect(mergeHashtags(ai, null)).toBe(ai);
    expect(mergeHashtags(ai, [])).toBe(ai);
  });
});

describe('styledImagePrompt', () => {
  it('prefixes the domain style when there is one', () => {
    expect(styledImagePrompt(' watercolor ', ' a cat ')).toBe('watercolor. a cat');
    expect(styledImagePrompt(null, 'a cat')).toBe('a cat');
  });
});
