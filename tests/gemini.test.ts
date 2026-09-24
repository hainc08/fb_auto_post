import { describe, it, expect, vi } from 'vitest';
import { ApiError, Type } from '@google/genai';
import { z } from 'zod';
import { GeminiClient, GeminiError } from '../src/lib/clients/gemini';

const API_KEY = 'AIzaSyTEST_key_should_never_leak_123456';
const schema = { type: Type.OBJECT, properties: { caption: { type: Type.STRING } }, required: ['caption'] };
const validator = z.object({ caption: z.string().min(1) });

const reply = (text: string, finishReason = 'STOP') => ({ text, candidates: [{ finishReason }] }) as any;

function clientWith(...responses: Array<unknown | Error>) {
  const client = new GeminiClient({ apiKey: API_KEY, model: 'gemini-2.5-flash' });
  const spy = vi.spyOn(client.ai.models, 'generateContent').mockImplementation(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next as any;
  });
  return { client, spy };
}

const run = (client: GeminiClient) =>
  client.generateJson({ systemInstruction: 'sys', prompt: 'p', responseSchema: schema, validator });

describe('GeminiClient.generateJson', () => {
  it('parses and validates structured output', async () => {
    const { client, spy } = clientWith(reply('{"caption":"Xin chào"}'));
    await expect(run(client)).resolves.toEqual({ caption: 'Xin chào' });

    const config = spy.mock.calls[0][0].config!;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toBe(schema);
    // thinking models spend output tokens on reasoning — budget must be large
    expect(config.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });

  it('retries once when the JSON is truncated, then succeeds', async () => {
    const { client, spy } = clientWith(reply('{"caption":"Bạn có mu', 'MAX_TOKENS'), reply('{"caption":"ok"}'));
    await expect(run(client)).resolves.toEqual({ caption: 'ok' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails with a clear message after 2 bad replies', async () => {
    const { client, spy } = clientWith(reply('{"caption":', 'MAX_TOKENS'), reply('{"caption":', 'MAX_TOKENS'));
    await expect(run(client)).rejects.toThrow(/bị cắt ngang/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rejects valid JSON that fails the schema', async () => {
    const { client } = clientWith(reply('{"caption":""}'), reply('{"other":1}'));
    await expect(run(client)).rejects.toThrow(/không đúng định dạng/);
  });

  it('reports safety blocks without retrying', async () => {
    const { client, spy } = clientWith(reply('', 'SAFETY'));
    await expect(run(client)).rejects.toThrow(/bộ lọc an toàn/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('maps API errors to Vietnamese and redacts the key', async () => {
    const { client } = clientWith(new ApiError({ message: `models/foo is not found key=${API_KEY}`, status: 404 }));
    const error = (await run(client).catch((e) => e)) as GeminiError;
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.message).toMatch(/Không tìm thấy model/);
    expect(error.errorCode).toBe('HTTP 404');
    expect(`${error.message} ${error.rawMessage}`).not.toContain(API_KEY);
  });

  it('maps 503 overload to a retry-later message', async () => {
    const { client } = clientWith(new ApiError({ message: 'high demand', status: 503 }));
    await expect(run(client)).rejects.toThrow(/quá tải/);
  });
});
