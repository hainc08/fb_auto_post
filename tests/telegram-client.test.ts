import { describe, it, expect, vi } from 'vitest';
import { TelegramApiError, TelegramClient } from '../src/lib/clients/telegram';

const TOKEN = '123456:ABC-fake-token-for-tests';
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

/** Stubs fetch and records the calls: [url, init] */
function stubFetch(answer: () => Response | Promise<Response>) {
  const calls: Array<[string, RequestInit]> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return answer();
  });
  return calls;
}

describe('Telegram client', () => {
  it("sendMessage posts JSON to the bot's method with the chat and the text, no parse_mode, and returns the message id", async () => {
    const calls = stubFetch(() => ok({ message_id: 42 }));
    const keyboard = { inline_keyboard: [[{ text: 'A', callback_data: 'noop' }]] };
    expect(await new TelegramClient(TOKEN).sendMessage('111', '<b>Chào</b> a_b*c', keyboard, 7)).toEqual({ messageId: 42 });
    const [url, init] = calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ chat_id: '111', text: '<b>Chào</b> a_b*c', reply_markup: keyboard, reply_to_message_id: 7 });
    expect(body.parse_mode).toBeUndefined();
  });

  it('sendPhoto sends multipart with chat_id, caption, reply_markup as JSON and the photo file', async () => {
    const calls = stubFetch(() => ok({ message_id: 43 }));
    const keyboard = { inline_keyboard: [[{ text: 'A', callback_data: 'noop' }]] };
    const image = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };
    expect(await new TelegramClient(TOKEN).sendPhoto('111', image, 'Chú thích', keyboard)).toEqual({ messageId: 43 });
    const [url, init] = calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('111');
    expect(form.get('caption')).toBe('Chú thích');
    expect(JSON.parse(String(form.get('reply_markup')))).toEqual(keyboard);
    expect(form.get('parse_mode')).toBeNull();
    expect((form.get('photo') as File).size).toBe(4);
  });

  it('setWebhook sends the url, the secret_token and only message and callback_query updates', async () => {
    const calls = stubFetch(() => ok(true));
    await new TelegramClient(TOKEN).setWebhook('https://app.test/telegram/webhook/u1', 'secret123');
    expect(calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(JSON.parse(String(calls[0][1].body))).toEqual({
      url: 'https://app.test/telegram/webhook/u1',
      secret_token: 'secret123',
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('getMe, setKeyboard and answerCallback call their methods', async () => {
    const calls = stubFetch(() => ok({ id: 9, username: 'nhanong_bot' }));
    const client = new TelegramClient(TOKEN);
    expect(await client.getMe()).toEqual({ id: 9, username: 'nhanong_bot' });
    await client.setKeyboard('111', 42, { inline_keyboard: [] });
    await client.answerCallback('cb1', 'Đã duyệt ✅');
    expect(calls.map(([url]) => url.split('/').pop())).toEqual(['getMe', 'editMessageReplyMarkup', 'answerCallbackQuery']);
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ chat_id: '111', message_id: 42 });
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ callback_query_id: 'cb1', text: 'Đã duyệt ✅' });
  });

  it('a Telegram error becomes a TelegramApiError with its code', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 }));
    const error = await new TelegramClient(TOKEN).sendMessage('111', 'x').catch((e) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.code).toBe(403);
    expect(error.message).toContain('bot was blocked by the user');
  });

  it('the token never appears in an error, from Telegram or from the network', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is wrong` }), { status: 400 }));
    const fromTelegram = await new TelegramClient(TOKEN).sendMessage('111', 'x').catch((e) => e);
    expect(String(fromTelegram)).not.toContain(TOKEN);
    expect(fromTelegram.message).toContain('***');

    stubFetch(() => Promise.reject(new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)));
    const network = await new TelegramClient(TOKEN).sendMessage('111', 'x').catch((e) => e);
    expect(network).toBeInstanceOf(TelegramApiError);
    expect(network.code).toBeUndefined();
    expect(String(network)).not.toContain(TOKEN);
    expect(network.message).toContain('***');
  });
});
