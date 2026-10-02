// Dev: Vite (5173) talks to the API on 3000. Production: the API serves this
// build itself, so calls stay same-origin. VITE_API_ORIGIN overrides both.
const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');
const API_BASE = `${API_ORIGIN}/api`;

/** Server-relative asset paths (e.g. /api/images/…) → absolute URL for <img src>. */
export function assetUrl(path?: string | null): string | null {
  if (!path) return null;
  return path.startsWith('/api/') ? `${API_ORIGIN}${path}` : path;
}

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];

export type VideoKind = 'FEED' | 'REEL';

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  bytes: number;
}

export interface VideoState {
  videoUrl: string | null;
  videoKind: VideoKind | null;
  videoMeta: VideoMeta | null;
  /** Why the video can't be a Reel (null = it can) */
  reelsProblem: string | null;
}

export const EMPTY_VIDEO: VideoState = { videoUrl: null, videoKind: null, videoMeta: null, reelsProblem: null };

// ─── Fetch Wrapper ──────────────────────────────
// Session = httpOnly cookie set by the API (JS never sees it). Every call sends it
// (credentials) and the CSRF header the API requires on non-GET requests.

export const AUTH_EVENT = 'autopost:auth';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data: T; error?: string; pagination?: any; meta?: any }> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'autopost',
    ...(!(options.body instanceof FormData) && { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const code: string | undefined = data.code;
    if (code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { code } }));
    // Zod errors: show the first field message instead of "Validation failed"
    const detail: string | undefined = Array.isArray(data.details) ? data.details[0]?.message : undefined;
    throw new ApiError(detail ?? data.error ?? 'Request failed', response.status, code);
  }
  return data;
}

// ─── Auth API ───────────────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
}

export const authApi = {
  login: (email: string, password: string) =>
    apiFetch<PublicUser>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch<PublicUser>('/auth/me'),
};

// ─── Admin API (member management) ──────────────

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  pages: number;
  posts30d: number;
}

export interface MemberInput {
  name: string;
  email: string;
  password?: string;
  role: 'ADMIN' | 'USER';
}

type MemberRow = Omit<AdminUserRow, 'pages' | 'posts30d'>;

export const adminApi = {
  listUsers: () => apiFetch<AdminUserRow[]>('/admin/users'),
  createUser: (input: MemberInput & { password: string }) =>
    apiFetch<MemberRow>('/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateUser: (id: string, patch: Partial<MemberInput> & { isActive?: boolean }) =>
    apiFetch<MemberRow>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: string, confirmEmail: string) =>
    apiFetch(`/admin/users/${id}`, { method: 'DELETE', body: JSON.stringify({ confirmEmail }) }),
};

// ─── Pages API ──────────────────────────────────

export type TokenStatus = 'UNCHECKED' | 'VALID' | 'OTHER_APP' | 'EXPIRED' | 'REVOKED' | 'MISSING_PERMISSIONS' | 'ERROR';
export type BlockReason = 'DISCONNECTED' | 'OTHER_APP' | 'EXPIRED' | 'REVOKED' | 'MISSING_PERMISSIONS';

export interface PageInfo {
  id: string;
  pageId: string;
  pageName: string;
  pageCategory: string | null;
  pageAvatar: string | null;
  isActive: boolean;
  tokenAppId: string | null;
  tokenStatus: TokenStatus;
  tokenExpiresAt: string | null;
  missingScopes: string[] | null;
  tokenCheckedAt: string | null;
  tokenError: string | null;
  createdAt: string;
  _count?: { posts: number };
  /** Can be published to with the current Facebook App */
  postable: boolean;
  blockReason: BlockReason | null;
  blockMessage: string | null;
  /** Content domain preselected when creating a post for this Page */
  defaultDomainId: string | null;
}

export type SyncAction = 'update' | 'reconnect' | 'add' | 'disconnect';

export interface SyncItem {
  action: SyncAction;
  pageId: string;
  pageName: string;
  category?: string;
  picture?: string;
  pageDbId?: string;
  ref?: string;
  tokenStatus?: TokenStatus;
  problem?: string | null;
  selected: boolean;
}

export interface SyncPreview {
  appId: string;
  items: SyncItem[];
  counts: Record<SyncAction, number>;
}

