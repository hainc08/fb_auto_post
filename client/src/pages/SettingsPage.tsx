import { useEffect, useState, type ReactNode } from 'react';
import { Save, PlugZap, Sparkles, Image as ImageIcon, KeyRound, CheckCircle2, XCircle, RefreshCw, SlidersHorizontal } from 'lucide-react';
import {
  settingsApi,
  pagesApi,
  type PublicSettings,
  type SecretStatus,
  type ConnectionTestResult,
  type PageInfo,
  type SettingsGroup,
} from '../api';
import { useToast } from '../components/Toast';
import PageSync from '../components/PageSync';
import { PageStatusBadge, notifyPagesChanged } from '../components/PageStatus';

type FieldKey = keyof PublicSettings;

const GROUP_FIELDS: Record<SettingsGroup, FieldKey[]> = {
  gemini: ['geminiApiKey', 'geminiModel', 'systemPrompt'],
  cloudflare: ['cfAccountId', 'cfApiToken', 'cfImageModel', 'cfSteps'],
  facebook: ['fbAppId', 'fbAppSecret', 'fbGraphVersion'],
};

const SECRET_FIELDS = new Set<FieldKey>(['geminiApiKey', 'cfApiToken', 'fbAppSecret']);

/** Form state: plain values as strings; secrets start empty (= keep current). */
type FormState = Record<FieldKey, string>;

function toForm(s: PublicSettings): FormState {
  return {
    geminiApiKey: '',
    geminiModel: s.geminiModel,
    systemPrompt: s.systemPrompt,
    cfAccountId: s.cfAccountId,
    cfApiToken: '',
    cfImageModel: s.cfImageModel,
    cfSteps: String(s.cfSteps),
    fbAppId: s.fbAppId,
    fbAppSecret: '',
    fbGraphVersion: s.fbGraphVersion,
  };
}

