import { logger } from '../utils/logger';
import { CloudflareClient, type CloudflareConfig } from '../lib/clients/cloudflare';

/**
 * Image Generation Service - Cloudflare Workers AI
 * Model, steps and credentials come from Settings (lib/settings), not from .env.
 */

export interface ImageGenerationOptions {
  cloudflare: CloudflareConfig;
  prompt: string;
}

/**
 * Generate an image using Cloudflare Workers AI
 * Returns image as a Buffer
 */
export async function generateImage(options: ImageGenerationOptions): Promise<Buffer> {
  const { cloudflare, prompt } = options;
  logger.info('Generating image with Cloudflare AI', { model: cloudflare.imageModel, prompt: prompt.substring(0, 100) });

  try {
    const { buffer } = await new CloudflareClient(cloudflare).generateImage(prompt);
    logger.info('Image generated successfully', { size: buffer.length });
    return buffer;
  } catch (error) {
    logger.error('Image generation failed:', { error: (error as Error).message });
    throw new Error(`Image generation failed: ${(error as Error).message}`);
  }
}

/**
 * Generate image and return as base64 data URL
 */
export async function generateImageBase64(options: ImageGenerationOptions): Promise<string> {
  const { cloudflare, prompt } = options;
  try {
    const { buffer, mimeType } = await new CloudflareClient(cloudflare).generateImage(prompt);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    logger.error('Image generation failed:', { error: (error as Error).message });
    throw new Error(`Image generation failed: ${(error as Error).message}`);
  }
}

/**
 * Enhance image prompt for better quality
 */
export function enhanceImagePrompt(basePrompt: string, style?: string): string {
  const styleModifiers: Record<string, string> = {
    professional: 'professional photography, studio lighting, clean background',
    creative: 'artistic, creative composition, vibrant colors, dramatic lighting',
    minimal: 'minimalist design, clean, white space, modern',
    social: 'social media friendly, eye-catching, bold colors, modern design',
    product: 'product photography, studio lighting, white background, commercial',
  };

  const modifier = styleModifiers[style || 'social'] || styleModifiers.social;
  return `${basePrompt}, ${modifier}, high resolution, 4k quality`;
}

/** Cloudflare settings → client config */
export function cloudflareConfigFrom(settings: {
  cfAccountId: string;
  cfApiToken: string;
  cfImageModel: string;
  cfSteps: number;
}): CloudflareConfig {
  return {
    accountId: settings.cfAccountId,
    apiToken: settings.cfApiToken,
    imageModel: settings.cfImageModel,
    steps: settings.cfSteps,
  };
}
