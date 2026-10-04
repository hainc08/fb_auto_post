import { describe, it, expect } from 'vitest';
import { draftProblem, draftScript, mergeScenes, parseDraft, sceneStarts, type ReelScene } from '../src/lib/reel/scenes';
import { buildReelScriptPrompt, cleanScenes, DEFAULT_REEL_INSTRUCTIONS } from '../src/lib/reel/script-prompt';
import type { ReelWord } from '../src/lib/reel/subtitles';

const scene = (id: string, text: string, image: string | null = null): ReelScene => ({ id, text, imagePrompt: `prompt ${id}`, image });
/** Words 300 ms long, back to back from 0 */
const marks = (n: number): ReelWord[] => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * 300, durationMs: 300 }));

describe('draft', () => {
  it('the script is the scenes read one after another', () => {
    expect(draftScript([{ text: ' Bạn có biết? ' }, { text: '' }, { text: 'Thử ngay!' }])).toBe('Bạn có biết? Thử ngay!');
  });

  it('says what stops a draft from being rendered', () => {
    expect(draftProblem([])).toBe('Kịch bản chưa có cảnh nào.');
    expect(draftProblem([{ text: 'Một hai ba bốn năm' }, { text: ' — ' }])).toBe('Cảnh 2 chưa có lời đọc.');
    expect(draftProblem([{ text: 'Xin chào bạn' }])).toBe('Kịch bản cần ít nhất 5 từ.');
    expect(draftProblem(Array.from({ length: 9 }, () => ({ text: 'một hai' })))).toBe('Tối đa 8 cảnh.');
    expect(draftProblem([{ text: 'chữ '.repeat(400) }])).toMatch(/tối đa 1500 ký tự/);
    expect(draftProblem([{ text: 'Một hai ba' }, { text: 'bốn năm sáu' }])).toBeNull();
  });

  it('reads a saved draft and ignores anything malformed in it', () => {
    const draft = parseDraft({ voice: 'vi-VN-NamMinhNeural', scenes: [{ id: 'aaaaaaaa', text: 'Một', imagePrompt: 'an office', image: 'p.aaaaaaaa-1.png' }, { id: 5 }, 'x', { id: 'bbbbbbbb', text: 'Hai' }] });
    expect(draft).toEqual({
      voice: 'vi-VN-NamMinhNeural',
      scenes: [
        { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'an office', image: 'p.aaaaaaaa-1.png' },
        { id: 'bbbbbbbb', text: 'Hai', imagePrompt: '', image: null },
      ],
    });
  });

  it('reads a Reel made before scenes existed as one scene', () => {
    expect(parseDraft(null, 'Kịch bản cũ của bài.', 'vi-VN-NamMinhNeural')).toEqual({
      voice: 'vi-VN-NamMinhNeural',
      scenes: [{ id: '00000000', text: 'Kịch bản cũ của bài.', imagePrompt: '', image: null }],
    });
    expect(parseDraft(undefined)).toEqual({ voice: 'vi-VN-HoaiMyNeural', scenes: [] });
  });
});

describe('mergeScenes', () => {
  const current = [scene('aaaaaaaa', 'Một', 'p.aaaaaaaa-1.png'), scene('bbbbbbbb', 'Hai', 'p.bbbbbbbb-1.png'), scene('cccccccc', 'Ba')];
  let n = 0;
  const newId = () => `new0000${++n}`;

  it('keeps the picture of a scene that is still there, in the new order, and reports the pictures to delete', () => {
    n = 0;
    const { scenes, dropped } = mergeScenes(current, [{ id: 'cccccccc', text: 'Ba mới' }, { text: 'Bốn', imagePrompt: 'a desk' }, { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'changed' }], newId);
    expect(scenes).toEqual([
      { id: 'cccccccc', text: 'Ba mới', imagePrompt: 'prompt cccccccc', image: null },
      { id: 'new00001', text: 'Bốn', imagePrompt: 'a desk', image: null },
      { id: 'aaaaaaaa', text: 'Một', imagePrompt: 'changed', image: 'p.aaaaaaaa-1.png' },
    ]);
    expect(dropped).toEqual(['p.bbbbbbbb-1.png']);
  });

  it('an unknown or repeated id is a new scene', () => {
    n = 0;
    const { scenes } = mergeScenes(current, [{ id: 'aaaaaaaa', text: 'x' }, { id: 'aaaaaaaa', text: 'y' }, { id: 'zzzzzzzz', text: 'z' }], newId);
    expect(scenes.map((s) => [s.id, s.image])).toEqual([['aaaaaaaa', 'p.aaaaaaaa-1.png'], ['new00001', null], ['new00002', null]]);
  });
});

