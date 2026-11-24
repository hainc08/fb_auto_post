import { describe, it, expect } from 'vitest';
import { buildRewritePrompt, DOMAIN_REWRITE } from '../src/lib/rewrite-prompt';
import type { PromptDomain, PromptFormat } from '../src/lib/compose-prompt';

const domain: PromptDomain = { name: 'Bao bì', description: 'Bao bì nông sản', audience: 'Chủ vựa', voice: 'Gần gũi', rules: 'Không nêu giá', writingPrompt: null };
const format: PromptFormat = { name: 'Mẹo', instructions: 'Mở bằng câu hỏi, 3 đoạn.', length: 'SHORT', withImage: true, legacyPrompt: false };
const caption = 'Bao 25kg giá 12.000đ, gọi 0909 123 456.';

describe('buildRewritePrompt', () => {
  it('rewrites by the member instruction with the domain guidance and the safety rules', () => {
    const p = buildRewritePrompt({ domain: { ...domain, writingPrompt: 'Viết cho chủ vựa miền Tây, xưng em.' }, format, caption, instruction: 'Thêm ưu đãi cuối bài', mode: 'instruction' });
    expect(p).toContain('Hướng dẫn viết của lĩnh vực "Bao bì":\nViết cho chủ vựa miền Tây, xưng em.');
    expect(p).toContain('Yêu cầu: Thêm ưu đãi cuối bài');
    expect(p).not.toContain('Mở bằng câu hỏi'); // the format is only for a full rewrite
    expect(p).toContain('không bịa thêm');
    expect(p).toContain('Không thêm link hay số điện thoại');
    expect(p).toContain('Không viết hashtag');
    expect(p.endsWith(`Bài gốc:\n${caption}`)).toBe(true);
  });

  it('reads the old fields of a domain whose writing prompt was never saved', () => {
    const p = buildRewritePrompt({ domain, format, caption, instruction: 'Ngắn hơn', mode: 'instruction' });
    expect(p).toContain('Bao bì nông sản\nĐối tượng độc giả: Chủ vựa\nGiọng văn: Gần gũi\nQuy tắc bắt buộc: Không nêu giá');
  });

  it('a full rewrite follows the format and its length, plus an optional extra instruction', () => {
    const p = buildRewritePrompt({ domain, format, caption, mode: 'domain' });
    expect(p).toContain(`Yêu cầu: ${DOMAIN_REWRITE}`);
    expect(p).toContain('Định dạng bài "Mẹo":\nMở bằng câu hỏi, 3 đoạn.\nĐộ dài: khoảng 80–120 từ.');
    expect(buildRewritePrompt({ domain, format, caption, mode: 'domain', instruction: 'xưng mình' })).toContain(`Yêu cầu: ${DOMAIN_REWRITE} Thêm: xưng mình`);
  });

  it('a legacy format gives its own prompt instead of the domain guidance, without the idea placeholder', () => {
    const legacy = { ...format, legacyPrompt: true, instructions: 'Bạn là chuyên gia. Viết bài về {{topic}}.' };
    const p = buildRewritePrompt({ domain, format: legacy, caption, mode: 'domain' });
    expect(p).toContain('Hướng dẫn viết:\nBạn là chuyên gia. Viết bài về nội dung bài gốc bên dưới.');
    expect(p).not.toContain('Đối tượng độc giả');
    expect(p).not.toContain('{{topic}}');
  });

  it('leaves the guidance out when the domain prompt is saved empty', () => {
    const p = buildRewritePrompt({ domain: { ...domain, writingPrompt: '' }, format, caption, instruction: 'Ngắn hơn', mode: 'instruction' });
    expect(p).not.toContain('Hướng dẫn viết');
  });
});
