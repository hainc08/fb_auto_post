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

// ─── Auth Token Management ──────────────────────

function getToken(): string | null {
  return localStorage.getItem('autopost_token');
}

export function setToken(token: string): void {
  localStorage.setItem('autopost_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('autopost_token');
  localStorage.removeItem('autopost_user');
}

export function getStoredUser(): any {
  return { id: 'dummy-user', name: 'Admin', plan: 'PRO', email: 'admin@example.com' };
}

export function setStoredUser(user: any): void {
  localStorage.setItem('autopost_user', JSON.stringify(user));
}

// ─── Fetch Wrapper ──────────────────────────────

async function apiFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data: T; error?: string; pagination?: any }> {
  const token = getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// ─── Auth API ───────────────────────────────────

export const authApi = {
  register: (body: { email: string; password: string; name: string }) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: (body: { email: string; password: string }) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  me: () => apiFetch('/auth/me'),

  getFacebookLoginUrl: () => apiFetch('/auth/facebook'),
};

// ─── Pages API ──────────────────────────────────

export const pagesApi = {
  list: () => apiFetch('/pages'),

  connect: (pages: any[]) =>
    apiFetch('/pages/connect', { method: 'POST', body: JSON.stringify({ pages }) }),

  disconnect: (id: string) =>
    apiFetch(`/pages/${id}`, { method: 'DELETE' }),
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
}

export const postsApi = {
  list: (params?: { status?: string; pageId?: string; page?: string; limit?: string }) => {
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
    const response = await fetch(`${API_BASE}/posts/${id}/image/upload`, { method: 'POST', body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Tải ảnh lên thất bại');
    return data as { success: boolean; data: { imageUrl: string } };
  },

  removeImage: (id: string) => apiFetch<{ imageUrl: null }>(`/posts/${id}/image`, { method: 'DELETE' }),

  /** Pass `caption` to rewrite an unsaved draft (result is not persisted). */
  improve: (id: string, instruction: string, caption?: string) =>
    apiFetch(`/posts/${id}/improve`, { method: 'POST', body: JSON.stringify({ instruction, caption }) }),

  publish: (id: string) =>
    apiFetch(`/posts/${id}/publish`, { method: 'POST' }),

  delete: (id: string) =>
    apiFetch(`/posts/${id}`, { method: 'DELETE' }),
};

// ─── Schedules API ──────────────────────────────

export const schedulesApi = {
  list: () => apiFetch('/schedules'),

  create: (body: any) =>
    apiFetch('/schedules', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: any) =>
    apiFetch(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  toggle: (id: string) =>
    apiFetch(`/schedules/${id}/toggle`, { method: 'PATCH' }),

  delete: (id: string) =>
    apiFetch(`/schedules/${id}`, { method: 'DELETE' }),
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
