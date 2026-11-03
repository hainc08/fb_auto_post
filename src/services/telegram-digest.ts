import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';
import { upsertKeyedJob, type JobResult } from '../lib/job-queue';
import { readImage } from '../lib/image-store';
import { productsOf } from '../lib/post-products';
import { TelegramApiError } from '../lib/clients/telegram';
import { botClient, publicUrl } from '../lib/telegram-link';
import { MAX_DIGEST_POSTS, TG_CAPTION_MAX, approveKeyboard, digestDue, digestHeader, postCard, vnDay } from '../lib/telegram-format';

/**
 * The morning list: the schedule posts that wait for the member's approval (`scheduleQueued`, `READY`), one Telegram
 * message per post with its buttons. Sent once a day from the member's chosen time (`telegram_tick`, every minute).
 */

export const DIGEST_TICK_KEY = 'system:telegram_tick';
const TICK_MS = 60_000;
const EMPTY_TEXT = 'Không có bài nào đang chờ duyệt 🎉';
const BLOCKED_TEXT = 'Bot bị chặn hoặc chat đã bị xoá: hãy liên kết lại trong Cài đặt → Telegram.';

const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export interface DigestOptions {
  /** Pause between two messages (Telegram limits a chat to about one a second); tests pass 0 */
  delayMs?: number;
  /** Counts the messages that went out, so a caller can tell a failure before anything was delivered */
  progress?: { delivered: number };
}

/**
 * Send the member's waiting posts to the linked chat. Sends nothing when none wait. Throws what Telegram refuses
 * with; `total` counts all waiting posts, `sent` the cards that went out (at most MAX_DIGEST_POSTS).
 */
export async function sendDigest(userId: string, opts: DigestOptions = {}): Promise<{ total: number; sent: number }> {
  const bot = await prisma.telegramBot.findUnique({ where: { userId } });
  if (!bot?.chatId) return { total: 0, sent: 0 };
  const posts = await prisma.post.findMany({
    where: { userId, scheduleQueued: true, status: 'READY' },
    orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    include: { targets: { include: { page: { select: { pageName: true } } } } },
  });
  if (!posts.length) return { total: 0, sent: 0 };

  const client = botClient(bot);
  const chatId = bot.chatId;
  const progress = opts.progress ?? { delivered: 0 };
  const delay = opts.delayMs ?? 300;
  const webUrl = publicUrl().startsWith('https://') ? publicUrl() : null;
  const shown = posts.slice(0, MAX_DIGEST_POSTS);

  await client.sendMessage(chatId, digestHeader(posts.length, shown.length));
  progress.delivered++;
  let sent = 0;
  for (const post of shown) {
    await sleep(delay);
    const products = await productsOf(post.id);
    const card = postCard({
      id: post.id,
      caption: post.caption,
      scheduledAt: post.scheduledAt,
      pageNames: post.targets.map((t) => t.page.pageName),
      productNames: products.map((p) => p.name),
      hasVideo: !!post.videoPath,
    });
    const keyboard = approveKeyboard(post.id, webUrl);
    const image = post.imagePath ? await readImage(post.imagePath) : null;
    if (image) await client.sendPhoto(chatId, image, card.slice(0, TG_CAPTION_MAX), keyboard);
    else await client.sendMessage(chatId, card, keyboard);
    progress.delivered++;
    sent++;
  }
  return { total: posts.length, sent };
}

/** The list on request ("Gửi danh sách ngay", /danhsach): says so when nothing waits */
export async function sendDigestNow(userId: string, opts: DigestOptions = {}): Promise<{ total: number; sent: number }> {
  const result = await sendDigest(userId, opts);
  if (result.total === 0) {
    const bot = await prisma.telegramBot.findUnique({ where: { userId } });
    if (bot?.chatId) await botClient(bot).sendMessage(bot.chatId, EMPTY_TEXT);
  }
  return result;
}

const retryable = (code: number | undefined) => code === undefined || code === 429 || code >= 500;

/**
 * Send the morning digest to every bot that is due. The day is claimed before sending, so two ticks never both
 * send. A failure with nothing delivered that may pass (Telegram busy, network) gives the day back for the next
 * tick; any other failure keeps it and is recorded. Returns how many members got their list.
 */
export async function runTelegramDigests(now = new Date(), where: Prisma.TelegramBotWhereInput = {}): Promise<number> {
  const today = vnDay(now);
  const bots = await prisma.telegramBot.findMany({ where: { ...where, enabled: true, chatId: { not: null } } });
  let count = 0;
  for (const bot of bots) {
    if (!digestDue(now, bot.digestTime, bot.lastDigestOn)) continue;
    const claim = await prisma.telegramBot.updateMany({
      where: { id: bot.id, OR: [{ lastDigestOn: null }, { lastDigestOn: { not: today } }] },
      data: { lastDigestOn: today },
    });
    if (!claim.count) continue;
    const progress = { delivered: 0 };
    try {
      const { sent } = await sendDigest(bot.userId, { progress });
      await prisma.telegramBot.update({ where: { id: bot.id }, data: { lastError: null } });
      if (sent) count++;
    } catch (error) {
      const code = error instanceof TelegramApiError ? error.code : undefined;
      logger.warn('[Telegram] Morning digest failed', { userId: bot.userId, code, error: (error as Error).message });
      if (code === 403) {
        await prisma.telegramBot.update({ where: { id: bot.id }, data: { chatId: null, lastError: BLOCKED_TEXT } });
      } else {
        await prisma.telegramBot.update({ where: { id: bot.id }, data: { lastError: (error as Error).message.slice(0, 500) } });
        if (progress.delivered === 0 && retryable(code)) {
          await prisma.telegramBot.updateMany({ where: { id: bot.id, lastDigestOn: today }, data: { lastDigestOn: bot.lastDigestOn } });
        }
      }
    }
  }
  return count;
}

/** telegram_tick job: never stops re-booking itself, even when a digest fails */
export async function runTelegramTickJob(): Promise<JobResult> {
  try {
    await runTelegramDigests();
  } catch (error) {
    logger.error('[Telegram] Tick failed', { error: (error as Error).message });
  }
  return { rescheduleAt: new Date(Date.now() + TICK_MS) };
}

/** One pending tick job (not in tests: DB test files share the database and run in parallel). */
export async function bookTelegramTick(): Promise<void> {
  if (config.env === 'test') return;
  const existing = await prisma.job.findUnique({ where: { key: DIGEST_TICK_KEY } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'RUNNING')) return;
  await upsertKeyedJob(DIGEST_TICK_KEY, 'telegram_tick', {}, new Date());
}
