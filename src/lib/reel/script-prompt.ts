import { MAX_SCENES } from './scenes';

/** The prompt AI writes a Reel's scenes from (pure; tested from tests/reel-scenes.test.ts). */

export interface ReelPromptDomain {
  name: string;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  /** The member's own "how to write Reel scripts" for this domain; empty = DEFAULT_REEL_INSTRUCTIONS */
  reelInstructions?: string | null;
}

export const DEFAULT_REEL_INSTRUCTIONS = [
  '- Tổng cộng 40 đến 100 từ, đọc lên trong 20–40 giây.',
  '- Cảnh đầu là một câu hỏi hoặc một tình huống gây tò mò; các cảnh giữa nói một ý chính; cảnh cuối kêu gọi hành động.',
  '- Câu ngắn, văn nói tự nhiên.',
].join('\n');

export function buildReelScriptPrompt(input: { caption: string; domain?: ReelPromptDomain | null }): { systemInstruction: string; prompt: string } {
  const d = input.domain;
  const lines = [
    'Bạn viết kịch bản lời đọc cho video Reels dọc trên Facebook, bằng tiếng Việt.',
    'Chia kịch bản thành 3 đến 6 cảnh. Mỗi cảnh gồm:',
    '- text: lời đọc của cảnh, 1–2 câu. Không hashtag, không emoji, không đường link, không gạch đầu dòng.',
    '- image_prompt: mô tả bằng tiếng Anh một hình minh hoạ cho đúng cảnh đó (bối cảnh, nhân vật, hành động). Không có chữ trong hình.',
    'Chỉ dùng thông tin có trong bài viết được cung cấp.',
  ];
  if (d) {
    lines.push('', `Lĩnh vực: ${d.name}`);
    if (d.audience?.trim()) lines.push(`Đối tượng: ${d.audience.trim()}`);
    if (d.voice?.trim()) lines.push(`Giọng văn: ${d.voice.trim()}`);
    if (d.rules?.trim()) lines.push(`Quy tắc: ${d.rules.trim()}`);
  }
  lines.push('', 'Cách viết kịch bản:', d?.reelInstructions?.trim() || DEFAULT_REEL_INSTRUCTIONS);
  return { systemInstruction: lines.join('\n'), prompt: `Bài viết:\n${input.caption.trim()}\n\nViết kịch bản Reels theo từng cảnh.` };
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The model's scenes, tidied: one line each, empty ones dropped, at most MAX_SCENES */
export function cleanScenes(raw: Array<{ text?: string; image_prompt?: string }>): Array<{ text: string; imagePrompt: string }> {
  return raw
    .map((s) => ({ text: oneLine(s.text), imagePrompt: oneLine(s.image_prompt) }))
    .filter((s) => s.text)
    .slice(0, MAX_SCENES);
}
