import { describe, it, expect } from 'vitest';
import { imageGuideOf, legacyWritingPrompt, writingPromptOf } from '../src/lib/domain-prompt';

const old = {
  description: 'Bao bì nhựa cho nông sản',
  audience: 'Chủ vựa, nhà vườn',
  voice: 'Gần gũi, thực tế',
  rules: 'Không nêu giá',
};

describe('domain prompt', () => {
  it('joins the old four fields in the order the writing prompt used them', () => {
    expect(legacyWritingPrompt(old)).toBe('Bao bì nhựa cho nông sản\nĐối tượng độc giả: Chủ vựa, nhà vườn\nGiọng văn: Gần gũi, thực tế\nQuy tắc bắt buộc: Không nêu giá');
    expect(legacyWritingPrompt({ audience: '  ', voice: 'Vui', rules: null })).toBe('Giọng văn: Vui');
    expect(legacyWritingPrompt({})).toBe('');
  });

  it('uses the saved writing prompt, even when empty, and the old fields only when it was never saved', () => {
    expect(writingPromptOf({ ...old, writingPrompt: '  Viết như người làm vườn.\n\nKhông nêu giá.  ' })).toBe('Viết như người làm vườn.\n\nKhông nêu giá.');
    expect(writingPromptOf({ ...old, writingPrompt: '' })).toBe('');
    expect(writingPromptOf({ ...old, writingPrompt: null })).toBe(legacyWritingPrompt(old));
    expect(writingPromptOf(old)).toBe(legacyWritingPrompt(old));
  });

  it('uses the image guide, else the old image style', () => {
    expect(imageGuideOf({ imageGuide: 'watercolor, warm light', imageStyle: 'flat' })).toBe('watercolor, warm light');
    expect(imageGuideOf({ imageGuide: '', imageStyle: 'flat' })).toBe('');
    expect(imageGuideOf({ imageGuide: null, imageStyle: ' flat ' })).toBe('flat');
    expect(imageGuideOf({})).toBe('');
  });
});
