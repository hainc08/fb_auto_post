import type { TelegramBot } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { approveSchedulePost } from './post-approval';
import { postMessageOf } from './scheduler.service';
import type { TelegramClient } from '../lib/clients/telegram';
import { botClient } from '../lib/telegram-link';
import { doneKeyboard, parseCallback, slotText, splitText } from '../lib/telegram-format';

/**
 * What the member's bot does with an update Telegram sent to the webhook: link a chat with `/start <code>`, and
 * the buttons of a post card. Never throws: Telegram retries a webhook that fails, and a retry must not act twice.
 */

const NOT_ALLOWED = 'Bạn không có quyền thao tác.';
const NOT_FOUND = 'Không tìm thấy bài (có thể đã bị xoá).';

/** Telegram's answer text limit */
const cut = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}…` : text);

const warn = (what: string) => (error: unknown): void => {
  logger.warn(`[Telegram] ${what}`, { error: (error as Error).message });
};

interface TgChat {
  id?: number;
  type?: string;
}

async function onMessage(bot: TelegramBot, client: TelegramClient, message: { message_id?: number; chat?: TgChat; text?: string }) {
  const chatId = message.chat?.id;
  const text = (message.text ?? '').trim();
  if (chatId === undefined || !text.startsWith('/start')) return;
  const code = text.split(/\s+/)[1] ?? '';
  if (message.chat?.type === 'private' && code && bot.linkCode && code === bot.linkCode) {
    await prisma.telegramBot.update({ where: { id: bot.id }, data: { chatId: String(chatId), linkCode: null, lastError: null } });
    await client.sendMessage(
      String(chatId),
      `✅ Đã liên kết. Mỗi sáng lúc ${bot.digestTime} bot sẽ gửi các bài chờ duyệt. Gõ /danhsach để nhận danh sách ngay.`
    );
    return;
  }
  await client.sendMessage(String(chatId), 'Mã liên kết không đúng hoặc đã hết hạn. Hãy lấy mã mới trong Cài đặt → Telegram.');
}

async function onApprove(bot: TelegramBot, client: TelegramClient, chatId: string, messageId: number | undefined, postId: string, answer: (text?: string) => Promise<void>) {
  const post = await prisma.post.findFirst({ where: { id: postId, userId: bot.userId }, select: { id: true, status: true, scheduleQueued: true } });
  const keyboard = async (label: string) => {
    if (messageId !== undefined) await client.setKeyboard(chatId, messageId, doneKeyboard(label)).catch(warn('setKeyboard'));
  };
  if (!post) return answer(NOT_FOUND);
  if (post.scheduleQueued && post.status === 'SCHEDULED') {
    await keyboard('✅ Đã duyệt');
    return answer('Bài đã được duyệt trước đó.');
  }
  try {
    const saved = await approveSchedulePost(bot.userId, post.id);
    await keyboard(`✅ Đã duyệt — đăng ${saved.scheduledAt ? slotText(saved.scheduledAt) : 'theo lịch'}`);
    await answer('Đã duyệt ✅');
  } catch (error) {
    await answer(cut((error as Error).message));
  }
}

async function onFull(bot: TelegramBot, client: TelegramClient, chatId: string, messageId: number | undefined, postId: string, answer: (text?: string) => Promise<void>) {
  const post = await prisma.post.findFirst({ where: { id: postId, userId: bot.userId } });
  if (!post) return answer(NOT_FOUND);
  const full = await postMessageOf(post);
  if (!full) return answer('Bài chưa có nội dung.');
  await answer();
  for (const [i, chunk] of splitText(full).entries()) {
    await client.sendMessage(chatId, chunk, undefined, i === 0 ? messageId : undefined);
  }
}

async function onCallback(bot: TelegramBot, client: TelegramClient, query: { id?: string; data?: string; message?: { message_id?: number; chat?: TgChat } }) {
  if (!query.id) return;
  const answer = (text?: string) => client.answerCallback(query.id!, text).catch(warn('answerCallback'));
  const chatId = query.message?.chat?.id;
  // Only the linked chat may press the buttons of this member's bot
  if (chatId === undefined || !bot.chatId || String(chatId) !== bot.chatId) return answer(NOT_ALLOWED);
  const action = parseCallback(query.data ?? '');
  if (!action) return answer();
  if (action.action === 'noop') return answer();
  const messageId = query.message?.message_id;
  if (action.action === 'approve') return onApprove(bot, client, String(chatId), messageId, action.postId, answer);
  return onFull(bot, client, String(chatId), messageId, action.postId, answer);
}

export async function handleTelegramUpdate(bot: TelegramBot, update: unknown): Promise<void> {
  try {
    const u = (update ?? {}) as { message?: Parameters<typeof onMessage>[2]; callback_query?: Parameters<typeof onCallback>[2] };
    const client = botClient(bot);
    if (u.callback_query) await onCallback(bot, client, u.callback_query);
    else if (u.message) await onMessage(bot, client, u.message);
  } catch (error) {
    logger.warn('[Telegram] Update not handled', { userId: bot.userId, error: (error as Error).message });
  }
}