export const pagesApi = {
  /** `meta.appId` = the Facebook App ID in Settings */
  list: () => apiFetch<PageInfo[]>('/pages'),

  /** Re-check every connected Page token now. */
  check: () => apiFetch<PageInfo[]>('/pages/check', { method: 'POST' }),

  checkOne: (id: string) => apiFetch<PageInfo>(`/pages/${id}/check`, { method: 'POST' }),

  /** What syncing with this user token would change (nothing is saved). */
  syncPreview: (userToken: string) =>
    apiFetch<SyncPreview>('/pages/sync/preview', { method: 'POST', body: JSON.stringify({ userToken }) }),

  syncApply: (refs: string[], disconnect: string[]) =>
    apiFetch<{ connected: number; disconnected: number; pages: PageInfo[] }>('/pages/sync/apply', {
      method: 'POST',
      body: JSON.stringify({ refs, disconnect }),
    }),

  connect: (pages: any[]) =>
    apiFetch('/pages/connect', { method: 'POST', body: JSON.stringify({ pages }) }),

  disconnect: (id: string) =>
    apiFetch(`/pages/${id}`, { method: 'DELETE' }),

  setDefaultDomain: (id: string, defaultDomainId: string | null) =>
    apiFetch<{ id: string; defaultDomainId: string | null }>(`/pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ defaultDomainId }),
    }),
};

// ─── Content domains & formats ──────────────────

export type FormatLength = 'SHORT' | 'MEDIUM' | 'LONG';

export const LENGTH_LABEL: Record<FormatLength, string> = {
  SHORT: 'Ngắn · 80–120 từ',
  MEDIUM: 'Vừa · 150–250 từ',
  LONG: 'Dài · 300–450 từ',
};

export interface ContentFormat {
  id: string;
  domainId: string;
  name: string;
  instructions: string;
  example: string | null;
  length: FormatLength;
  withImage: boolean;
  isDefault: boolean;
  legacyPrompt: boolean;
  isArchived: boolean;
  sortOrder: number;
  _count?: { posts: number };
}

export interface ContentDomain {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  voice: string | null;
  rules: string | null;
  defaultHashtags: string[] | null;
  imageStyle: string | null;
  isArchived: boolean;
  sortOrder: number;
  formats: ContentFormat[];
  _count?: { pages: number; posts: number; schedules: number };
}

export interface DomainInput {
  name?: string;
  description?: string | null;
  audience?: string | null;
  voice?: string | null;
  rules?: string | null;
  defaultHashtags?: string[];
  imageStyle?: string | null;
  isArchived?: boolean;
}

export interface FormatInput {
  name?: string;
  instructions?: string;
  example?: string | null;
  length?: FormatLength;
  withImage?: boolean;
  isDefault?: boolean;
  isArchived?: boolean;
}

export interface FormatPreview {
  prompt: string;
  post?: string;
  hashtags?: string[];
  imagePrompt?: string;
}

export const domainsApi = {
  list: (archived = false) => apiFetch<ContentDomain[]>(`/domains${archived ? '?archived=1' : ''}`),
  create: (body: DomainInput & { name: string; format: FormatInput & { name: string; instructions: string } }) =>
    apiFetch<ContentDomain>('/domains', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: DomainInput) => apiFetch<ContentDomain>(`/domains/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => apiFetch(`/domains/${id}`, { method: 'DELETE' }),
  createFormat: (domainId: string, body: FormatInput & { name: string; instructions: string }) =>
    apiFetch<ContentFormat>(`/domains/${domainId}/formats`, { method: 'POST', body: JSON.stringify(body) }),
  updateFormat: (id: string, body: FormatInput) => apiFetch<ContentFormat>(`/formats/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeFormat: (id: string) => apiFetch(`/formats/${id}`, { method: 'DELETE' }),
  /** `generate: true` costs one Gemini call of the user's key */
  preview: (formatId: string, body: { idea: string; pageId?: string; generate?: boolean }) =>
    apiFetch<FormatPreview>(`/formats/${formatId}/preview`, { method: 'POST', body: JSON.stringify(body) }),
};

// ─── Templates API ──────────────────────────────

export const templatesApi = {
  list: (params?: { category?: string; search?: string }) => {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch(`/templates${query}`);
  },

  get: (id: string) => apiFetch(`/templates/${id}`),

  create: (body: any) =>
    apiFetch('/templates', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: any) =>
    apiFetch(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  delete: (id: string) =>
    apiFetch(`/templates/${id}`, { method: 'DELETE' }),
};

// ─── Posts API ──────────────────────────────────

export interface PostUpdate {
  caption?: string;
  hashtags?: string[];
  callToAction?: string;
  imagePrompt?: string;
  /** The idea AI writes from */
  idea?: string;
  domainId?: string;
  formatId?: string;
  videoKind?: VideoKind;
}

export interface PostCommentRow {
  id: string;
  fbCommentId: string;
  authorName: string | null;
  message: string;
  commentedAt: string;
  fromPage: boolean;
  handledAt: string | null;
}

export interface CommentThread extends PostCommentRow {
  needsReply: boolean;
  replies: PostCommentRow[];
}

export interface CommentsPage {
  targetId: string;
  page: { id: string; pageName: string };
  canRead: boolean;
  canReply: boolean;
  commentsError: string | null;
  statsSyncedAt: string | null;
  reactionCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  unansweredCount: number;
  threads: CommentThread[];
}

export const postsApi = {
  list: (params?: { status?: string; pageId?: string; domainId?: string; page?: string; limit?: string }) => {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch(`/posts${query}`);
  },

  get: (id: string) => apiFetch(`/posts/${id}`),

  create: (body: any) =>
    apiFetch('/posts', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: PostUpdate) =>
    apiFetch(`/posts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  generate: (id: string, body?: any) =>
    apiFetch(`/posts/${id}/generate`, { method: 'POST', body: JSON.stringify(body || {}) }),

  /** Generate with Cloudflare; the image is stored and becomes the post's image. */
  generateImage: (id: string, prompt?: string) =>
    apiFetch<{ imageUrl: string; imagePrompt: string }>(`/posts/${id}/image/generate`, { method: 'POST', body: JSON.stringify({ prompt }) }),

  /** Upload a JPG/PNG/WebP (≤ 8 MB) from the user's computer. */
  uploadImage: async (id: string, file: File) => {
    const body = new FormData();
    body.append('image', file);
    const response = await fetch(`${API_BASE}/posts/${id}/image/upload`, {
      method: 'POST',
      body,
      credentials: 'include',
      headers: { 'X-Requested-With': 'autopost' },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Tải ảnh lên thất bại');
    return data as { success: boolean; data: { imageUrl: string } };
  },

  removeImage: (id: string) => apiFetch<{ imageUrl: null }>(`/posts/${id}/image`, { method: 'DELETE' }),

  /** XHR (not fetch) so a 100 MB upload can report progress */
  uploadVideo: (id: string, file: File, onProgress?: (percent: number) => void) =>
    new Promise<VideoState>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/posts/${id}/video/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'autopost');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data: any = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page (e.g. proxy 413) */
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data.data as VideoState);
        if (data.code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { code: data.code } }));
        const message = xhr.status === 413 ? 'Máy chủ từ chối file quá lớn.' : data.error || 'Tải video lên thất bại.';
        reject(new ApiError(message, xhr.status, data.code));
      };
      xhr.onerror = () => reject(new ApiError('Mất kết nối khi tải video lên.', 0));
      const body = new FormData();
      body.append('video', file);
      xhr.send(body);
    }),

  removeVideo: (id: string) => apiFetch<{ videoUrl: null }>(`/posts/${id}/video`, { method: 'DELETE' }),

  /** Pass `caption` to rewrite an unsaved draft (result is not persisted). */
  improve: (id: string, instruction: string, caption?: string) =>
    apiFetch(`/posts/${id}/improve`, { method: 'POST', body: JSON.stringify({ instruction, caption }) }),

  /** Publish to `pageIds` (default: the post's Pages), `intervalMinutes` apart. */
  comments: (id: string) => apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments`),
  refreshComments: (id: string) => apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/refresh`, { method: 'POST' }),
  replyComment: (id: string, commentId: string, message: string) =>
    apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/${commentId}/reply`, { method: 'POST', body: JSON.stringify({ message }) }),
  markHandled: (id: string, commentId: string, handled: boolean) =>
    apiFetch<{ pages: CommentsPage[] }>(`/posts/${id}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ handled }) }),

  /** Approve a schedule post for its slot. */
  approve: (id: string) => apiFetch<{ id: string; status: string; scheduledAt: string | null }>(`/posts/${id}/approve`, { method: 'POST' }),

  /** Publish at a chosen time ("Hẹn giờ đăng"); calling it again moves the time. */
  schedule: (id: string, body: { scheduledAt: string; pageIds?: string[]; intervalMinutes?: number }) =>
    apiFetch<{ id: string; status: string; scheduledAt: string; pages: number }>(`/posts/${id}/schedule`, { method: 'POST', body: JSON.stringify(body) }),

  /** Cancel the time: the post waits for approval again. */
  cancelSchedule: (id: string) => apiFetch<{ id: string; status: string; scheduledAt: null }>(`/posts/${id}/schedule`, { method: 'DELETE' }),

  publish: (id: string, body?: { pageIds?: string[]; intervalMinutes?: number }) =>
    apiFetch<{ pages: number; intervalMinutes: number }>(`/posts/${id}/publish`, { method: 'POST', body: JSON.stringify(body ?? {}) }),

  /** Publish again to one Page that failed. */
  retryTarget: (id: string, targetId: string) =>
    apiFetch(`/posts/${id}/targets/${targetId}/retry`, { method: 'POST' }),

  delete: (id: string) =>
    apiFetch(`/posts/${id}`, { method: 'DELETE' }),
};

