import { fetchWithRetry, redactSecrets } from '../http';

/**
 * Cloudflare Workers AI client (native fetch).
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const VERIFY_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 90_000;
/** flux-2 models only accept multipart/form-data input */
const MULTIPART_MODELS = /\/flux-2/;

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  imageModel: string;
  steps: number;
}

export class CloudflareError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number, readonly rawMessage?: string) {
    super(message);
    this.name = 'CloudflareError';
  }

  get errorCode(): string | undefined {
    if (this.code) return `code ${this.code}`;
    return this.status ? `HTTP ${this.status}` : undefined;
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

export interface TokenVerifyResult {
  status: string;
  expiresOn?: string;
  /** 'user' = user API token, 'account' = account-owned token (cfat_…) */
  tokenKind: 'user' | 'account';
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

export class CloudflareClient {
  constructor(private readonly config: CloudflareConfig) {
    if (!config.apiToken) throw new CloudflareError('Chưa cấu hình Cloudflare API token.');
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiToken}` };
  }

  scrub(text: string): string {
    return redactSecrets(text, [this.config.apiToken]);
  }

  /**
   * Verify the token. User tokens verify at /user/tokens/verify; account-owned
   * tokens (prefix cfat_) only verify at /accounts/{id}/tokens/verify.
   */
  async verifyToken(): Promise<TokenVerifyResult> {
    const attempts: Array<{ kind: 'user' | 'account'; url: string }> = [
      { kind: 'user', url: `${CF_API}/user/tokens/verify` },
    ];
    if (this.config.accountId) {
      const accountAttempt = { kind: 'account' as const, url: `${CF_API}/accounts/${this.config.accountId}/tokens/verify` };
      if (this.config.apiToken.startsWith('cfat_')) attempts.unshift(accountAttempt);
      else attempts.push(accountAttempt);
    }

    let lastError: CloudflareError | undefined;
    for (const attempt of attempts) {
      const response = await fetchWithRetry(attempt.url, { headers: this.authHeaders }, { timeoutMs: VERIFY_TIMEOUT_MS });
      const body = (await response.json().catch(() => ({}))) as CfEnvelope<{ status: string; expires_on?: string }>;

      if (response.ok && body.success && body.result) {
        return { status: body.result.status, expiresOn: body.result.expires_on, tokenKind: attempt.kind };
      }
      lastError = this.toError(response.status, body);
    }
    throw lastError!;
  }

  /**
   * Run the configured text-to-image model. Handles the three response/input
   * shapes Workers AI uses:
   *  - flux-1-schnell: JSON body in, JSON `{ result: { image: <base64 jpeg> } }` out
   *  - flux-2-*: multipart/form-data in (JSON is rejected with code 5006), JSON base64 out
   *  - SDXL & co: JSON body in, raw `image/png` bytes out
   */
  async generateImage(prompt: string): Promise<GeneratedImage> {
    const { accountId, imageModel, steps } = this.config;
    if (!accountId) throw new CloudflareError('Chưa cấu hình Cloudflare Account ID.');

    const url = `${CF_API}/accounts/${accountId}/ai/run/${imageModel}`;
    let body: RequestInit['body'];
    const headers: Record<string, string> = { ...this.authHeaders };

    if (MULTIPART_MODELS.test(imageModel)) {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('steps', String(steps));
      form.append('width', '1024');
      form.append('height', '1024');
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ prompt, steps });
    }

    const response = await fetchWithRetry(url, { method: 'POST', headers, body }, { timeoutMs: IMAGE_TIMEOUT_MS });
    const contentType = response.headers.get('content-type') ?? '';

    if (response.ok && contentType.startsWith('image/')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new CloudflareError('Cloudflare trả về ảnh rỗng.');
      return { buffer, mimeType: contentType.split(';')[0] };
    }

    const json = (await response.json().catch(() => ({}))) as CfEnvelope<{ image?: string }>;
    if (!response.ok || !json.success) throw this.toError(response.status, json);

    const base64 = json.result?.image;
    if (!base64) throw new CloudflareError('Cloudflare không trả về dữ liệu ảnh (thiếu result.image).');
    return { buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg' };
  }

  toError(status: number, body: CfEnvelope<unknown>): CloudflareError {
    const first = body.errors?.[0];
    const raw = this.scrub(first?.message ?? `HTTP ${status}`);

    if (status === 401 || status === 403 || first?.code === 1000 || first?.code === 10000) {
      return new CloudflareError('Cloudflare API token không hợp lệ, đã hết hạn hoặc thiếu quyền Workers AI.', status, first?.code, raw);
    }
    if (first?.code === 5006) {
      return new CloudflareError(`Model ảnh từ chối dữ liệu đầu vào: ${raw}`, status, first.code, raw);
    }
    if (status === 404) {
      return new CloudflareError(`Không tìm thấy Account ID hoặc model Cloudflare: ${raw}`, status, first?.code, raw);
    }
    if (status === 429) {
      return new CloudflareError('Cloudflare Workers AI vượt giới hạn (hết neuron miễn phí trong ngày hoặc gọi quá nhanh).', status, first?.code, raw);
    }
    if (status >= 500) {
      return new CloudflareError('Cloudflare Workers AI đang gặp sự cố. Hãy thử lại sau.', status, first?.code, raw);
    }
    return new CloudflareError(`Cloudflare báo lỗi: ${raw}`, status, first?.code, raw);
  }
}
