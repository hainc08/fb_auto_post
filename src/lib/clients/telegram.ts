import type { InlineKeyboard } from '../telegram-format';

/** Thin wrapper over the Telegram Bot API. The token is part of every URL, so no error may repeat it. */

export class TelegramApiError extends Error {
  constructor(
    message: string,
    /** Telegram's error_code (403 = the bot was blocked); undefined = the request never got an answer */
    readonly code?: number
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

interface TelegramAnswer<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('***') : text;
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new TelegramApiError(`Không gọi được Telegram: ${this.redact((error as Error).message)}`);
    }
    const answer = (await response.json().catch(() => null)) as TelegramAnswer<T> | null;
    if (!answer?.ok) {
      throw new TelegramApiError(this.redact(answer?.description ?? `Telegram trả lỗi ${response.status}`), answer?.error_code ?? response.status);
    }
    return answer.result as T;
  }

  getMe(): Promise<{ id: number; username: string }> {
    return this.call('getMe', {});
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', {});
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboard, replyToMessageId?: number): Promise<{ messageId: number }> {
    const sent = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup && { reply_markup: replyMarkup }),
      ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
    });
    return { messageId: sent.message_id };
  }

  async sendPhoto(chatId: string, image: { buffer: Buffer; mime: string }, caption: string, replyMarkup?: InlineKeyboard): Promise<{ messageId: number }> {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([new Uint8Array(image.buffer)], { type: image.mime }), 'post');
    const sent = await this.call<{ message_id: number }>('sendPhoto', form);
    return { messageId: sent.message_id };
  }

  async setKeyboard(chatId: string, messageId: number, replyMarkup: InlineKeyboard): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text && { text }) });
  }
}
