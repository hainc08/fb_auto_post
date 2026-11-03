import { Router } from 'express';
import prisma from '../utils/prisma';
import { asyncHandler } from '../middleware/error.middleware';
import { safeEqual } from '../lib/crypto';
import { handleTelegramUpdate } from '../services/telegram-updates';

/**
 * Where Telegram delivers the updates of a member's bot (mounted at /telegram, outside /api: no login, no CSRF header).
 * The only thing that opens it is the secret Telegram sends back in a header; the same 401 answers a missing member,
 * a missing header and a wrong one.
 */
const router = Router();

router.post(
  '/webhook/:userId',
  asyncHandler(async (req, res) => {
    const bot = await prisma.telegramBot.findUnique({ where: { userId: req.params.userId }, include: { user: { select: { isActive: true } } } });
    const given = String(req.get('x-telegram-bot-api-secret-token') ?? '');
    if (!bot || !given || !safeEqual(given, bot.webhookSecret)) return void res.status(401).json({ ok: false });
    // Always 200 once the secret matched: an error answer makes Telegram send the same update again
    // A member an admin disabled is ignored, as at the web login
    if (bot.user.isActive) await handleTelegramUpdate(bot, req.body);
    res.json({ ok: true });
  })
);

export default router;
