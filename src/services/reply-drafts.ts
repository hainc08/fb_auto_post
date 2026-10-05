import { Type } from '@google/genai';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { toStringArray } from '../utils/json';
import { getSettings } from '../lib/settings';
import { GeminiClient } from '../lib/clients/gemini';
import { COMMENT_REPLY_SCOPE } from '../lib/clients/facebook';
import { buildReplyPrompt, cleanReplies } from '../lib/reply-prompt';

/**
 * "AI soạn trả lời bình luận": a reply draft for each comment that waits for an answer, on Pages that
 * turned it on. Drafts are only stored (PostComment.draftReply): the member sends them from the panel.
 */

/** Comments per Gemini call; the rest wait for the next sync */
const BATCH = 20;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    replies: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { key: { type: Type.STRING }, reply: { type: Type.STRING }, skip: { type: Type.BOOLEAN } }, required: ['key', 'reply', 'skip'] },
    },
  },
  required: ['replies'],
};
const validator = z.object({ replies: z.array(z.object({ key: z.string().optional(), reply: z.string().optional(), skip: z.boolean().optional() })) });

/**
 * Write drafts for the target's comments the AI has not looked at yet; returns how many drafts were written.
 * One Gemini call for all of them. Throws when that call fails: nothing is marked, so the next sync asks again.
 */
export async function draftReplies(targetId: string, now = new Date()): Promise<number> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    include: { page: true, post: { select: { userId: true, caption: true, domainId: true, autoReplyOff: true } } },
  });
  if (!target || !target.page.autoReply || target.post.autoReplyOff) return 0;
  // A draft the member could not send from the app would only be noise
  if (!toStringArray(target.page.grantedScopes).includes(COMMENT_REPLY_SCOPE)) return 0;

  const waiting = await prisma.postComment.findMany({
    where: { targetId, parentFbId: null, fromPage: false, pageReplied: false, handledAt: null, draftCheckedAt: null },
    orderBy: { commentedAt: 'asc' },
    take: BATCH,
  });
  if (!waiting.length) return 0;
  const settings = await getSettings(target.post.userId);
  if (!settings.geminiApiKey) return 0;

  // A sticker or a picture has no text to answer
  const asked = waiting.filter((c) => c.message.trim());
  const keys = asked.map((_, i) => `c${i + 1}`);
  let replies = new Map<string, string | null>();
  if (asked.length) {
    const domain = target.post.domainId
      ? await prisma.contentDomain.findUnique({ where: { id: target.post.domainId }, select: { name: true, audience: true, voice: true, rules: true, replyInstructions: true } })
      : null;
    const { systemInstruction, prompt } = buildReplyPrompt({
      pageName: target.page.pageName,
      caption: target.post.caption ?? '',
      domain,
      comments: asked.map((c, i) => ({ key: keys[i], author: c.authorName, message: c.message })),
    });
    const result = await new GeminiClient({ apiKey: settings.geminiApiKey, model: settings.geminiModel }).generateJson({
      systemInstruction,
      prompt,
      responseSchema: SCHEMA,
      validator,
      temperature: 0.6,
    });
    replies = cleanReplies(result.replies, keys);
  }

  let drafted = 0;
  for (const comment of waiting) {
    const reply = replies.get(keys[asked.indexOf(comment)] ?? '') ?? null;
    // Answered or handled while the AI was writing: no draft for it any more
    const { count } = await prisma.postComment.updateMany({
      where: { id: comment.id, pageReplied: false, handledAt: null, draftCheckedAt: null },
      data: { draftReply: reply, draftCheckedAt: now },
    });
    if (reply && count) drafted++;
  }
  return drafted;
}
