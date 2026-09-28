import { describe, it, expect, vi } from 'vitest';
import { GeminiClient } from '../src/lib/clients/gemini';
import { generateWithFormat } from '../src/services/ai.service';
import { buildIdeaPrompt, type PromptFormat } from '../src/lib/compose-prompt';

const gemini = { apiKey: 'AIzaFakeKeyForUnitTests000000000000000', model: 'gemini-2.5-flash' };
const format: PromptFormat = { name: 'Bài chuẩn', instructions: 'Prompt cũ.', example: null, length: 'MEDIUM', withImage: true, legacyPrompt: true };

describe('generateWithFormat', () => {
  it('legacy format: same Gemini request as the old generateFromIdea', async () => {
    const spy = vi
      .spyOn(GeminiClient.prototype, 'generateJson')
      .mockResolvedValue({ post: 'Nội dung bài\n\n#A #B', image_prompt: ' a cat ' } as never);
    const out = await generateWithFormat({ gemini, domain: { name: 'Mặc định' }, format, idea: ' Ý tưởng ' });

    const call = spy.mock.calls[0][0] as { systemInstruction: string; prompt: string; temperature?: number };
    expect(call.systemInstruction).toBe(buildIdeaPrompt('Prompt cũ.', ' Ý tưởng '));
    expect(call.prompt).toBe('Viết bài Facebook cho ý tưởng: Ý tưởng');
    expect(call.temperature).toBe(0.7);
    expect(out).toMatchObject({ caption: 'Nội dung bài', hashtags: ['A', 'B'], imagePrompt: 'a cat', prompt: call.systemInstruction });
  });

  it("adds the domain's default hashtags", async () => {
    vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Bài\n\n#hoc', image_prompt: 'x' } as never);
    const out = await generateWithFormat({
      gemini,
      domain: { name: 'Tiếng Nhật', defaultHashtags: ['Hoc', 'NhatNgu'] },
      format: { ...format, legacyPrompt: false },
      idea: 'x',
    });
    expect(out.hashtags).toEqual(['hoc', 'NhatNgu']);
  });

  it('text-only format: asks for no image prompt and returns an empty one', async () => {
    const spy = vi.spyOn(GeminiClient.prototype, 'generateJson').mockResolvedValue({ post: 'Chỉ chữ' } as never);
    const out = await generateWithFormat({ gemini, domain: { name: 'X' }, format: { ...format, legacyPrompt: false, withImage: false }, idea: 'x' });
    const schema = (spy.mock.calls[0][0] as { responseSchema: { required: string[] } }).responseSchema;
    expect(schema.required).toEqual(['post']);
    expect(out.imagePrompt).toBe('');
    expect(out.prompt).not.toMatch('image_prompt');
  });
});
