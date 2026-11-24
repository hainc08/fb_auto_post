/**
 * Prompt for "Viết lại bằng AI" in the post editor (pure; tests/rewrite-prompt.test.ts): the member's instruction or a
 * full rewrite by the domain's writing prompt and the post's format, with the rules every rewrite keeps.
 */

import { LENGTH_WORDS, type PromptDomain, type PromptFormat } from './compose-prompt';
import { writingPromptOf } from './domain-prompt';

export type RewriteMode = 'instruction' | 'domain';

/** What "Viết lại theo lĩnh vực" asks for */
export const DOMAIN_REWRITE = 'Viết lại toàn bộ bài theo hướng dẫn của lĩnh vực và định dạng bài, giữ ý chính.';

/** `{{idea}}`, `{{topic}}`, `{{ $json[…] }}`: the idea a prompt was written around is the post itself here */
const IDEA_VARS = /\{\{\s*(?:idea|topic|\$json\[[^\]]*\])\s*\}\}/g;

export function buildRewritePrompt(input: {
  domain: PromptDomain;
  format: PromptFormat;
  caption: string;
  instruction?: string | null;
  mode: RewriteMode;
}): string {
  const { domain, format, mode } = input;
  const instruction = (input.instruction ?? '').trim();

  const guide = format.legacyPrompt
    ? ['Hướng dẫn viết:', format.instructions.replace(IDEA_VARS, 'nội dung bài gốc bên dưới').trim()]
    : ['Hướng dẫn viết của lĩnh vực "' + domain.name.trim() + '":', writingPromptOf(domain)];

  const blocks = [
    ['Bạn là biên tập viên nội dung Facebook. Viết lại bài dưới đây.'],
    guide[1] ? guide : [],
    mode === 'domain' && !format.legacyPrompt
      ? [`Định dạng bài "${format.name.trim()}":`, format.instructions.trim(), `Độ dài: khoảng ${LENGTH_WORDS[format.length]} từ.`]
      : [],
    [mode === 'domain' ? `Yêu cầu: ${DOMAIN_REWRITE}${instruction ? ` Thêm: ${instruction}` : ''}` : `Yêu cầu: ${instruction}`],
    [
      'Luôn giữ:',
      '- Giữ đúng các thông tin có thật trong bài (tên, con số, giá, ngày, địa chỉ); không bịa thêm.',
      '- Không thêm link hay số điện thoại không có trong bài gốc.',
      '- Không viết hashtag.',
      '- Chỉ trả về nội dung bài mới, không giải thích.',
    ],
    ['Bài gốc:', input.caption.trim()],
  ];

  return blocks
    .map((b) => b.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}