export default function SettingsPage() {
  const toast = useToast();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<string, ConnectionTestResult>>>({});
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [appId, setAppId] = useState('');
  const [section, setSection] = useState<SettingsGroup>(() => {
    const hash = window.location.hash.replace('#', '');
    return hash === 'gemini' || hash === 'cloudflare' || hash === 'facebook' ? hash : 'facebook';
  });

  const openSection = (group: SettingsGroup) => {
    setSection(group);
    window.history.replaceState(null, '', `#${group}`);
  };

  useEffect(() => {
    settingsApi
      .get()
      .then((r) => {
        setSaved(r.data);
        setForm(toForm(r.data));
      })
      .catch((e) => toast.error(`Không tải được cấu hình: ${e.message}`));
    loadPages();
  }, []);

  function loadPages() {
    pagesApi
      .list()
      .then((r) => {
        setPages(r.data.filter((p) => p.isActive));
        setAppId(r.meta?.appId ?? '');
      })
      .catch(() => {});
  }

  if (!form || !saved) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;

  const set = (key: FieldKey) => (value: string) => setForm({ ...form, [key]: value });

  const dirtyFields = (group: SettingsGroup) =>
    GROUP_FIELDS[group].filter((k) => (SECRET_FIELDS.has(k) ? form[k] !== '' : form[k] !== toForm(saved)[k]));

  async function saveGroup(group: SettingsGroup, quiet = false): Promise<boolean> {
    const payload = Object.fromEntries(GROUP_FIELDS[group].map((k) => [k, form![k]]));
    try {
      const res = await settingsApi.update(payload);
      setSaved(res.data);
      setForm((f) => ({ ...f!, ...pick(toForm(res.data), GROUP_FIELDS[group]) }));
      if (!quiet) toast.success('Đã lưu cấu hình.');
      // A new App ID changes which Pages can publish
      if (group === 'facebook') {
        loadPages();
        notifyPagesChanged();
      }
      return true;
    } catch (e: any) {
      toast.error(`Lưu thất bại: ${e.message}`);
      return false;
    }
  }

  async function runTest(group: SettingsGroup, pageId?: string) {
    const key = pageId ? `page:${pageId}` : group;
    setBusy(`test:${key}`);
    try {
      if (dirtyFields(group).length > 0 && !(await saveGroup(group, true))) return;
      const res = await settingsApi.test(group, pageId ? { pageId } : undefined);
      setResults((r) => ({ ...r, [key]: res.data }));
    } catch (e: any) {
      setResults((r) => ({ ...r, [key]: { ok: false, message: e.message } }));
    } finally {
      setBusy(null);
      // The Facebook check stores each Page's token status
      if (group === 'facebook') {
        loadPages();
        notifyPagesChanged();
      }
    }
  }

  async function handleSave(group: SettingsGroup) {
    setBusy(`save:${group}`);
    await saveGroup(group);
    setBusy(null);
  }

  const groupActions = (group: SettingsGroup) => (
    <div className="settings-actions">
      <button className="btn btn-secondary btn-sm" onClick={() => runTest(group)} disabled={!!busy}>
        {busy === `test:${group}` ? <div className="spinner" /> : <><PlugZap size={14} /> Kiểm tra kết nối</>}
      </button>
      <button className="btn btn-primary btn-sm" onClick={() => handleSave(group)} disabled={!!busy || dirtyFields(group).length === 0}>
        {busy === `save:${group}` ? <div className="spinner" /> : <><Save size={14} /> Lưu</>}
      </button>
    </div>
  );

  const sourceDot = (status: SecretStatus) =>
    status.source === 'db' ? null : <span className={`dot ${status.source === 'env' ? 'warn' : 'bad'}`} aria-label={status.source === 'env' ? 'Đang dùng khoá tạm' : 'Chưa cấu hình'} />;

  const NAV: Array<{ group: SettingsGroup; label: string; icon: ReactNode; dot: ReactNode }> = [
    { group: 'gemini', label: 'AI viết bài', icon: <Sparkles size={16} aria-hidden="true" />, dot: sourceDot(saved.geminiApiKey) },
    { group: 'cloudflare', label: 'Tạo ảnh', icon: <ImageIcon size={16} aria-hidden="true" />, dot: sourceDot(saved.cfApiToken) },
    { group: 'facebook', label: 'Facebook', icon: <KeyRound size={16} aria-hidden="true" />, dot: pages.length === 0 ? <span className="dot bad" aria-label="Chưa kết nối Page" /> : null },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Cài đặt</h1>
          <p>Khoá API và token được mã hoá trước khi lưu, chỉ hiển thị 4 ký tự cuối.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Mục cài đặt">
          {NAV.map((n) => (
            <button key={n.group} type="button" aria-current={section === n.group ? 'page' : undefined} onClick={() => openSection(n.group)}>
              {n.icon}
              <span className="sn-label">{n.label}</span>
              {n.dot}
            </button>
          ))}
        </nav>

        <div className="settings-stack">
          {section === 'gemini' && (
            <section className="card settings-card">
              <GroupHeader icon={<Sparkles size={18} />} title="Google Gemini" subtitle="Viết nội dung bài và prompt ảnh" />
              <div className="settings-card-body">
                <div className="settings-fields two-col">
                  <SecretField label="API key" status={saved.geminiApiKey} value={form.geminiApiKey} onChange={set('geminiApiKey')} />
                  <TextField label="Model" value={form.geminiModel} onChange={set('geminiModel')} hint="Mặc định gemini-2.5-flash" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="system-prompt">System prompt</label>
                  <p className="field-hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    Chỉ dẫn gốc cho AI. Đặt <code>{'{{topic}}'}</code> ở nơi muốn chèn ý tưởng bài viết (không có thì ý tưởng được thêm vào cuối).
                    Càng cụ thể về Fanpage, độc giả và giọng văn thì bài càng đúng chất thương hiệu.
                  </p>
                  <textarea id="system-prompt" className="form-textarea mono" rows={16} value={form.systemPrompt} onChange={(e) => set('systemPrompt')(e.target.value)} />
                  {/\[TÊN PAGE\]|\[ĐỐI TƯỢNG ĐỘC GIẢ\]/.test(form.systemPrompt) && (
                    <p className="field-warning">Prompt vẫn còn chỗ trống [TÊN PAGE] / [ĐỐI TƯỢNG ĐỘC GIẢ] — AI sẽ viết chung chung.</p>
                  )}
                </div>
                <TestResultView result={results.gemini} />
                {groupActions('gemini')}
              </div>
            </section>
          )}

          {section === 'cloudflare' && (
            <section className="card settings-card">
              <GroupHeader icon={<ImageIcon size={18} />} title="Cloudflare Workers AI" subtitle="Tạo ảnh minh hoạ cho bài đăng" />
              <div className="settings-card-body">
                <div className="settings-fields two-col">
                  <TextField label="Account ID" value={form.cfAccountId} onChange={set('cfAccountId')} />
                  <SecretField label="API token" status={saved.cfApiToken} value={form.cfApiToken} onChange={set('cfApiToken')} />
                  <TextField label="Model ảnh" value={form.cfImageModel} onChange={set('cfImageModel')} hint="Mặc định @cf/black-forest-labs/flux-1-schnell (~2 giây/ảnh)" />
                  <div className="form-group">
                    <label className="form-label">Số bước (steps): {form.cfSteps}</label>
                    <input type="range" min={1} max={8} value={form.cfSteps} onChange={(e) => set('cfSteps')(e.target.value)} className="range-input" aria-label="Số bước tạo ảnh" />
                    <p className="field-hint">flux-schnell đẹp nhất ở 4 bước; tăng lên chậm hơn và tốn neuron hơn.</p>
                  </div>
                </div>
                <TestResultView result={results.cloudflare} />
                {groupActions('cloudflare')}
              </div>
            </section>
          )}

          {section === 'facebook' && (
            <>
              <section className="card settings-card" aria-labelledby="fb-pages-title">
                <div className="settings-card-header">
                  <div className="settings-icon"><KeyRound size={18} /></div>
                  <div style={{ flex: 1 }}>
                    <h3 id="fb-pages-title">Page đăng bài <span className="required-tag">Bắt buộc</span></h3>
                    <p className="card-subtitle">Mỗi Page cần Page ID và Page Access Token (chuỗi bắt đầu bằng <code>EAA…</code>).</p>
                  </div>
                </div>
                <div className="settings-card-body">
                  {pages.length === 0 ? (
                    <p className="field-hint" style={{ marginTop: 0 }}>Chưa có Page nào được kết nối — dùng một trong hai cách bên dưới.</p>
                  ) : (
                    <div className="page-list">
                      {pages.map((p) => (
                        <div key={p.id} className="page-row">
                          <div className="page-row-main">
                            <div className="page-avatar">{p.pageName?.[0] ?? 'P'}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="page-name">{p.pageName} <PageStatusBadge page={p} /></div>
                              <div className="page-meta">{p.pageId}{p.pageCategory ? ` · ${p.pageCategory}` : ''}</div>
                              {p.blockMessage && <div className="field-warning" style={{ margin: '4px 0 0' }}>{p.blockMessage}</div>}
                            </div>
                            <button className="btn btn-secondary btn-sm" onClick={() => runTest('facebook', p.id)} disabled={!!busy}>
                              {busy === `test:page:${p.id}` ? <div className="spinner" /> : <><PlugZap size={14} /> Kiểm tra token</>}
                            </button>
                          </div>
                          <TestResultView result={results[`page:${p.id}`]} />
                        </div>
                      ))}
                    </div>
                  )}

                  <details className="settings-tool" open={pages.length === 0 || pages.some((p) => !p.postable)}>
                    <summary>
                      <RefreshCw size={14} /> Cách 1 — Đồng bộ Page với App hiện tại <span className="optional-tag">khuyên dùng</span>
                    </summary>
                    <div style={{ marginTop: 12 }}>
                      <PageSync appId={appId} onApplied={() => loadPages()} />
                    </div>
                  </details>
                  <ManualPage busy={!!busy} setBusy={setBusy} onConnected={loadPages} />

                  <p className="field-note">
                    Page Access Token lấy trực tiếp từ Graph API Explorer (cách 2) chỉ dùng được <b>khoảng 1–2 giờ</b>, trừ khi bạn dán User
                    token dài hạn. Token nhận qua cách 1 thường <b>không hết hạn</b>, nhưng mất hiệu lực khi tài khoản quản trị đổi mật
                    khẩu, mất quyền admin Page, hoặc gỡ quyền của App.
                  </p>
                </div>
              </section>

              <section className="card settings-card" aria-labelledby="fb-app-title">
                <div className="settings-card-header">
                  <div className="settings-icon" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}><SlidersHorizontal size={18} /></div>
                  <div style={{ flex: 1 }}>
                    <h3 id="fb-app-title">Ứng dụng Facebook (App) <span className="optional-tag">Tuỳ chọn</span></h3>
                    <p className="card-subtitle">
                      Dùng để đổi sang token không hết hạn và kiểm tra quyền. Lấy tại{' '}
                      <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com</a> → App settings → Basic.
                    </p>
                  </div>
                </div>
                <div className="settings-card-body">
                  <div className="settings-fields three-col">
                    <TextField
                      label="App ID (ID của ứng dụng)"
                      value={form.fbAppId}
                      onChange={set('fbAppId')}
                      placeholder="Dãy số của App, không phải của Page"
                      hint="Là ID của App, KHÁC với Page ID."
                      warning={
                        pages.some((p) => p.pageId === form.fbAppId.trim())
                          ? 'Số này là Page ID của Fanpage, không phải App ID. Thay bằng App ID thật hoặc để trống.'
                          : looksLikeAccessToken(form.fbAppId)
                            ? 'Đây là Access Token, không phải App ID.'
                            : null
                      }
                    />
                    <SecretField
                      label="App Secret"
                      status={saved.fbAppSecret}
                      value={form.fbAppSecret}
                      onChange={set('fbAppSecret')}
                      hint="32 ký tự chữ + số, nằm cạnh App ID (bấm Show). KHÔNG phải Access Token."
                      warning={
                        looksLikeAccessToken(form.fbAppSecret)
                          ? 'Đây là Access Token (EAA…), không phải App Secret. Hãy dán nó vào mục “Page đăng bài”.'
                          : null
                      }
                    />
                    <TextField label="Graph API version" value={form.fbGraphVersion} onChange={set('fbGraphVersion')} hint="Mặc định v23.0" />
                  </div>
                  <TestResultView result={results.facebook} />
                  {groupActions('facebook')}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Facebook tools ─────────────────────────────

interface ToolProps {
  busy: boolean;
  setBusy: (v: string | null) => void;
  onConnected: () => void;
}

function ManualPage({ busy, setBusy, onConnected }: ToolProps) {
  const toast = useToast();
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');

  async function add() {
    setBusy('manual');
    try {
      const res = await settingsApi.addPageManually(pageId.trim(), token.trim());
      toast.success(
        res.data.fromUserToken
          ? `Đã kết nối "${res.data.pageName}" — đã tự đổi User Token sang Page Access Token.`
          : `Đã kết nối "${res.data.pageName}".`
      );
      if (res.data.warning) toast.error(res.data.warning);
      setPageId('');
      setToken('');
      onConnected();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="settings-tool">
      <summary>
        <KeyRound size={14} /> Cách 2 — Nhập Page ID + Page Access Token
        <span className="optional-tag">không cần App</span>
      </summary>
      <ol className="tool-steps">
        <li>Mở <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Graph API Explorer</a>, ô <b>User or Page</b> chọn <b>đúng Page</b> của bạn.</li>
        <li>Thêm quyền <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code> → Generate Access Token → copy chuỗi <code>EAA…</code>.</li>
      </ol>
      <div className="manual-grid">
        <div className="form-group">
          <label className="form-label">Page ID (ID của Fanpage)</label>
          <input className={`form-input ${pageId && !isNumericId(pageId) ? 'input-warn' : ''}`}
            placeholder="VD: 509094482469402" inputMode="numeric" value={pageId} onChange={(e) => setPageId(e.target.value)} />
          {pageId && !isNumericId(pageId) && <p className="field-warning">⚠ Page ID chỉ gồm chữ số.</p>}
        </div>
        <div className="form-group">
          <label className="form-label">Access Token (Page hoặc User token, bắt đầu bằng EAA…)</label>
          <input className={`form-input ${looksLikeAppSecret(token) ? 'input-warn' : ''}`} type="password" autoComplete="off"
            placeholder="EAA… — không phải App Secret" value={token} onChange={(e) => setToken(e.target.value)} />
          {looksLikeAppSecret(token) && (
            <p className="field-warning">⚠ Đây giống App Secret (32 ký tự). Ô này cần Page Access Token bắt đầu bằng EAA…</p>
          )}
        </div>
        <button className="btn btn-primary" onClick={add}
          disabled={busy || !isNumericId(pageId) || token.trim().length < 20 || looksLikeAppSecret(token)}>
          Kết nối Page
        </button>
      </div>
    </details>
  );
}

// ─── Small building blocks ──────────────────────

function GroupHeader({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="settings-card-header">
      <div className="settings-icon">{icon}</div>
      <div>
        <h3 className="card-title">{title}</h3>
        <p className="field-hint" style={{ margin: 0 }}>{subtitle}</p>
      </div>
    </div>
  );
}

interface FieldProps {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  /** Shown when the value looks like it belongs in another field */
  warning?: string | null;
  placeholder?: string;
}

function TextField({ label, value, onChange, hint, warning, placeholder }: FieldProps) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input className={`form-input ${warning ? 'input-warn' : ''}`} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
      {warning ? <p className="field-warning">⚠ {warning}</p> : hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

const SOURCE_LABEL = { db: 'Đã lưu', env: 'Đang dùng tạm từ .env', none: 'Chưa có' };

function SecretField({ label, status, value, onChange, hint, warning }: FieldProps & { status: SecretStatus }) {
  return (
    <div className="form-group">
      <label className="form-label">
        {label} <span className={`source-tag source-${status.source}`}>{SOURCE_LABEL[status.source]}</span>
      </label>
      <input className={`form-input ${warning ? 'input-warn' : ''}`} type="password" autoComplete="new-password"
        placeholder={status.masked ? `${status.masked} — để trống để giữ nguyên` : 'Nhập giá trị'}
        value={value} onChange={(e) => onChange(e.target.value)} />
      {warning || (!value && status.warning) ? (
        <p className="field-warning">⚠ {warning || status.warning}</p>
      ) : (
        hint && <p className="field-hint">{hint}</p>
      )}
    </div>
  );
}

// ─── Mix-up detection (App Secret vs Access Token vs Page ID) ──

/** Facebook access tokens (user/page) start with EAA */
const looksLikeAccessToken = (v: string) => v.trim().startsWith('EAA');
/** App Secrets are 32 hex characters */
const looksLikeAppSecret = (v: string) => /^[0-9a-f]{32}$/i.test(v.trim());
const isNumericId = (v: string) => /^\d+$/.test(v.trim());

function TestResultView({ result }: { result?: ConnectionTestResult }) {
  if (!result) return null;
  const d = result.details ?? {};
  return (
    <div className={`test-result ${result.ok ? 'ok' : 'fail'}`}>
      <div className="test-result-head">
        {result.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        <span>{result.message}</span>
        {result.code && <code className="test-code">{result.code}</code>}
      </div>
      {Array.isArray(d.scopes) && (
        <div className="test-details">
          <div>Loại token: <b>{d.type}</b> · Hết hạn: <b>{d.expiresAt ? new Date(d.expiresAt).toLocaleString('vi-VN') : 'Không hết hạn'}</b></div>
          <div className="scope-list">
            {d.scopes.map((s: string) => <span key={s} className="scope-chip">{s}</span>)}
            {(d.missingScopes ?? []).map((s: string) => <span key={s} className="scope-chip missing">thiếu {s}</span>)}
          </div>
        </div>
      )}
      {d.expiresOn && <div className="test-details">Token hết hạn: <b>{new Date(d.expiresOn).toLocaleString('vi-VN')}</b></div>}
    </div>
  );
}

function pick<T extends Record<string, unknown>>(obj: T, keys: (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Partial<T>;
}
