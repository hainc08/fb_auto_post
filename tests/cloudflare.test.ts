import { describe, it, expect, vi } from 'vitest';
import { CloudflareClient, CloudflareError } from '../src/lib/clients/cloudflare';

const TOKEN = 'cfat_secretTokenShouldNotLeak123456';
const client = (imageModel: string) =>
  new CloudflareClient({ accountId: 'acc123', apiToken: TOKEN, imageModel, steps: 4 });

const jpegBase64 = Buffer.from('fake-jpeg-bytes').toString('base64');

function mockFetch(response: Response) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('CloudflareClient.generateImage', () => {
  it('flux-1-schnell: sends JSON {prompt, steps}, decodes JSON base64 result', async () => {
    const fetch = mockFetch(
      new Response(JSON.stringify({ success: true, result: { image: jpegBase64 } }), {
        headers: { 'content-type': 'application/json' },
      })
    );
    const img = await client('@cf/black-forest-labs/flux-1-schnell').generateImage('a cat');

    expect(img.mimeType).toBe('image/jpeg');
    expect(img.buffer.toString()).toBe('fake-jpeg-bytes');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect(JSON.parse(init!.body as string)).toEqual({ prompt: 'a cat', steps: 4 });
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('flux-2: sends multipart/form-data (JSON is rejected by the model)', async () => {
    const fetch = mockFetch(
      new Response(JSON.stringify({ success: true, result: { image: jpegBase64 } }), {
        headers: { 'content-type': 'application/json' },
      })
    );
    await client('@cf/black-forest-labs/flux-2-dev').generateImage('a dog');

    const body = fetch.mock.calls[0][1]!.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('prompt')).toBe('a dog');
    expect((body as FormData).get('steps')).toBe('4');
    // fetch must set the multipart boundary itself
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('binary models (SDXL): returns raw image bytes with their mime type', async () => {
    mockFetch(new Response(Buffer.from('png-bytes'), { headers: { 'content-type': 'image/png' } }));
    const img = await client('@cf/stabilityai/stable-diffusion-xl-base-1.0').generateImage('x');
    expect(img.mimeType).toBe('image/png');
    expect(img.buffer.toString()).toBe('png-bytes');
  });

  it('maps "Bad input" (5006) to a Vietnamese error without leaking the token', async () => {
    mockFetch(
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 5006, message: `AiError: Bad input: required 'multipart' ${TOKEN}` }] }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    const error = (await client('@cf/x/model').generateImage('x').catch((e) => e)) as CloudflareError;
    expect(error).toBeInstanceOf(CloudflareError);
    expect(error.message).toMatch(/từ chối dữ liệu đầu vào/);
    expect(error.errorCode).toBe('code 5006');
    expect(`${error.message} ${error.rawMessage}`).not.toContain(TOKEN);
  });

  it('fails clearly when the JSON has no image', async () => {
    mockFetch(new Response(JSON.stringify({ success: true, result: {} }), { headers: { 'content-type': 'application/json' } }));
    await expect(client('@cf/black-forest-labs/flux-1-schnell').generateImage('x')).rejects.toThrow(/thiếu result.image/);
  });
});
