import { Router, Response } from 'express';
import { z } from 'zod';
import type { TelegramBot } from '@prisma/client';
import prisma from '../utils/prisma';
import { AuthRequest, authenticate } from '../middleware/auth.middleware';
import { asyncHandler, createError } from '../middleware/error.middleware';
import { encrypt } from '../lib/crypto';
import { TelegramApiError, TelegramClient } from '../lib/clients/telegram';
import { DIGEST_TIME_PATTERN } from '../lib/telegram-format';
import { sendDigestNow } from '../services/telegram-digest';
import { botClient, linkUrl, newLinkCode, newSecret, publicUrl, webhookUrl } from '../lib/telegram-link';

/** The member's own Telegram bot: connect it, link a chat, switch the morning digest (mounted at /api/telegram). */
const router = Router();
router.use(authenticate);

/** What the Settings screen needs. Never the token, the secret or the chat id. */
function status(row: TelegramBot | null) {
  return {
    configured: !!row,
    botUsername: row?.botUsername ?? null,
    linked: !!row?.chatId,
    linkUrl: row?.linkCode ? linkUrl(row.botUsername, row.linkCode) : null,
    enabled: row?.enabled ?? true,
    digestTime: row?.digestTime ?? '08:00',
    lastError: row?.lastError ?? null,
    canReceive: publicUrl().startsWith('https://'),
  };
}

const findBot = (userId: string) => prisma.telegramBot.findUnique({ where: { userId } });

async function requireBot(userId: string): Promise<TelegramBot> {
  const row = await findBot(userId);
  if (!row) throw createError(409, 'Hãy dán token bot trước.');
  return row;
}

/** The member's bot with a linked chat; 409 until there is one */
export async function linkedBot(userId: string): Promise<{ row: TelegramBot; chatId: string }> {
  const row = await requireBot(userId);
  if (!row.chatId) throw createError(409, 'Chưa liên kết Telegram: hãy mở link và bấm Start trong Telegram.');
  return { row, chatId: row.chatId };
}

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: status(await findBot(req.user!.id)) });
  })
);

const saveSchema = z.object({
  botToken: z.string().trim().min(20, 'Token bot quá ngắn: hãy sao chép lại từ @BotFather.').max(200).optional(),
  enabled: z.boolean().optional(),
  digestTime: z.string().regex(DIGEST_TIME_PATTERN, 'Giờ gửi có dạng HH:mm, ví dụ 08:00.').optional(),
});

router.put(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const body = saveSchema.parse(req.body ?? {});
    const options = { ...(body.enabled !== undefined && { enabled: body.enabled }), ...(body.digestTime && { digestTime: body.digestTime }) };

    if (body.botToken) {
      if (!publicUrl().startsWith('https://')) {
        throw createError(400, 'Địa chỉ web của app chưa dùng https nên Telegram không gửi được tin về. Đặt PUBLIC_URL (hoặc CLIENT_URL) là địa chỉ https của app.');
      }
      const client = new TelegramClient(body.botToken);
      let me;
      try {
        me = await client.getMe();
      } catch (error) {
        if (error instanceof TelegramApiError && error.code === 401) throw createError(400, 'Token bot không đúng. Hãy sao chép lại token từ @BotFather.');
        throw createError(502, `Không kiểm tra được bot: ${(error as Error).message}`);
      }
      const secret = newSecret();
      try {
        await client.setWebhook(webhookUrl(userId), secret);
      } catch (error) {
        throw createError(502, `Telegram không nhận địa chỉ nhận tin của app: ${(error as Error).message}`);
      }
      // A new bot starts unlinked, with a new secret and a new code
      const fresh = {
        botToken: encrypt(body.botToken),
        botUsername: me.username,
        webhookSecret: secret,
        chatId: null,
        linkCode: newLinkCode(),
        lastError: null,
        lastDigestOn: null,
        ...options,
      };
      const row = await prisma.telegramBot.upsert({ where: { userId }, create: { userId, ...fresh }, update: fresh });
      return void res.json({ success: true, data: status(row) });
    }

    await requireBot(userId);
    const row = await prisma.telegramBot.update({ where: { userId }, data: options });
    res.json({ success: true, data: status(row) });
  })
);

/** A new t.me link, to link another chat (the linked chat stays until a new /start replaces it) */
router.post(
  '/link-code',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await requireBot(req.user!.id);
    const row = await prisma.telegramBot.update({ where: { userId: req.user!.id }, data: { linkCode: newLinkCode() } });
    res.json({ success: true, data: status(row) });
  })
);

router.post(
  '/test',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { row, chatId } = await linkedBot(req.user!.id);
    try {
      await botClient(row).sendMessage(chatId, '✅ Kết nối thành công. Bot sẽ gửi các bài chờ duyệt vào mỗi sáng.');
    } catch (error) {
      throw createError(502, `Telegram từ chối gửi tin: ${(error as Error).message}`);
    }
    res.json({ success: true });
  })
);

router.post(
  '/digest',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await linkedBot(req.user!.id);
    try {
      res.json({ success: true, data: await sendDigestNow(req.user!.id) });
    } catch (error) {
      throw createError(502, `Telegram từ chối gửi tin: ${(error as Error).message}`);
    }
  })
);

router.delete(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const row = await findBot(req.user!.id);
    if (row) {
      // Best effort: the bot may be deleted already, and the row goes either way
      await botClient(row).deleteWebhook().catch(() => undefined);
      await prisma.telegramBot.delete({ where: { userId: req.user!.id } });
    }
    res.json({ success: true });
  })
);

export default router;
