import { describe, it, expect, vi, afterEach } from 'vitest';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})) }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

import { config } from '../src/config';
import { sendPostNotification } from '../src/services/email.service';

const notification = {
  to: 'someone@autopost.test',
  userName: 'A',
  pageName: '1/1 Page',
  postCaption: 'x',
  status: 'success' as const,
  publishedAt: new Date(),
};

describe('sendPostNotification', () => {
  const saved = { ...config.email };
  afterEach(() => {
    Object.assign(config.email, saved);
    sendMail.mockClear();
  });

  it('does nothing when SMTP is not configured (no network call)', async () => {
    Object.assign(config.email, { user: '', pass: '' });
    await sendPostNotification(notification);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends when SMTP user and password are set', async () => {
    Object.assign(config.email, { user: 'bot@autopost.test', pass: 'fake-smtp-pass' });
    await sendPostNotification(notification);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('the test environment never has SMTP credentials (tests must not send real email)', () => {
    expect(process.env.SMTP_USER ?? '').toBe('');
    expect(process.env.SMTP_PASS ?? '').toBe('');
  });
});
