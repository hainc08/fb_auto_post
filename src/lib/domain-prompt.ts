/**
 * The two prompts of a content domain, as the member edits them (pure; tests/domain-prompt.test.ts):
 * "Prompt viết bài" and "Prompt tạo ảnh". A domain saved before they existed keeps its old fields
 * (description, audience, voice, rules; imageStyle); `null` means "never saved", '' means "saved empty".
 */

export interface LegacyWritingFields {
  description?: string | null;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
}

/** The old four fields as one text, in the order the writing prompt used them */
export function legacyWritingPrompt(d: LegacyWritingFields): string {
  const part = (label: string | null, value?: string | null) => {
    const text = (value ?? '').trim();
    return text ? (label ? `${label}: ${text}` : text) : '';
  };
  return [part(null, d.description), part('Đối tượng độc giả', d.audience), part('Giọng văn', d.voice), part('Quy tắc bắt buộc', d.rules)]
    .filter(Boolean)
    .join('\n');
}

/** "Prompt viết bài": the saved one, else (never saved) the old fields */
export function writingPromptOf(d: LegacyWritingFields & { writingPrompt?: string | null }): string {
  return d.writingPrompt !== null && d.writingPrompt !== undefined ? d.writingPrompt.trim() : legacyWritingPrompt(d);
}

/** "Prompt tạo ảnh": the saved one, else (never saved) the old image style */
export function imageGuideOf(d: { imageGuide?: string | null; imageStyle?: string | null }): string {
  return (d.imageGuide !== null && d.imageGuide !== undefined ? d.imageGuide : (d.imageStyle ?? '')).trim();
}

/**
 * The domain's guidance for the other AI prompts (comment replies, Reel scripts, idea suggestions): the saved writing
 * prompt as one block, else the old audience, voice and rules lines
 */
export function domainGuideLines(d: { audience?: string | null; voice?: string | null; rules?: string | null; writingPrompt?: string | null }): string[] {
  if (d.writingPrompt !== null && d.writingPrompt !== undefined) {
    const text = d.writingPrompt.trim();
    return text ? ['Hướng dẫn viết của lĩnh vực:', text] : [];
  }
  const lines: string[] = [];
  if (d.audience?.trim()) lines.push(`Đối tượng: ${d.audience.trim()}`);
  if (d.voice?.trim()) lines.push(`Giọng văn: ${d.voice.trim()}`);
  if (d.rules?.trim()) lines.push(`Quy tắc: ${d.rules.trim()}`);
  return lines;
}
