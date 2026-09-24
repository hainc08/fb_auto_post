import { ApiError, FinishReason, GoogleGenAI, type GenerateContentResponse, type Schema } from '@google/genai';
import type { ZodType, ZodTypeDef } from 'zod';
import { redactSecrets } from '../http';

/**
 * Google Gemini client (@google/genai).
 * Retry policy matches lib/http: 2 retries, 1s then 3s, only 408/429/5xx.
 */

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 8192;

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export class GeminiError extends Error {
  constructor(message: string, readonly status?: number, readonly rawMessage?: string) {
    super(message);
    this.name = 'GeminiError';
  }

  get errorCode(): string | undefined {
    return this.status ? `HTTP ${this.status}` : undefined;
  }
}

export class GeminiClient {
  readonly ai: GoogleGenAI;

  constructor(private readonly config: GeminiConfig) {
    if (!config.apiKey) throw new GeminiError('Chưa cấu hình Gemini API key.');
    this.ai = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: {
        timeout: TIMEOUT_MS,
        retryOptions: { attempts: 3, initialDelay: 1, expBase: 3, maxDelay: 3, jitter: 0, httpStatusCodes: [408, 429, 500, 502, 503, 504] },
      },
    });
  }

  get model(): string {
    return this.config.model;
  }

  /** Minimal request to verify key + model. */
  async ping(): Promise<string> {
    try {
      const res = await this.ai.models.generateContent({
        model: this.config.model,
        contents: 'ping',
        config: { maxOutputTokens: 64 },
      });
      return (res.text ?? '').trim();
    } catch (error) {
      throw this.toGeminiError(error);
    }
  }

  /**
   * Structured generation: Gemini returns JSON constrained by `responseSchema`,
   * then validated with zod. A malformed/truncated reply is retried once.
   *
   * maxOutputTokens is generous on purpose: on 2.5+ "thinking" models the
   * thinking tokens count against this budget, and a low limit cuts the JSON.
   */
  async generateJson<T>(input: {
    systemInstruction: string;
    prompt: string;
    responseSchema: Schema;
    validator: ZodType<T, ZodTypeDef, unknown>;
    temperature?: number;
  }): Promise<T> {
    let lastError: GeminiError | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: GenerateContentResponse;
      try {
        res = await this.ai.models.generateContent({
          model: this.config.model,
          contents: input.prompt,
          config: {
            systemInstruction: input.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: input.responseSchema,
            temperature: input.temperature ?? 0.8,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        });
      } catch (error) {
        throw this.toGeminiError(error);
      }

      const candidate = res.candidates?.[0];
      if (candidate?.finishReason === FinishReason.SAFETY || res.promptFeedback?.blockReason) {
        throw new GeminiError('Gemini từ chối tạo nội dung vì bộ lọc an toàn. Hãy diễn đạt chủ đề khác đi.');
      }

      const text = res.text ?? '';
      try {
        return input.validator.parse(JSON.parse(text));
      } catch {
        const truncated = candidate?.finishReason === FinishReason.MAX_TOKENS;
        lastError = new GeminiError(
          truncated
            ? 'Gemini trả về nội dung bị cắt ngang (vượt giới hạn độ dài).'
            : 'Gemini trả về dữ liệu không đúng định dạng JSON yêu cầu.',
          undefined,
          `finishReason=${candidate?.finishReason ?? 'unknown'}, length=${text.length}`
        );
      }
    }

    throw lastError!;
  }

  /** Convert SDK/network errors to a redacted, Vietnamese GeminiError. */
  toGeminiError(error: unknown): GeminiError {
    if (error instanceof GeminiError) return error;
    const raw = redactSecrets((error as Error)?.message ?? String(error), [this.config.apiKey]);
    const status = error instanceof ApiError ? error.status : undefined;

    if (/abort|timed? ?out/i.test(raw)) return new GeminiError('Gemini phản hồi quá lâu (quá 60 giây).', status, raw);
    switch (status) {
      case 400:
        if (/api key/i.test(raw)) return new GeminiError('Gemini API key không hợp lệ.', status, raw);
        return new GeminiError(`Yêu cầu gửi Gemini không hợp lệ: ${raw}`, status, raw);
      case 401:
      case 403:
        return new GeminiError('Gemini API key không có quyền (key bị giới hạn hoặc chưa bật Generative Language API).', status, raw);
      case 404:
        return new GeminiError(`Không tìm thấy model Gemini "${this.config.model}". Kiểm tra lại tên model.`, status, raw);
      case 429:
        return new GeminiError('Gemini hết hạn mức (quota) hoặc gọi quá nhanh. Hãy thử lại sau.', status, raw);
      default:
        if (status && status >= 500) return new GeminiError('Gemini đang quá tải hoặc gặp sự cố. Hãy thử lại sau.', status, raw);
        return new GeminiError(`Lỗi gọi Gemini: ${raw}`, status, raw);
    }
  }
}
