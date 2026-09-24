import { Type } from '@google/genai';
import { z } from 'zod';
import { GeminiClient } from '../lib/clients/gemini';
import { formatPostText, splitTrailingHashtags } from '../lib/format-post';
import { logger } from '../utils/logger';

/**
 * AI Service - Google Gemini Integration
 * Handles content generation for Facebook posts
 */

/** Gemini credentials come from Settings (lib/settings), not directly from .env */
export interface GeminiCredentials {
  apiKey: string;
  model: string;
}

export interface GeneratedContent {
  caption: string;
  hashtags: string[];
  imagePrompt: string;
  callToAction: string;
}

export interface ContentGenerationInput {
  gemini: GeminiCredentials;
  templatePrompt: string;
  variables?: Record<string, string>;
  language?: string;
  tone?: string;
  maxLength?: number;
}

/**
 * Where the idea goes inside the Settings system prompt: `{{topic}}`, or the
 * n8n-style `{{ $json["nội dung"] }}` carried over from the old workflow.
 */
const IDEA_PLACEHOLDER = /\{\{\s*(?:topic|\$json\[[^\]]*\])\s*\}\}/g;

/**
 * Build the generation prompt for "basic input" posts (no template):
 * put the idea into the placeholder if the prompt has one, otherwise append it.
 */
export function buildIdeaPrompt(systemPrompt: string, idea: string): string {
  const withIdea = systemPrompt.replace(IDEA_PLACEHOLDER, idea.trim());
  return withIdea !== systemPrompt ? withIdea : `${systemPrompt}\n\nThông tin cơ bản:\n${idea.trim()}`;
}

const IDEA_POST_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    post: { type: Type.STRING },
    image_prompt: { type: Type.STRING },
  },
  required: ['post', 'image_prompt'],
  propertyOrdering: ['post', 'image_prompt'],
};

const ideaPostValidator = z.object({
  post: z.string().min(1),
  image_prompt: z.string().min(1),
});

/**
 * Write a post from an idea using ONLY the Settings system prompt (no extra
 * house rules), output `{ post, image_prompt }`. The post is then cleaned up
 * for Facebook and its trailing hashtags are split off, so publishing puts
 * them on the last line.
 */
export async function generateFromIdea(input: {
  gemini: GeminiCredentials;
  systemPrompt: string;
  idea: string;
}): Promise<GeneratedContent> {
  const { gemini, systemPrompt, idea } = input;

  try {
    const client = new GeminiClient(gemini);
    const result = await client.generateJson({
      systemInstruction: buildIdeaPrompt(systemPrompt, idea),
      prompt: `Viết bài Facebook cho ý tưởng: ${idea.trim()}`,
      responseSchema: IDEA_POST_SCHEMA,
      validator: ideaPostValidator,
      temperature: 0.7,
    });

    const { body, hashtags } = splitTrailingHashtags(formatPostText(result.post));
    logger.debug('Gemini generated post from idea', { length: body.length, hashtags: hashtags.length });

    return { caption: body, hashtags, imagePrompt: result.image_prompt.trim(), callToAction: '' };
  } catch (error) {
    logger.error('Failed to generate post from idea:', { error: (error as Error).message });
    throw new Error(`AI content generation failed: ${(error as Error).message}`);
  }
}

/**
 * Replace template variables: {{variable}} → actual value
 */
function interpolateTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] || match;
  });
}

const GENERATED_CONTENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    caption: { type: Type.STRING },
    hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
    imagePrompt: { type: Type.STRING },
    callToAction: { type: Type.STRING },
  },
  required: ['caption', 'hashtags', 'imagePrompt'],
  propertyOrdering: ['caption', 'hashtags', 'imagePrompt', 'callToAction'],
};

const generatedContentValidator = z.object({
  caption: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  imagePrompt: z.string().min(1),
  callToAction: z.string().default(''),
});

/**
 * Generate Facebook post content using Google Gemini
 */
export async function generatePostContent(input: ContentGenerationInput): Promise<GeneratedContent> {
  const { gemini, templatePrompt, variables = {}, language = 'vi', tone = 'professional', maxLength = 500 } = input;

  // Interpolate template variables
  const userPrompt = interpolateTemplate(templatePrompt, variables);

  const systemPrompt = `Bạn là một chuyên gia viết nội dung social media cho Facebook.
Nhiệm vụ: Tạo bài đăng Facebook hấp dẫn, chuyên nghiệp dựa trên yêu cầu của người dùng.

Quy tắc:
- Viết bằng ngôn ngữ: ${language === 'vi' ? 'Tiếng Việt' : 'English'}
- Giọng điệu: ${tone}
- Caption tối đa ${maxLength} ký tự
- Tạo 5-10 hashtags phù hợp
- Đề xuất prompt tạo ảnh AI bằng tiếng Anh (mô tả ảnh phù hợp với nội dung)
- Thêm call-to-action phù hợp
- Sử dụng emoji một cách hợp lý
- Không dùng markdown format trong caption

Trả về dưới dạng JSON CHÍNH XÁC theo format sau (không thêm markdown code block):
{
  "caption": "Nội dung caption đầy đủ bao gồm emoji",
  "hashtags": ["hashtag1", "hashtag2"],
  "imagePrompt": "English prompt for AI image generation, detailed, high quality",
  "callToAction": "Câu kêu gọi hành động"
}`;

  try {
    const client = new GeminiClient(gemini);
    const parsed = await client.generateJson({
      systemInstruction: systemPrompt,
      prompt: `Yêu cầu: ${userPrompt}`,
      responseSchema: GENERATED_CONTENT_SCHEMA,
      validator: generatedContentValidator,
    });

    logger.debug('Gemini generated content', { captionLength: parsed.caption.length });
    return { ...parsed, caption: formatPostText(parsed.caption) };
  } catch (error) {
    logger.error('Failed to generate content with Gemini:', { error: (error as Error).message });
    throw new Error(`AI content generation failed: ${(error as Error).message}`);
  }
}

/**
 * Improve/rewrite existing caption
 */
export async function improveCaption(
  gemini: GeminiCredentials,
  originalCaption: string,
  instruction: string
): Promise<string> {
  try {
    const client = new GeminiClient(gemini);

    const prompt = `Viết lại caption Facebook sau theo hướng dẫn.

Caption gốc:
${originalCaption}

Hướng dẫn: ${instruction}

Chỉ trả về caption mới, không giải thích.`;

    let result;
    try {
      result = await client.ai.models.generateContent({
        model: client.model,
        contents: prompt,
        config: { temperature: 0.7, maxOutputTokens: 8192 },
      });
    } catch (error) {
      throw client.toGeminiError(error);
    }
    return formatPostText(result.text ?? '');
  } catch (error) {
    logger.error('Failed to improve caption:', error);
    throw new Error(`Caption improvement failed: ${(error as Error).message}`);
  }
}
