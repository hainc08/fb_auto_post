/**
 * "Tự gửi trả lời": which comments the AI draft must not be sent for on its own (pure). A held comment keeps
 * its draft for the member to read and send by hand.
 */

/** Used when the domain lists no keywords of its own */
export const DEFAULT_HOLD_KEYWORDS = [
  'giá',
  'bao nhiêu',
  'lừa',
  'lừa đảo',
  'khiếu nại',
  'hoàn tiền',
  'trả hàng',
  'đổi trả',
  'bảo hành',
  'hàng giả',
  'hàng nhái',
  'kém chất lượng',
  'thất vọng',
  'tệ',
  'dỏm',
  'tố cáo',
  'báo công an',
  'kiện',
];

export const MAX_HOLD_KEYWORDS = 100;

const norm = (s: string) => s.normalize('NFC').toLowerCase();

/** The domain's keywords (comma or line separated); empty = the built-in list */
export function parseHoldKeywords(text: string | null | undefined): string[] {
  const own = [...new Set((text ?? '').split(/[,\n]/).map((k) => norm(k).trim().replace(/\s+/g, ' ')).filter(Boolean))];
  return own.length ? own.slice(0, MAX_HOLD_KEYWORDS) : DEFAULT_HOLD_KEYWORDS;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK = /(https?:\/\/|www\.)\S+/i;
/** 9+ digits, spaces, dots or dashes allowed between them (Vietnamese phone numbers) */
const PHONE = /(?:\d[\s.-]?){9,}/;

/** Why this comment must wait for the member (shown with the draft), or null when the draft may go out alone */
export function holdReason(message: string, keywords: string[]): string | null {
  const text = norm(message);
  if (LINK.test(text)) return 'Có đường link';
  if (PHONE.test(text)) return 'Có số điện thoại';
  for (const keyword of keywords) {
    // whole words only: "giá" is not found in "giáo"
    if (new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}])${escape(keyword)}($|[^\\p{L}\\p{N}\\p{M}])`, 'u').test(text)) return `Có từ khoá "${keyword}"`;
  }
  return null;
}
