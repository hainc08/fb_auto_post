/**
 * What the Telegram bot says and when (pure; tests/telegram-format.test.ts).
 * Everything is plain text: an AI-written caption holds `<`, `_` and `*`, and no parse_mode may choke on them.
 */

export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

export const TG_TEXT_MAX = 4096;
export const TG_CAPTION_MAX = 1024;
/** A card shows the start of the post; "Xem đủ" sends all of it */
export const CARD_CAPTION_MAX = 700;
export const MAX_DIGEST_POSTS = 10;
export const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const VN_TZ = 'Asia/Ho_Chi_Minh';

export interface CardPost {
  id: string;
  caption: string | null;
  scheduledAt: Date | null;
  pageNames: string[];
  productNames: string[];
  hasVideo: boolean;
}

/** The parts of an instant as seen in Vietnam, zero padded */
function vnParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** The slot as "HH:mm dd/MM" in Vietnam time */
export function slotText(date: Date): string {
  const p = vnParts(date);
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`;
}

export function postCard(post: CardPost): string {
  const caption = (post.caption ?? '').trim();
  const shown = caption.length > CARD_CAPTION_MAX ? `${caption.slice(0, CARD_CAPTION_MAX)}…` : caption;
  const head = `📝 ${post.pageNames.join(', ')} · đăng ${post.scheduledAt ? slotText(post.scheduledAt) : 'chưa có giờ'}`;
  const blocks = [head, shown, post.productNames.length ? `🛒 ${post.productNames.join(', ')}` : ''].filter(Boolean);
  const card = blocks.join('\n\n');
  return post.hasVideo ? `${card}\n🎬 Bài có video` : card;
}

export function digestHeader(total: number, shown: number): string {
  const head = `☀️ Chào buổi sáng! Có ${total} bài đang chờ bạn duyệt.`;
  return shown < total ? `${head}\nĐang hiện ${shown} bài đầu — còn ${total - shown} bài, hãy mở web để xem.` : head;
}

/** Chunks of at most `max` characters, cut at line ends where possible */
export function splitText(text: string, max = TG_TEXT_MAX): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (current && current.length + 1 + line.length > max) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

export function approveKeyboard(postId: string, webUrl: string | null): InlineKeyboard {
  const rows: InlineKeyboard['inline_keyboard'] = [
    [
      { text: '✅ Duyệt', callback_data: `a:${postId}` },
      { text: '📄 Xem đủ', callback_data: `f:${postId}` },
    ],
  ];
  // Telegram refuses a button whose address is not a public https page
  if (webUrl?.startsWith('https://')) rows.push([{ text: '🌐 Mở trên web', url: `${webUrl}/posts?selected=${postId}` }]);
  return { inline_keyboard: rows };
}

/** One inert button: what a card shows once it has been dealt with */
export const doneKeyboard = (label: string): InlineKeyboard => ({ inline_keyboard: [[{ text: label, callback_data: 'noop' }]] });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCallback(data: string): { action: 'approve' | 'full'; postId: string } | { action: 'noop' } | null {
  if (data === 'noop') return { action: 'noop' };
  const match = /^([af]):(.+)$/.exec(data);
  if (!match || !UUID.test(match[2])) return null;
  return { action: match[1] === 'a' ? 'approve' : 'full', postId: match[2] };
}

/** "YYYY-MM-DD" in Vietnam time */
export function vnDay(now: Date): string {
  const p = vnParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The morning digest is due from `digestTime` on, once a day (a sleeping app catches up later the same day) */
export function digestDue(now: Date, digestTime: string, lastDigestOn: string | null): boolean {
  if (lastDigestOn === vnDay(now)) return false;
  const p = vnParts(now);
  return `${p.hour}:${p.minute}` >= digestTime;
}
