import { describe, it, expect } from 'vitest';
import { buildIdeaPrompt } from '../src/services/ai.service';

describe('buildIdeaPrompt', () => {
  it('fills the n8n placeholder carried over from the old workflow', () => {
    const prompt = 'Ý tưởng đầu vào:\n{{ $json["nội dung"] }}\n\nQUY TẮC…';
    expect(buildIdeaPrompt(prompt, '  Tóm tắt biên bản họp  ')).toBe('Ý tưởng đầu vào:\nTóm tắt biên bản họp\n\nQUY TẮC…');
  });

  it('fills {{topic}} (every occurrence)', () => {
    expect(buildIdeaPrompt('A {{topic}} B {{ topic }}', 'X')).toBe('A X B X');
  });

  it('appends the idea when the prompt has no placeholder', () => {
    expect(buildIdeaPrompt('Bạn là chuyên gia.', 'Khuyến mãi 50%')).toBe('Bạn là chuyên gia.\n\nThông tin cơ bản:\nKhuyến mãi 50%');
  });

  it('is stable across calls (global regex state is not reused)', () => {
    const p = 'X {{topic}}';
    expect(buildIdeaPrompt(p, '1')).toBe('X 1');
    expect(buildIdeaPrompt(p, '2')).toBe('X 2');
  });
});