// ─── Schedules API ──────────────────────────────

export interface ScheduleIdea {
  id: string;
  text: string;
  status: 'QUEUED' | 'USED';
  position: number;
  usedAt: string | null;
  postId: string | null;
}

export interface QueuedPost {
  id: string;
  status: 'DRAFT' | 'GENERATING' | 'READY' | 'SCHEDULED' | 'FAILED';
  scheduledAt: string | null;
  caption: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  approvedAt: string | null;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  isActive: boolean;
  frequency: string;
  weekdays: number[] | null;
  slots: string[] | null;
  bufferSize: number;
  startDate: string;
  endDate: string | null;
  domain: { id: string; name: string } | null;
  format: { id: string; name: string } | null;
  pages: { id: string; pageName: string; pageAvatar: string | null; isActive: boolean }[];
  ideasLeft: number;
  queuedCount: number;
  awaitingApproval: number;
  nextSlotAt: string | null;
}

export interface ScheduleDetail extends ScheduleSummary {
  ideas: ScheduleIdea[];
  queue: QueuedPost[];
}

export interface ScheduleInput {
  name: string;
  pageIds: string[];
  weekdays: number[];
  slots: string[];
  bufferSize: number;
  startDate?: string;
  endDate?: string | null;
  domainId?: string;
  formatId?: string;
  ideas?: string[];
}

