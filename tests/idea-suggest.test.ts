import { describe, it, expect } from 'vitest';
import { buildIdeaSuggestPrompt, cleanSuggestions } from '../src/lib/idea-suggest';

describe('buildIdeaSuggestPrompt', () => {
  it('describes the domain and lists what to avoid', () => {
    const { systemInstruction, prompt } = buildIdeaSuggestPrompt({
      domain: { name: 'Nhà nông', audience: 'Nông dân miền Tây', voice: 'Gần gũi' },
      format: { name: 'Mẹo nhanh', instructions: 'Một mẹo cụ thể' },
      avoid: ['Tưới lúa mùa khô'],
      count: 10,
    });
    expect(systemInstruction).toMatch(/Nhà nông/);
    expect(systemInstruction).toMatch(/Nông dân miền Tây/);
    expect(prompt).toMatch(/10 ý tưởng/);
    expect(prompt).toMatch(/Tưới lúa mùa khô/);
  });
});

describe('cleanSuggestions', () => {
  it('trims, drops duplicates (also against existing ideas, ignoring case and extra spaces) and caps the count', () => {
    const got = cleanSuggestions(['  Phòng rầy nâu ', 'phòng  rầy nâu', 'Tưới lúa mùa khô', 'ab', 'Bón phân đúng lúc', 'x'.repeat(600)], ['TƯỚI LÚA MÙA KHÔ'], 2);
    expect(got).toEqual(['Phòng rầy nâu', 'Bón phân đúng lúc']);
  });
});

describe('idea suggestions with the domain writing prompt', () => {
  it('a saved writing prompt replaces the description, audience, voice and rules lines', () => {
    const { systemInstruction } = buildIdeaSuggestPrompt({
      domain: { name: 'BVTV', description: 'Cũ', audience: 'Cũ', voice: 'Cũ', rules: 'Cũ', writingPrompt: 'Nông dân miền Tây.' },
      format: { name: 'Mẹo', instructions: 'Ngắn' },
      avoid: [],
      count: 5,
    });
    expect(systemInstruction).toContain('Lĩnh vực: BVTV\nHướng dẫn viết của lĩnh vực:\nNông dân miền Tây.\n');
    expect(systemInstruction).not.toContain('Mô tả: Cũ');
  });
});
