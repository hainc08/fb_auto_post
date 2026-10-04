import type { Post, Prisma } from '@prisma/client';
import { Type } from '@google/genai';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { GeminiClient } from '../lib/clients/gemini';
import { buildReelScriptPrompt, cleanScenes } from '../lib/reel/script-prompt';
import { parseDraft, type ReelDraft } from '../lib/reel/scenes';

/** The Reel draft of a post (Post.reelDraft) and the AI that writes its scenes. */

export function readDraft(post: Pick<Post, 'reelDraft' | 'inputData'>): ReelDraft {
  const legacy = (post.inputData as Record<string, string> | null) ?? {};
  return parseDraft(post.reelDraft, legacy.reelScript, legacy.reelVoice);
}

export async function saveDraft(postId: string, draft: ReelDraft): Promise<void> {
  const stored = { voice: draft.voice, scenes: draft.scenes.map((s) => ({ ...s })) } as unknown as Prisma.InputJsonObject;
  await prisma.post.update({ where: { id: postId }, data: { reelDraft: stored } });
}

const SCENES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scenes: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { text: { type: Type.STRING }, image_prompt: { type: Type.STRING } }, required: ['text', 'image_prompt'] },
    },
  },
  required: ['scenes'],
};
const scenesValidator = z.object({ scenes: z.array(z.object({ text: z.string().optional(), image_prompt: z.string().optional() })) });

/** Scenes (spoken text + image prompt) written from the post's text, the way its content domain asks. */
export async function writeReelScenes(
  gemini: { apiKey: string; model: string },
  post: Pick<Post, 'caption' | 'domainId'>
): Promise<Array<{ text: string; imagePrompt: string }>> {
  const domain = post.domainId
    ? await prisma.contentDomain.findUnique({ where: { id: post.domainId }, select: { name: true, audience: true, voice: true, rules: true, reelInstructions: true } })
    : null;
  const { systemInstruction, prompt } = buildReelScriptPrompt({ caption: post.caption ?? '', domain });
  const result = await new GeminiClient(gemini).generateJson({ systemInstruction, prompt, responseSchema: SCENES_SCHEMA, validator: scenesValidator, temperature: 0.8 });
  return cleanScenes(result.scenes);
}
