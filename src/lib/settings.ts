import { z } from 'zod';
import prisma from '../utils/prisma';
import { decrypt, encrypt, isEncrypted, mask } from './crypto';

/**
 * App configuration stored in the key-value `settings` table.
 * Secrets are AES-256-GCM encrypted at rest and only decrypted server-side.
 * Credentials fall back to .env while not yet configured in the UI.
 */

export const DEFAULT_SYSTEM_PROMPT = `Bạn là chuyên gia viết content mạng xã hội cho Fanpage [TÊN PAGE], đối tượng [ĐỐI TƯỢNG ĐỘC GIẢ].
Viết bài Facebook theo chủ đề, giọng điệu và ghi chú được cung cấp.
Yêu cầu: câu mở đầu gây chú ý, đoạn ngắn dễ đọc trên điện thoại, kết thúc bằng lời kêu gọi tương tác.
image_prompt phải bằng tiếng Anh, mô tả chủ thể, bối cảnh, ánh sáng, phong cách; không chứa chữ, logo hay người nổi tiếng.
Chỉ trả về JSON đúng schema.`;

export const SECRET_KEYS = ['geminiApiKey', 'cfApiToken', 'fbAppSecret'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export interface AppSettings {
  geminiApiKey: string;
  geminiModel: string;
  systemPrompt: string;
  cfAccountId: string;
  cfApiToken: string;
  cfImageModel: string;
  cfSteps: number;
  fbAppId: string;
  fbAppSecret: string;
  fbGraphVersion: string;
}

type SettingKey = keyof AppSettings;

const DEFAULTS: Record<SettingKey, () => string> = {
  geminiApiKey: () => process.env.GEMINI_API_KEY || '',
  geminiModel: () => 'gemini-2.5-flash',
  systemPrompt: () => DEFAULT_SYSTEM_PROMPT,
  cfAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cfApiToken: () => process.env.CLOUDFLARE_API_TOKEN || '',
  cfImageModel: () => '@cf/black-forest-labs/flux-1-schnell',
  cfSteps: () => '4',
  fbAppId: () => process.env.FACEBOOK_APP_ID || '',
  fbAppSecret: () => process.env.FACEBOOK_APP_SECRET || '',
  fbGraphVersion: () => 'v23.0',
};

const SETTING_KEYS = Object.keys(DEFAULTS) as SettingKey[];

/** Facebook App Secrets are 32 hex characters */
const FB_APP_SECRET = /^[0-9a-f]{32}$/i;

const isSecret = (key: string): key is SecretKey => (SECRET_KEYS as readonly string[]).includes(key);

/** Input accepted from the Settings form. Empty secret = keep current value. */
export const settingsInputSchema = z
  .object({
    geminiApiKey: z.string().trim(),
    geminiModel: z.string().trim().min(1).max(100),
    systemPrompt: z.string().trim().min(1).max(5000),
    cfAccountId: z.string().trim().max(100),
    cfApiToken: z.string().trim(),
    cfImageModel: z.string().trim().min(1).max(200),
    cfSteps: z.coerce.number().int().min(1).max(8),
    fbAppId: z
      .string()
      .trim()
      .regex(/^\d*$/, 'App ID chỉ gồm chữ số (lấy tại developers.facebook.com → App settings → Basic).'),
    fbAppSecret: z
      .string()
      .trim()
      .refine((v) => !v.startsWith('EAA'), 'Đây là Access Token (EAA…), không phải App Secret. Hãy dán nó vào mục “Page đăng bài”.')
      .refine((v) => v === '' || v.startsWith('EAA') || FB_APP_SECRET.test(v), 'App Secret phải là chuỗi 32 ký tự chữ và số (a–f, 0–9).'),
    fbGraphVersion: z.string().trim().regex(/^v\d+\.\d+$/, 'Định dạng phiên bản: v23.0'),
  })
  .partial();

export type SettingsInput = z.infer<typeof settingsInputSchema>;

async function loadRaw(userId: string): Promise<Map<string, string>> {
  const rows = await prisma.setting.findMany({ where: { userId, key: { in: SETTING_KEYS } } });
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Full decrypted settings. SERVER-ONLY — never send this object to the client. */
export async function getSettings(userId: string): Promise<AppSettings> {
  const raw = await loadRaw(userId);
  const value = (key: SettingKey): string => {
    const stored = raw.get(key);
    if (stored === undefined || stored === '') return DEFAULTS[key]();
    return isSecret(key) ? decrypt(stored) : stored;
  };

  return {
    geminiApiKey: value('geminiApiKey'),
    geminiModel: value('geminiModel'),
    systemPrompt: value('systemPrompt'),
    cfAccountId: value('cfAccountId'),
    cfApiToken: value('cfApiToken'),
    cfImageModel: value('cfImageModel'),
    cfSteps: Number(value('cfSteps')),
    fbAppId: value('fbAppId'),
    fbAppSecret: value('fbAppSecret'),
    fbGraphVersion: value('fbGraphVersion'),
  };
}

export interface SecretStatus {
  masked: string;
  source: 'db' | 'env' | 'none';
  /** Set when the stored value does not look like this kind of secret */
  warning?: string;
}

export type PublicSettings = Omit<AppSettings, SecretKey> & Record<SecretKey, SecretStatus>;

/** Settings safe to return to the client: secrets masked, with their source. */
export async function getPublicSettings(userId: string): Promise<PublicSettings> {
  const raw = await loadRaw(userId);
  const settings = await getSettings(userId);

  const secretStatus = (key: SecretKey): SecretStatus => {
    const value = settings[key];
    if (!value) return { masked: '', source: 'none' };
    const status: SecretStatus = { masked: mask(value), source: raw.get(key) ? 'db' : 'env' };
    if (key === 'fbAppSecret' && !FB_APP_SECRET.test(value)) {
      status.warning = value.startsWith('EAA')
        ? 'Giá trị đang lưu là Access Token (EAA…), không phải App Secret. Hãy nhập lại App Secret đúng.'
        : 'Giá trị đang lưu không giống App Secret (32 ký tự chữ và số).';
    }
    return status;
  };

  return {
    ...settings,
    geminiApiKey: secretStatus('geminiApiKey'),
    cfApiToken: secretStatus('cfApiToken'),
    fbAppSecret: secretStatus('fbAppSecret'),
  };
}

export async function saveSettings(userId: string, input: SettingsInput): Promise<void> {
  const entries = Object.entries(input).filter(
    ([key, value]) => value !== undefined && !(isSecret(key) && value === '')
  );

  await prisma.$transaction(
    entries.map(([key, value]) => {
      const stored = isSecret(key) ? encrypt(String(value)) : String(value);
      return prisma.setting.upsert({
        where: { userId_key: { userId, key } },
        update: { value: stored },
        create: { userId, key, value: stored },
      });
    })
  );
}

/** Read a secret column that may still hold a legacy plaintext value. */
export function revealSecret(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}
