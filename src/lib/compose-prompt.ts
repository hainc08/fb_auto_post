/**
 * System prompt for AI posts, built from the user's content domain + format (spec §5.2).
 * Pure functions: no I/O, fully unit-tested.
 */

import { productPromptBlock, type LinkProduct } from './affiliate';
import { imageGuideOf } from './domain-prompt';

export type FormatLength = 'SHORT' | 'MEDIUM' | 'LONG';

export const LENGTH_WORDS: Record<FormatLength, string> = { SHORT: '80–120', MEDIUM: '150–250', LONG: '300–450' };

export interface PromptDomain {
  name: string;
  description?: string | null;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  imageStyle?: string | null;
  /** "Prompt viết bài": replaces description, audience, voice and rules once saved (null = never saved) */
  writingPrompt?: string | null;
  /** "Prompt tạo ảnh": replaces imageStyle once saved */
  imageGuide?: string | null;
}

export interface PromptFormat {
  name: string;
  instructions: string;
  example?: string | null;
  length: FormatLength;
  withImage: boolean;
  legacyPrompt: boolean;
}

/** Old Settings / n8n placeholders: `{{topic}}` or `{{ $json["…"] }}` (legacy behaviour, unchanged). */
const LEGACY_IDEA = /\{\{\s*(?:topic|\$json\[[^\]]*\])\s*\}\}/g;
/** Domain and format fields also accept `{{idea}}`. */
const IDEA_VAR = /\{\{\s*(?:idea|topic|\$json\[[^\]]*\])\s*\}\}/g;
const PAGE_VAR = /\{\{\s*page_name\s*\}\}/g;
const AUDIENCE_VAR = /\{\{\s*audience\s*\}\}/g;

/**
 * The old way: the whole Settings system prompt, with the idea put into its
 * placeholder, or appended when it has none. Kept verbatim for legacy formats.
 */
export function buildIdeaPrompt(systemPrompt: string, idea: string): string {
  const withIdea = systemPrompt.replace(LEGACY_IDEA, idea.trim());
  return withIdea !== systemPrompt ? withIdea : `${systemPrompt}\n\nThông tin cơ bản:\n${idea.trim()}`;
}

export function composePrompt(input: { domain: PromptDomain; format: PromptFormat; idea: string; pageName?: string | null; products?: LinkProduct[] }): string {
  const { domain, format } = input;
  const idea = input.idea.trim();
  const products = productPromptBlock(input.products ?? []);
  if (format.legacyPrompt) {
    const legacy = buildIdeaPrompt(format.instructions, input.idea);
    return products ? `${legacy}

${products}` : legacy;
  }

  let ideaUsed = false;
  const saved = domain.writingPrompt !== null && domain.writingPrompt !== undefined;
  // once the writing prompt is saved the old audience field is no longer shown, so it never fills {{audience}}
  const audience = saved ? '' : (domain.audience ?? '').trim();
  const fill = (text?: string | null): string => {
    const raw = (text ?? '').trim();
    if (!raw) return '';
    return raw
      .replace(IDEA_VAR, () => {
        ideaUsed = true;
        return idea;
      })
      .replace(PAGE_VAR, (input.pageName ?? '').trim())
      .replace(AUDIENCE_VAR, audience);
  };
  const line = (label: string, value: string) => (value ? `${label}: ${value}` : '');

  const description = fill(domain.description);
  const style = imageGuideOf(domain);
  const example = fill(format.example);

  const blocks = [
    saved
      ? [`Bạn là người viết nội dung Facebook cho lĩnh vực "${domain.name.trim()}".`, fill(domain.writingPrompt)]
      : [
          `Bạn là người viết nội dung Facebook cho lĩnh vực "${domain.name.trim()}"${description ? ` — ${description}` : ''}.`,
          line('Đối tượng độc giả', fill(domain.audience)),
          line('Giọng văn', fill(domain.voice)),
          line('Quy tắc bắt buộc', fill(domain.rules)),
        ],
    [`Định dạng bài "${format.name.trim()}":`, fill(format.instructions), `Độ dài: khoảng ${LENGTH_WORDS[format.length]} từ.`],
    example ? ['Bài mẫu để tham khảo phong cách (không chép lại):', example] : [],
    [
      format.withImage
        ? `image_prompt: tiếng Anh; mô tả chủ thể, bối cảnh, ánh sáng${style ? `; phong cách: ${style}` : ''}; không chữ, không logo, không người nổi tiếng.`
        : '',
      products,
      'Chỉ trả về JSON đúng schema.',
    ],
  ];

  const prompt = blocks
    .map((block) => block.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return ideaUsed ? prompt : `${prompt}\n\nÝ tưởng bài viết: ${idea}`;
}

export const cleanTag = (tag: string) => tag.trim().replace(/^#+/, '').replace(/\s+/g, '');

export const toTagList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** AI hashtags + the domain's defaults, no case-insensitive duplicates, at most `max`. */
export function mergeHashtags(ai: string[], defaults: unknown, max = 30): string[] {
  const extra = toTagList(defaults);
  if (extra.length === 0) return ai;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...ai, ...extra]) {
    const tag = cleanTag(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === max) break;
  }
  return out;
}

/** Longest prompt the image models accept (Workers AI flux-1-schnell: 2,048 characters) */
export const IMAGE_PROMPT_MAX = 2048;

/** Image prompt with the domain's visual style in front, shortened to IMAGE_PROMPT_MAX: the style gives way first */
export function styledImagePrompt(imageStyle: string | null | undefined, prompt: string): string {
  const own = prompt.trim().slice(0, IMAGE_PROMPT_MAX);
  const room = IMAGE_PROMPT_MAX - own.length - 2;
  const style = room > 0 ? (imageStyle ?? '').trim().slice(0, room).trim() : '';
  return style ? `${style}. ${own}` : own;
}
