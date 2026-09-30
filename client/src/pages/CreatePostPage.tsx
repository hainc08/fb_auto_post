import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Check, Sparkles, RefreshCw, ImageIcon, Send, X, Upload, AlertTriangle } from 'lucide-react';
import {
  postsApi,
  pagesApi,
  domainsApi,
  assetUrl,
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPES,
  EMPTY_VIDEO,
  type ContentDomain,
  type PageInfo,
  type PostUpdate,
  type VideoState,
} from '../api';
import { useToast } from '../components/Toast';
import { wordCount, pageInitials } from '../components/PostBits';
import PromptPreview from '../components/PromptPreview';
import VideoField from '../components/VideoField';

const HOOK_LENGTH = 125;

const QUICK_REWRITES = [
  { label: 'Hook mạnh hơn', instruction: 'Viết lại câu mở đầu thật gây tò mò, giữ nguyên ý chính và bố cục' },
  { label: 'Ngắn gọn hơn', instruction: 'Rút gọn còn khoảng 2/3, giữ ý quan trọng nhất và bố cục' },
  { label: 'Thân thiện hơn', instruction: 'Đổi sang giọng thân thiện, gần gũi như nói chuyện với đồng nghiệp, giữ bố cục' },
];

const normalizeTag = (t: string) => t.trim().replace(/^#+/, '').replace(/\s+/g, '');

/** Gap between Pages when one post goes to several (same text on many Pages at once looks like spam). */
const INTERVAL_OPTIONS = [0, 1, 2, 5, 10];
const DEFAULT_INTERVAL = 2;
const PAGES_KEY = 'autopost.selectedPages';
const FORMAT_KEY = 'autopost.lastFormat';

function rememberedFormat(): { domainId?: string; formatId?: string } {
  try {
    return JSON.parse(localStorage.getItem(FORMAT_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function rememberedPages(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PAGES_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} phút`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} giờ ${minutes % 60} phút` : `${h} giờ`;
}

type Busy = null | 'writing' | 'rewriting' | 'image' | 'upload' | 'saving' | 'publishing';

export default function CreatePostPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const initial = (location.state ?? {}) as { idea?: string; autoGenerate?: boolean };

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_INTERVAL);
  const [idea, setIdea] = useState(initial.idea ?? '');
  const [postId, setPostId] = useState<string | null>(null);
  const [savedIdea, setSavedIdea] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [timings, setTimings] = useState<{ writing?: number; image?: number }>({});
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [video, setVideo] = useState<VideoState>(EMPTY_VIDEO);
  const [videoBusy, setVideoBusy] = useState(false);
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [domainId, setDomainId] = useState('');
  const [formatId, setFormatId] = useState('');
  /** Domain/format saved on the post, and the one its current text was written with */
  const [savedPick, setSavedPick] = useState<{ domainId: string; formatId: string } | null>(null);
  const [writtenPick, setWrittenPick] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const autoRan = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([pagesApi.list(), domainsApi.list()])
      .then(([pagesRes, domainsRes]) => {
        const active = pagesRes.data.filter((p) => p.isActive);
        setPages(active);
        // Last selection (still postable), else the first postable Page
        const postable = active.filter((p) => p.postable);
        const kept = rememberedPages().filter((id) => postable.some((p) => p.id === id));
        const picked = kept.length ? kept : postable[0] ? [postable[0].id] : [];
        setPageIds(picked);

        const list = domainsRes.data;
        setDomains(list);
        // Last choice → first Page's default domain → first domain
        const last = rememberedFormat();
        const firstPage = active.find((p) => p.id === picked[0]);
        const domain = list.find((d) => d.id === last.domainId) ?? list.find((d) => d.id === firstPage?.defaultDomainId) ?? list[0];
        if (domain) {
          setDomainId(domain.id);
          const format = domain.formats.find((f) => f.id === last.formatId) ?? domain.formats.find((f) => f.isDefault) ?? domain.formats[0];
          setFormatId(format?.id ?? '');
        }
      })
      .catch(() => toast.error('Không tải được Page hoặc lĩnh vực.'));
  }, []);

  // Coming from "Viết nhanh với AI" on the dashboard: write right away
  useEffect(() => {
    if (initial.autoGenerate && pageIds.length && idea.trim() && !autoRan.current) {
      autoRan.current = true;
      write();
    }
  }, [pageIds]);

  useEffect(() => {
    try {
      if (pageIds.length) localStorage.setItem(PAGES_KEY, JSON.stringify(pageIds));
    } catch {
      /* private mode: selection just isn't remembered */
    }
  }, [pageIds]);

  useEffect(() => {
    try {
      if (domainId && formatId) localStorage.setItem(FORMAT_KEY, JSON.stringify({ domainId, formatId }));
    } catch {
      /* private mode */
    }
  }, [domainId, formatId]);

  // Keep the Page order of the list, so the preview shows the first one
  const postablePages = pages.filter((p) => p.postable);
  const selectedPages = postablePages.filter((p) => pageIds.includes(p.id));
  const page = selectedPages[0];
  const allSelected = postablePages.length > 0 && selectedPages.length === postablePages.length;
  const blockedCount = pages.length - postablePages.length;
  const togglePage = (id: string) =>
    setPageIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const totalMinutes = Math.max(0, selectedPages.length - 1) * intervalMinutes;
  const message = caption.trim() + (hashtags.length ? `\n\n${hashtags.map((h) => `#${h}`).join(' ')}` : '');
  const domain = domains.find((d) => d.id === domainId);
  const format = domain?.formats.find((f) => f.id === formatId);
  const pickKey = `${domainId}:${formatId}`;
  const pickChanged = !!writtenPick && writtenPick !== pickKey;
  const pickDomain = (id: string) => {
    const next = domains.find((d) => d.id === id);
    setDomainId(id);
    setFormatId(next?.formats.find((f) => f.isDefault)?.id ?? next?.formats[0]?.id ?? '');
  };
  const ownPages = pages.filter((p) => p.defaultDomainId === domainId);
  const otherPages = pages.filter((p) => p.defaultDomainId !== domainId);
  const offDomainSelected = selectedPages.filter((p) => p.defaultDomainId && p.defaultDomainId !== domainId);

  /** Create the post on first use; keep its idea, domain and format in sync afterwards. */
  async function ensurePost(): Promise<string> {
    const pick = domainId && formatId ? { domainId, formatId } : undefined;
    if (postId) {
      const body: PostUpdate = {};
      if (idea.trim() !== savedIdea) body.idea = idea.trim();
      if (pick && (pick.domainId !== savedPick?.domainId || pick.formatId !== savedPick?.formatId)) Object.assign(body, pick);
      if (Object.keys(body).length) {
        await postsApi.update(postId, body);
        setSavedIdea(idea.trim());
        if (pick) setSavedPick(pick);
      }
      return postId;
    }
    const res = await postsApi.create({ pageIds: selectedPages.map((p) => p.id), inputData: { basicInfo: idea.trim() }, ...pick });
    setPostId(res.data.id);
    setSavedIdea(idea.trim());
    setSavedPick({ domainId: res.data.domainId, formatId: res.data.formatId });
    return res.data.id;
  }

  async function write() {
    if (!selectedPages.length) return toast.error('Chọn ít nhất 1 Page để đăng.');
    if (!idea.trim()) return toast.error('Nhập ý tưởng bài viết.');
    setBusy('writing');
    const t0 = performance.now();
    try {
      const id = await ensurePost();
      const res = await postsApi.generate(id);
      const gen = res.data.generated ?? res.data;
      setCaption(gen.caption ?? '');
      setHashtags((gen.hashtags ?? []).map(normalizeTag).filter(Boolean));
      setImagePrompt(gen.imagePrompt ?? '');
      setTimings({ writing: performance.now() - t0 });
      setWrittenPick(pickKey);
    } catch (e: any) {
      toast.error(`AI chưa viết được bài: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function rewrite(instruction: string) {
    if (!postId || !caption.trim()) return;
    setBusy('rewriting');
    try {
      const res = await postsApi.improve(postId, instruction, caption);
      setCaption(res.data.caption);
      toast.info('AI đã viết lại — xem lại trước khi đăng.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function makeImage() {
    if (!postId || !imagePrompt.trim()) return;
    setBusy('image');
    const t0 = performance.now();
    try {
      const res = await postsApi.generateImage(postId, imagePrompt);
      setPreviewImage(assetUrl(res.data.imageUrl));
      setVideo(EMPTY_VIDEO);
      setTimings((t) => ({ ...t, image: performance.now() - t0 }));
    } catch (e: any) {
      toast.error(`Chưa tạo được ảnh: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function uploadImage(file?: File) {
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
    if (file.size > MAX_UPLOAD_BYTES) return toast.error('Ảnh vượt quá 8 MB.');
    if (!selectedPages.length) return toast.error('Chọn ít nhất 1 Page để đăng.');
    setBusy('upload');
    try {
      const id = postId ?? (await ensurePost());
      const res = await postsApi.uploadImage(id, file);
      setPreviewImage(assetUrl(res.data.imageUrl));
      setVideo(EMPTY_VIDEO);
      toast.success('Đã tải ảnh lên — ảnh này sẽ được đăng kèm bài.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** Persist what is on screen, so publishing uses the edited text. */
  async function save(quiet = false): Promise<boolean> {
    if (!postId) return false;
    const body: PostUpdate = { caption, hashtags, imagePrompt };
    if (idea.trim() !== savedIdea) body.idea = idea.trim();
    try {
      await postsApi.update(postId, body);
      setSavedIdea(idea.trim());
      if (!quiet) toast.success('Đã lưu bài vào danh sách "Chờ duyệt".');
      return true;
    } catch (e: any) {
      toast.error(`Lưu thất bại: ${e.message}`);
      return false;
    }
  }

  async function handleSave() {
    setBusy('saving');
    await save();
    setBusy(null);
  }

  async function publish() {
    if (!postId) return;
    if (!selectedPages.length) return toast.error('Chọn ít nhất 1 Page để đăng.');
    if (!confirmPublish) return setConfirmPublish(true);
    setBusy('publishing');
    try {
      if (!(await save(true))) return;
      const res = await postsApi.publish(postId, { pageIds: selectedPages.map((p) => p.id), intervalMinutes });
      toast.success(
        res.data.pages > 1
          ? `Đang đăng lên ${res.data.pages} Page${intervalMinutes ? `, cách nhau ${intervalMinutes} phút` : ''}.`
          : 'Bài đã vào hàng đợi đăng lên Facebook.'
      );
      navigate(`/posts?selected=${postId}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
      setConfirmPublish(false);
    }
  }

  function addTags(raw: string) {
    const tags = raw.split(/[,\s]+/).map(normalizeTag).filter(Boolean);
    if (tags.length) setHashtags((list) => [...new Set([...list, ...tags])].slice(0, 30));
    setTagDraft('');
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTags(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && hashtags.length) {
      setHashtags((list) => list.slice(0, -1));
    }
  }

  const hasContent = !!caption.trim();
  const secs = (ms?: number) => (ms ? `${(ms / 1000).toFixed(1).replace('.', ',')}s` : '');
  const steps = [
    { title: 'Ý tưởng', detail: idea.trim() ? 'Đã nhập' : 'Nhập ở giữa màn hình', state: postId ? 'done' : 'current' },
    {
      title: 'AI viết nội dung',
      detail: busy === 'writing' ? 'Đang viết…' : hasContent ? `Gemini${timings.writing ? ` · ${secs(timings.writing)}` : ''}` : 'Chưa chạy',
      state: hasContent ? 'done' : postId || busy === 'writing' ? 'current' : 'todo',
    },
    {
      title: 'Ảnh minh hoạ',
      detail: busy === 'image' ? 'Đang tạo…' : busy === 'upload' ? 'Đang tải lên…' : previewImage ? `Đã lưu, sẽ đăng kèm${timings.image ? ` · ${secs(timings.image)}` : ''}` : hasContent ? 'Tạo bằng AI hoặc tải lên' : 'Chưa chạy',
      state: previewImage ? 'done' : hasContent ? 'current' : 'todo',
    },
    { title: 'Duyệt & đăng', detail: hasContent ? 'Sẵn sàng khi bạn duyệt' : 'Chưa chạy', state: hasContent ? 'current' : 'todo' },
  ];

  return (
    <div className="compose-grid">
      {/* ─── Progress ─── */}
      <aside className="compose-side compose-progress" aria-label="Tiến trình tạo bài">
        <section className="card stack" style={{ gap: 14 }}>
          <h2 className="card-title">Tiến trình</h2>
          <ol className="timeline">
            {steps.map((s) => (
              <li key={s.title}>
                <span className={`tl-mark ${s.state}`}>{s.state === 'done' && <Check size={12} strokeWidth={3} aria-hidden="true" />}</span>
                <span className="tl-body">
                  <strong style={s.state === 'current' ? { color: 'var(--primary-600)' } : undefined}>{s.title}</strong>
                  <span>{s.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="card" aria-labelledby="page-picker-label">
          <div className="picker-head">
            <span id="page-picker-label" className="form-label" style={{ margin: 0 }}>
              Đăng lên {selectedPages.length}/{postablePages.length} Page
            </span>
            {postablePages.length > 1 && (
              <button type="button" className="link-btn" onClick={() => setPageIds(allSelected ? [] : postablePages.map((p) => p.id))}>
                {allSelected ? 'Bỏ chọn' : 'Tất cả'}
              </button>
            )}
          </div>
          {pages.length === 0 ? (
            <p className="field-warning">Kết nối Page trong <a href="/settings">Cài đặt</a> trước.</p>
          ) : (
            <>
              {[
                { title: 'Page của lĩnh vực này', list: ownPages },
                { title: 'Page khác', list: otherPages },
              ]
                .filter((g) => g.list.length > 0)
                .map((g, _i, groups) => (
                  <div key={g.title} className="page-group">
                    {groups.length > 1 && <span className="page-group-title">{g.title}</span>}
                    <div className="page-picker" role="group" aria-label={g.title}>
                      {g.list.map((p) => (
                        <label key={p.id} className={`page-option ${p.postable ? '' : 'disabled'}`} title={p.blockMessage ?? p.pageName}>
                          <input
                            type="checkbox"
                            id={`page-${p.id}`}
                            checked={p.postable && pageIds.includes(p.id)}
                            onChange={() => togglePage(p.id)}
                            disabled={!p.postable}
                          />
                          <span className="avatar" aria-hidden="true">{pageInitials(p.pageName)}</span>
                          <span className="name">
                            {p.pageName}
                            {!p.postable && <span className="why">{p.blockReason === 'OTHER_APP' ? 'Token của app cũ' : p.blockMessage}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              {offDomainSelected.length > 0 && (
                <p className="field-warning">
                  <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: -2 }} />{' '}
                  {offDomainSelected.map((p) => p.pageName).join(', ')} mặc định dùng lĩnh vực khác — bài vẫn viết theo lĩnh vực đã chọn.
                </p>
              )}
              {blockedCount > 0 ? (
                <p className="field-warning">
                  {blockedCount} Page chưa đăng được. <Link to="/pages?sync=1">Đồng bộ Page</Link> để cấp lại token.
                </p>
              ) : (
                <p className="field-hint">Cùng một nội dung và ảnh được đăng lên mọi Page đã chọn. Có thể đổi đến lúc bấm đăng.</p>
              )}
            </>
          )}
        </section>
      </aside>

      {/* ─── Editor ─── */}
      <div className="stack" style={{ minWidth: 0 }}>
        <section className="card stack" style={{ gap: 12 }}>
          {domains.length > 0 && (
            <div className="pick-row">
              <label className="form-label" htmlFor="domain">Lĩnh vực</label>
              <select id="domain" className="form-select" value={domainId} onChange={(e) => pickDomain(e.target.value)}>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <span className="form-label" id="format-label">Định dạng</span>
              <div className="format-chips" role="radiogroup" aria-labelledby="format-label">
                {domain?.formats.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={f.id === formatId}
                    className={`chip-btn ${f.id === formatId ? 'active' : ''}`}
                    onClick={() => setFormatId(f.id)}
                    title={f.withImage ? 'Có ảnh' : 'Chỉ chữ'}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label htmlFor="idea" className="form-label">Ý tưởng bài viết</label>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <input
                id="idea"
                className="form-input"
                value={idea}
                maxLength={500}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && write()}
                placeholder="VD: Tóm tắt biên bản cuộc họp dài thành danh sách việc cần làm"
              />
              <button type="button" className="btn btn-dark" onClick={write} disabled={!!busy || videoBusy || !idea.trim() || !selectedPages.length}>
                {busy === 'writing' ? <div className="spinner" /> : hasContent ? <RefreshCw size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
                {hasContent ? 'Viết lại' : 'Viết bài bằng AI'}
              </button>
            </div>
          </div>
          {pickChanged && hasContent && (
            <p className="field-warning" role="status">
              Bạn vừa đổi lĩnh vực/định dạng — bấm <strong>Viết lại</strong> để AI viết theo lựa chọn mới.
            </p>
          )}
          <p className="field-hint" style={{ margin: 0 }}>
            AI viết theo lĩnh vực <strong>{domain?.name ?? '…'}</strong> · định dạng <strong>{format?.name ?? '…'}</strong>
            {format && !format.withImage ? ' (chỉ chữ, không tạo ảnh)' : ''}, rồi tự tách đoạn và đưa hashtag xuống cuối.{' '}
            <button type="button" className="link-btn" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}>
              {showPrompt ? 'Ẩn prompt' : 'Xem prompt'}
            </button>
          </p>
          {showPrompt && format && domain && (
            <PromptPreview key={`${formatId}:${idea}`} formats={domain.formats} formatId={formatId} idea={idea || 'ý tưởng của bạn'} pageId={page?.id} compact />
          )}
        </section>

        <section className="card stack" style={{ gap: 12 }}>
          <div className="label-row">
            <label htmlFor="post-body" className="form-label" style={{ margin: 0 }}>Nội dung bài</label>
            <span className="char-count">{wordCount(caption)} từ · {caption.length.toLocaleString('vi-VN')} ký tự</span>
          </div>
          <textarea
            id="post-body"
            className="form-textarea"
            rows={16}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            disabled={busy === 'writing' || busy === 'rewriting'}
            placeholder={busy === 'writing' ? 'AI đang viết…' : 'Nội dung sẽ hiện ở đây sau khi AI viết — bạn có thể sửa trực tiếp.'}
          />
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Viết lại nhanh:</span>
            {QUICK_REWRITES.map((q) => (
              <button key={q.label} type="button" className="chip-btn" disabled={!!busy || videoBusy || !hasContent} onClick={() => rewrite(q.instruction)}>
                {q.label}
              </button>
            ))}
            {busy === 'rewriting' && <span className="spinner spinner-xs" aria-label="Đang viết lại" />}
          </div>
          <div className="settings-divider" style={{ margin: '4px 0' }} />
          <div>
            <div className="label-row">
              <span className="form-label">Hashtag</span>
              <span className="char-count">{hashtags.length}</span>
            </div>
            <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
              {hashtags.map((t) => (
                <span key={t} className="tag-chip">
                  #{t}
                  <button type="button" onClick={() => setHashtags((list) => list.filter((x) => x !== t))} aria-label={`Xoá #${t}`}>
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input
                value={tagDraft}
                aria-label="Thêm hashtag"
                placeholder={hashtags.length ? '' : 'Gõ rồi Enter để thêm hashtag'}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={onTagKey}
                onBlur={() => addTags(tagDraft)}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            {previewImage ? (
              <img src={previewImage} alt="Ảnh sẽ đăng kèm bài" style={{ width: 96, height: 96, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <span className="post-thumb" style={{ width: 96, height: 96 }} aria-hidden="true"><ImageIcon size={24} strokeWidth={1.6} /></span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="image-prompt" className="form-label">Ảnh minh hoạ · image prompt (tiếng Anh)</label>
              <textarea
                id="image-prompt"
                className="form-textarea"
                rows={3}
                style={{ minHeight: 72 }}
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                placeholder="AI sẽ đề xuất prompt ảnh khi viết bài"
              />
            </div>
            <div className="stack" style={{ gap: 8, marginTop: 26 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={makeImage} disabled={!!busy || videoBusy || !postId || !imagePrompt.trim() || !!video.videoUrl}>
                {busy === 'image' ? <div className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />}
                {previewImage ? 'Tạo lại bằng AI' : 'Tạo ảnh bằng AI'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={!!busy || videoBusy || !selectedPages.length || !!video.videoUrl}>
                {busy === 'upload' ? <div className="spinner" /> : <Upload size={14} aria-hidden="true" />}
                Tải ảnh lên
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => uploadImage(e.target.files?.[0])} />
            </div>
          </div>
          <div className="settings-divider" style={{ margin: '14px 0 10px' }} />
          <span className="form-label">Hoặc đăng video</span>
          <VideoField
            postId={postId}
            ensurePost={ensurePost}
            value={video}
            onChange={(v) => {
              setVideo(v);
              if (v.videoUrl) setPreviewImage(null); // the server removed the image
            }}
            disabled={!!busy || !selectedPages.length}
            onBusyChange={setVideoBusy}
          />
        </section>
      </div>

      {/* ─── Preview & publish ─── */}
      <aside className="compose-side" aria-label="Xem trước và đăng">
        <article className="fb-card">
          <div className="fb-head">
            <span className="avatar">{pageInitials(page?.pageName)}</span>
            <div>
              <div className="fb-page">{page?.pageName ?? 'Facebook Page'}</div>
              <div className="fb-time">
                Xem trước trên Facebook{selectedPages.length > 1 ? ` · và ${selectedPages.length - 1} Page khác` : ''}
              </div>
            </div>
          </div>
          <div className="fb-body clamped">
            {message ? (
              <>
                <mark className="fb-hook">{message.slice(0, HOOK_LENGTH)}</mark>
                {message.slice(HOOK_LENGTH)}
              </>
            ) : (
              <span style={{ color: '#8a8d91', fontStyle: 'italic' }}>Nội dung bài sẽ hiện ở đây…</span>
            )}
          </div>
          {video.videoUrl ? (
            <video className="fb-image fb-video" src={assetUrl(video.videoUrl)!} controls muted preload="metadata" />
          ) : previewImage ? (
            <img className="fb-image" src={previewImage} alt="" />
          ) : (
            <div className="fb-image placeholder">{imagePrompt ? 'Ảnh sẽ được AI tạo khi đăng' : 'Ảnh AI sẽ hiện ở đây'}</div>
          )}
        </article>
        <p className="field-hint" style={{ margin: 0 }}>
          Phần tô vàng là hook — người xem thấy trên điện thoại trước khi bấm "Xem thêm".
          {previewImage ? ' Ảnh đang hiện là ảnh sẽ được đăng kèm.' : imagePrompt ? ' Chưa có ảnh: khi đăng, AI sẽ tạo ảnh từ image prompt.' : ''}
        </p>

        <div className="stack" style={{ gap: 8 }}>
          {selectedPages.length > 1 && (
            <div className="stack" style={{ gap: 4 }}>
              <div className="interval-row">
                <label htmlFor="interval">Giãn cách giữa các Page</label>
                <select id="interval" className="form-select" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
                  {INTERVAL_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m === 0 ? 'Đăng cùng lúc' : `${m} phút`}</option>
                  ))}
                </select>
              </div>
              <span className="field-hint" style={{ margin: 0 }}>
                {intervalMinutes === 0
                  ? 'Cùng nội dung lên nhiều Page một lúc dễ bị Facebook coi là spam.'
                  : `${selectedPages.length} Page, xong sau khoảng ${formatDuration(totalMinutes)}.`}
              </span>
            </div>
          )}
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={publish} disabled={!!busy || videoBusy || !hasContent || !selectedPages.length}>
            {busy === 'publishing' ? <div className="spinner" /> : <Send size={16} aria-hidden="true" />}
            {confirmPublish
              ? 'Bấm lần nữa để đăng công khai'
              : selectedPages.length > 1
                ? `Duyệt & đăng lên ${selectedPages.length} Page`
                : video.videoKind === 'REEL'
                  ? 'Duyệt & đăng Reels'
                  : 'Duyệt & đăng ngay'}
          </button>
          <button type="button" className="btn btn-secondary btn-block" onClick={handleSave} disabled={!!busy || videoBusy || !postId}>
            {busy === 'saving' ? <div className="spinner" /> : null}
            Lưu, duyệt sau
          </button>
        </div>
      </aside>
    </div>
  );
}
