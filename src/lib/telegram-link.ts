import { randomBytes } from 'node:crypto';
import { config } from '../config';

/** Addresses and one-time codes of the Telegram link (pure apart from the env read). */

/** The app's public address, without a trailing slash. Read at call time: Telegram only delivers webhooks to https. */
export const publicUrl = (): string => (process.env.PUBLIC_URL || config.clientUrl).replace(/\/+$/, '');

/** The t.me link that opens the bot and sends `/start <code>` */
export const linkUrl = (botUsername: string, code: string): string => `https://t.me/${botUsername}?start=${code}`;

/** What Telegram sends back in a header on every webhook call */
export const newSecret = (): string => randomBytes(32).toString('hex');

/** One-time code of the t.me link (a start parameter allows A-Z, a-z, 0-9, _ and -) */
export const newLinkCode = (): string => randomBytes(8).toString('hex');

export const webhookUrl = (userId: string): string => `${publicUrl()}/telegram/webhook/${userId}`;
