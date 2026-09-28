import type { ContentTemplate, Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { createError } from '../middleware/error.middleware';
import type { AppSettings } from '../lib/settings';
import { formatForPost } from '../lib/domains';
import { generatePostContent, generateWithFormat, type GeneratedContent } from './ai.service';

/** One place that turns a post's idea into text — used by the route and the worker. */

export interface WritablePost {
  userId: string;
  pageId: string;
  formatId: string | null;
  template: ContentTemplate | null;
  inputData: Prisma.JsonValue | null;
}

export interface WrittenPost {
  generated: GeneratedContent;
  aiPrompt: string | null;
  domainId: string | null;
  formatId: string | null;
}

export async function writePost(post: WritablePost, settings: AppSettings): Promise<WrittenPost> {
  const variables = (post.inputData as Record<string, string> | null) ?? {};
  const gemini = { apiKey: settings.geminiApiKey, model: settings.geminiModel };

  // Legacy posts created from a content template
  if (post.template) {
    const generated = await generatePostContent({ gemini, templatePrompt: post.template.promptTemplate, variables });
    return { generated, aiPrompt: null, domainId: null, formatId: null };
  }

  const idea = variables.basicInfo?.trim();
  if (!idea) throw createError(400, 'Hãy nhập ý tưởng / thông tin cơ bản cho bài viết.');
  const { domain, format } = await formatForPost(post);
  const page = await prisma.facebookPage.findUnique({ where: { id: post.pageId }, select: { pageName: true } });
  const { prompt, ...generated } = await generateWithFormat({ gemini, domain, format, idea, pageName: page?.pageName });
  return { generated, aiPrompt: prompt, domainId: domain.id, formatId: format.id };
}

/** Visual style of the post's domain, prefixed to AI image prompts. */
export async function imageStyleOf(domainId: string | null): Promise<string | null> {
  if (!domainId) return null;
  const domain = await prisma.contentDomain.findUnique({ where: { id: domainId }, select: { imageStyle: true } });
  return domain?.imageStyle ?? null;
}
