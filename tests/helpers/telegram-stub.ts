import { vi } from 'vitest';

/** Replies of the Telegram Bot API stub, by method name; anything not listed answers success */
export type TelegramAnswers = Record<string, (body: any) => Response>;
export type TelegramCall = { method: string; body: any };

const realFetch = globalThis.fetch;
export const tgJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * Stubs `fetch` for api.telegram.org only (the test server and everything else still use the real one) and records
 * every Telegram call. Call `vi.unstubAllGlobals()` in afterEach.
 */
export function stubTelegram(answers: TelegramAnswers = {}): TelegramCall[] {
  const calls: TelegramCall[] = [];
  let messageId = 100;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('api.telegram.org')) return realFetch(input as never, init);
    const method = url.split('/').pop()!;
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    if (answers[method]) return answers[method](body);
    if (method === 'getMe') return tgJson({ ok: true, result: { id: 9, username: 'nhanong_bot' } });
    if (method === 'sendMessage' || method === 'sendPhoto') return tgJson({ ok: true, result: { message_id: ++messageId } });
    return tgJson({ ok: true, result: true });
  });
  return calls;
}
