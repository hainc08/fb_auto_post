import type { PromptDomain, PromptFormat } from './compose-prompt';

/** Pure: the Gemini prompt for "suggest N post ideas" and the clean-up of its answer. */

const line = (label: string, value?: string | null) => (value?.trim() ? `${label}: ${value.trim()}\n` : '');
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function buildIdeaSuggestPrompt(input: {
  domain: PromptDomain;
  format: Pick<PromptFormat, 'name' | 'instructions'>;
  avoid: string[];
  count: number;
}): { systemInstruction: string; prompt: string } {
  const { domain, format } = input;
  const systemInstruction =
    'Bạn là chuyên gia nội dung Fanpage Facebook tại Việt Nam.\n' +
    line('Lĩnh vực', domain.name) +
    line('Mô tả', domain.description) +
    line('Đối tượng đọc', domain.audience) +
    line('Giọng văn', domain.voice) +
    line('Quy tắc', domain.rules) +
    line('Định dạng bài', `${format.name} — ${format.instructions}`);
  const avoid = input.avoid
    .slice(0, 80)
    .map((a) => `- ${a}`)
    .join('\n');
  const prompt =
    `Đề xuất ${input.count} ý tưởng bài đăng mới, mỗi ý tưởng một câu ngắn (tối đa 150 ký tự), cụ thể, khác nhau, ` +
    'viết bằng tiếng Việt, hợp với lĩnh vực và định dạng trên.' +
    (avoid ? `\nKhông lặp lại hoặc gần giống các ý đã có:\n${avoid}` : '');
  return { systemInstruction, prompt };
}

export function cleanSuggestions(raw: string[], avoid: string[], count: number): string[] {
  const seen = new Set(avoid.map(key));
  const out: string[] = [];
  for (const r of raw) {
    const text = r.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || text.length > 500 || seen.has(key(text))) continue;
    seen.add(key(text));
    out.push(text);
    if (out.length === count) break;
  }
  return out;
}
