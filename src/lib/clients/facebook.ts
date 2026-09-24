import { fetchWithRetry, redactSecrets } from '../http';

/**
 * Facebook Graph API client (native fetch, no SDK).
 * Every error message is redacted — tokens never reach logs or the UI.
 */

const GRAPH_BASE = 'https://graph.facebook.com';
const TIMEOUT_MS = 60_000;

export const REQUIRED_SCOPES = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'];

export interface FacebookAppConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
}

export class FacebookApiError extends Error {
  constructor(
    /** Vietnamese, user-facing message */
    message: string,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
    /** Original Graph API message (redacted) */
    readonly rawMessage?: string
  ) {
    super(message);
    this.name = 'FacebookApiError';
  }

  /** e.g. "code 190/463 · trace AbC123" */
  get errorCode(): string | undefined {
    if (this.code === undefined) return undefined;
    const code = this.subcode ? `${this.code}/${this.subcode}` : `${this.code}`;
    return this.fbtraceId ? `code ${code} · trace ${this.fbtraceId}` : `code ${code}`;
  }
}

/** Map Graph API error codes to messages a Page admin can act on. */
function toVietnamese(code: number | undefined, subcode: number | undefined, raw: string): string {
  switch (code) {
    case 190:
      if (subcode === 463) return 'Token Facebook đã hết hạn. Hãy lấy token mới trong Cấu hình.';
      if (subcode === 460) return 'Token Facebook mất hiệu lực do tài khoản đổi mật khẩu. Hãy lấy token mới.';
      return 'Token Facebook không hợp lệ hoặc đã bị thu hồi. Hãy kiểm tra lại trong Cấu hình.';
    case 101:
      return 'App ID hoặc App Secret không hợp lệ. Kiểm tra lại tại developers.facebook.com → App settings → Basic (App ID của App, không phải ID của Page).';
    case 10:
    case 200:
    case 3:
      return 'Token thiếu quyền cần thiết (pages_manage_posts, pages_read_engagement, pages_show_list) hoặc bạn không còn là quản trị viên Page.';
    case 4:
    case 17:
    case 32:
    case 613:
      return 'Facebook đang giới hạn tần suất gọi API. Hãy thử lại sau ít phút.';
    case 368:
      return 'Facebook tạm chặn hành động này vì nghi vi phạm tiêu chuẩn cộng đồng. Hãy xem lại nội dung/ảnh.';
    case 506:
      return 'Facebook từ chối vì bài đăng trùng với bài vừa đăng gần đây.';
    case 100:
      return `Tham số gửi lên Facebook không hợp lệ (sai Page ID, ảnh lỗi…): ${raw}`;
    case 1:
    case 2:
      return 'Facebook đang gặp sự cố tạm thời. Hãy thử lại sau.';
    default:
      return `Facebook báo lỗi: ${raw}`;
  }
}

export class FacebookClient {
  constructor(
    private readonly config: FacebookAppConfig,
    private readonly secrets: string[] = []
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams(params).toString();
    return `${GRAPH_BASE}/${this.config.graphVersion}/${path}${qs ? `?${qs}` : ''}`;
  }

  private get appAccessToken(): string {
    if (!this.config.appId || !this.config.appSecret) {
      throw new FacebookApiError('Chưa cấu hình Facebook App ID / App Secret.');
    }
    return `${this.config.appId}|${this.config.appSecret}`;
  }

  /** Parse a Graph API response; throw FacebookApiError on error payloads. */
  async parse<T>(response: Response, extraSecrets: string[] = []): Promise<T> {
    const scrub = (text: string) =>
      redactSecrets(text, [...this.secrets, ...extraSecrets, this.config.appSecret]);

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new FacebookApiError(`Facebook trả về phản hồi không đọc được (HTTP ${response.status}).`);
    }

    if (!response.ok || body?.error) {
      const err = body?.error ?? {};
      const raw = scrub(String(err.message ?? `HTTP ${response.status}`));
      throw new FacebookApiError(toVietnamese(err.code, err.error_subcode, raw), err.code, err.error_subcode, err.fbtrace_id, raw);
    }
    return body as T;
  }

  private async get<T>(path: string, params: Record<string, string>, secrets: string[] = []): Promise<T> {
    const response = await fetchWithRetry(this.url(path, params), { method: 'GET' }, { timeoutMs: TIMEOUT_MS });
    return this.parse<T>(response, secrets);
  }

  /** Inspect any token using the app access token. */
  async debugToken(inputToken: string): Promise<TokenDebugInfo> {
    const res = await this.get<{ data: RawDebugData }>(
      'debug_token',
      { input_token: inputToken, access_token: this.appAccessToken },
      [inputToken]
    );
    const d = res.data ?? ({} as RawDebugData);
    const scopes = d.scopes ?? [];

    return {
      isValid: !!d.is_valid,
      type: d.type ?? 'UNKNOWN',
      appId: d.app_id,
      profileId: d.profile_id,
      // expires_at = 0 means the token never expires
      expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null,
      scopes,
      missingScopes: REQUIRED_SCOPES.filter((s) => !scopes.includes(s)),
      error: d.error?.message ? redactSecrets(d.error.message, [inputToken]) : undefined,
    };
  }

  /** Short-lived user token → long-lived (~60 days) user token. */
  async exchangeLongLivedUserToken(shortToken: string): Promise<string> {
    void this.appAccessToken; // throws a clear error when App ID / App Secret are missing
    const res = await this.get<{ access_token: string }>(
      'oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: shortToken,
      },
      [shortToken]
    );
    return res.access_token;
  }

  /** Pages the user manages, with Page tokens (non-expiring when derived from a long-lived user token). */
  async listPages(userToken: string): Promise<GraphPage[]> {
    const res = await this.get<{ data: GraphPage[] }>(
      'me/accounts',
      { fields: 'id,name,category,access_token', limit: '100', access_token: userToken },
      [userToken]
    );
    return res.data ?? [];
  }

  /** Read basic Page info with a Page token — validates a manually entered token. */
  async getPage(pageId: string, pageToken: string): Promise<Omit<GraphPage, 'access_token'>> {
    return this.get(pageId, { fields: 'id,name,category', access_token: pageToken }, [pageToken]);
  }
}

interface RawDebugData {
  is_valid?: boolean;
  type?: string;
  app_id?: string;
  profile_id?: string;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  error?: { message?: string };
}

export interface TokenDebugInfo {
  isValid: boolean;
  type: string;
  appId?: string;
  profileId?: string;
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  scopes: string[];
  missingScopes: string[];
  error?: string;
}

export interface GraphPage {
  id: string;
  name: string;
  category?: string;
  access_token: string;
}