export const schedulesApi = {
  list: () => apiFetch<ScheduleSummary[]>('/schedules'),
  get: (id: string) => apiFetch<ScheduleDetail>(`/schedules/${id}`),
  create: (body: ScheduleInput) => apiFetch<ScheduleSummary>('/schedules', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<ScheduleInput>) => apiFetch<ScheduleSummary>(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggle: (id: string) => apiFetch<ScheduleSummary>(`/schedules/${id}/toggle`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch(`/schedules/${id}`, { method: 'DELETE' }),
  addIdeas: (id: string, texts: string[]) => apiFetch<{ added: number }>(`/schedules/${id}/ideas`, { method: 'POST', body: JSON.stringify({ texts }) }),
  removeIdea: (id: string, ideaId: string) => apiFetch(`/schedules/${id}/ideas/${ideaId}`, { method: 'DELETE' }),
  orderIdeas: (id: string, ids: string[]) => apiFetch(`/schedules/${id}/ideas/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  suggestIdeas: (id: string) => apiFetch<{ ideas: string[] }>(`/schedules/${id}/ideas/suggest`, { method: 'POST' }),
};

// ─── Analytics API ──────────────────────────────

export const analyticsApi = {
  overview: () => apiFetch('/analytics/overview'),

  postsTimeline: (days?: number) =>
    apiFetch(`/analytics/posts-timeline?days=${days || 30}`),

  pagesPerformance: () => apiFetch('/analytics/pages-performance'),
};

// ─── Settings API ───────────────────────────────

export interface SecretStatus {
  masked: string;
  source: 'db' | 'env' | 'none';
  warning?: string;
}

export interface PublicSettings {
  geminiApiKey: SecretStatus;
  geminiModel: string;
  systemPrompt: string;
  cfAccountId: string;
  cfApiToken: SecretStatus;
  cfImageModel: string;
  cfSteps: number;
  fbAppId: string;
  fbAppSecret: SecretStatus;
  fbGraphVersion: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  code?: string;
  details?: Record<string, any>;
}

export interface ExchangedPage {
  id: string;
  name: string;
  category?: string;
  /** Encrypted server-side payload holding the Page token */
  ref: string;
}

export type SettingsGroup = 'gemini' | 'cloudflare' | 'facebook';

export const settingsApi = {
  get: () => apiFetch<PublicSettings>('/settings'),
  /** Empty secret fields keep their current value. */
  update: (settings: Record<string, string | number>) =>
    apiFetch<PublicSettings>('/settings', { method: 'POST', body: JSON.stringify({ settings }) }),
  test: (group: SettingsGroup, body?: { pageId?: string }) =>
    apiFetch<ConnectionTestResult>(`/settings/test/${group}`, { method: 'POST', body: JSON.stringify(body || {}) }),
  exchangeToken: (shortToken: string) =>
    apiFetch<ExchangedPage[]>('/settings/facebook/exchange-token', { method: 'POST', body: JSON.stringify({ shortToken }) }),
  connectPages: (refs: string[]) =>
    apiFetch('/settings/facebook/pages', { method: 'POST', body: JSON.stringify({ refs }) }),
  addPageManually: (pageId: string, pageAccessToken: string) =>
    apiFetch('/settings/facebook/pages/manual', { method: 'POST', body: JSON.stringify({ pageId, pageAccessToken }) }),
};