describe('sceneStarts', () => {
  it('a scene starts at its first spoken word', () => {
    // 4 words, 2 words, 3 words
    expect(sceneStarts(['Bạn mất bao lâu?', 'Thử ngay!', '— Cảm ơn bạn'], marks(9))).toEqual([0, 1200, 1800]);
    expect(sceneStarts(['Một cảnh duy nhất'], marks(4))).toEqual([0]);
    expect(sceneStarts([], marks(3))).toEqual([]);
  });

  it('shares the time by text length when the counts differ', () => {
    // 3 tokens in the scenes, 5 marks from the voice (it split a number): the voice ends at 1500 ms
    expect(sceneStarts(['aaaa bbbb', 'cc'], marks(5))).toEqual([0, 1227]);
    // never out of order, never past the end
    const starts = sceneStarts(['a', 'b', 'c'], marks(7));
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(starts[2]).toBeLessThan(2100);
  });

  it('copes with no word marks at all', () => {
    expect(sceneStarts(['a b', 'c d'], [])).toEqual([0, 0]);
  });
});

describe('Reel script prompt', () => {
  it('uses the built-in instructions without a domain', () => {
    const { systemInstruction, prompt } = buildReelScriptPrompt({ caption: '  Bài viết về email.  ' });
    expect(systemInstruction).toContain('3 đến 6 cảnh');
    expect(systemInstruction).toContain('image_prompt');
    expect(systemInstruction).toContain(DEFAULT_REEL_INSTRUCTIONS);
    expect(systemInstruction).not.toContain('Lĩnh vực:');
    expect(prompt).toBe('Bài viết:\nBài viết về email.\n\nViết kịch bản Reels theo từng cảnh.');
  });

  it("uses the domain's audience, voice, rules and its own instructions", () => {
    const { systemInstruction } = buildReelScriptPrompt({
      caption: 'x',
      domain: { name: 'AI văn phòng', audience: 'Dân văn phòng', voice: 'Thân thiện', rules: 'Không dùng từ tiếng Anh', reelInstructions: '  Kể một câu chuyện ngắn.  ' },
    });
    expect(systemInstruction).toContain('Lĩnh vực: AI văn phòng');
    expect(systemInstruction).toContain('Đối tượng: Dân văn phòng');
    expect(systemInstruction).toContain('Giọng văn: Thân thiện');
    expect(systemInstruction).toContain('Quy tắc: Không dùng từ tiếng Anh');
    expect(systemInstruction).toContain('Cách viết kịch bản:\nKể một câu chuyện ngắn.');
    expect(systemInstruction).not.toContain(DEFAULT_REEL_INSTRUCTIONS);
  });

  it('a domain with no instructions of its own gets the built-in ones', () => {
    expect(buildReelScriptPrompt({ caption: 'x', domain: { name: 'A', reelInstructions: '   ' } }).systemInstruction).toContain(DEFAULT_REEL_INSTRUCTIONS);
  });

  it('cleans what the model returns', () => {
    expect(cleanScenes([{ text: '  Bạn   có biết?\n', image_prompt: ' an office  at night ' }, { text: '   ' }, { image_prompt: 'x' }, { text: 'Thử ngay!' }])).toEqual([
      { text: 'Bạn có biết?', imagePrompt: 'an office at night' },
      { text: 'Thử ngay!', imagePrompt: '' },
    ]);
    expect(cleanScenes(Array.from({ length: 12 }, (_, i) => ({ text: `Cảnh ${i}` })))).toHaveLength(8);
  });
});
