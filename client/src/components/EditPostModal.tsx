import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X, Save, Wand2, Hash, Lock, RefreshCw, Upload, Trash2, ImageIcon } from 'lucide-react';
import { postsApi, assetUrl, MAX_UPLOAD_BYTES, UPLOAD_TYPES, type PostUpdate } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string;
  onClose: () => void;
  onSaved: (post: any) => void;
}

interface FormState {
  caption: string;
  hashtags: string[];
  callToAction: string;
  imagePrompt: string;
}

const EDITABLE = ['DRAFT', 'READY', 'FAILED', 'SCHEDULED'];
/** Roughly what Facebook shows on mobile before "Xem thêm" */
const HOOK_LENGTH = 125;
const CAPTION_MAX = 5000;

const QUICK_REWRITES = [
  { label: 'Hook mạnh hơn', instruction: 'Viết lại câu mở đầu thật gây tò mò, giữ nguyên ý chính' },
  { label: 'Ngắn gọn hơn', instruction: 'Rút gọn còn khoảng một nửa, giữ ý quan trọng nhất' },
  { label: 'Thân thiện hơn', instruction: 'Đổi sang giọng thân thiện, gần gũi như nói chuyện với bạn bè' },
  { label: 'Chia đoạn dễ đọc', instruction: 'Chia thành các đoạn 1-2 câu, dễ đọc trên điện thoại, thêm emoji hợp lý' },
];

const normalizeTag = (t: string) => t.trim().replace(/^#+/, '').replace(/\s+/g, '');

function toForm(post: any): FormState {
  return {
    caption: post.caption ?? '',
    hashtags: Array.isArray(post.hashtags) ? post.hashtags.map(normalizeTag).filter(Boolean) : [],
    callToAction: post.callToAction ?? '',
    imagePrompt: post.imagePrompt ?? '',
  };
}

/** Same composition the publish worker uses */
function composeMessage(f: FormState): string {
  let msg = f.caption;
  if (f.hashtags.length) msg += `\n\n${f.hashtags.map((h) => `#${h}`).join(' ')}`;
  if (f.callToAction.trim()) msg += `\n\n👉 ${f.callToAction.trim()}`;
  return msg;
}

export default function EditPostModal({ postId, onClose, onSaved }: Props) {
  const toast = useToast();
  const [post, setPost] = useState<any>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState<null | 'generate' | 'upload' | 'remove'>(null);

  useEffect(() => {
    postsApi
      .get(postId)
      .then((r) => {
        setPost(r.data);
        setForm(toForm(r.data));
        setInitial(toForm(r.data));
      })
      .catch((e) => {
        toast.error(`Không tải được bài đăng: ${e.message}`);
        onClose();
      });
  }, [postId]);

  const editable = post && EDITABLE.includes(post.status);
  const dirty = useMemo(() => !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const changes = (): PostUpdate => {
    if (!form || !initial) return {};
    const out: PostUpdate = {};
    if (form.caption !== initial.caption) out.caption = form.caption;
    if (JSON.stringify(form.hashtags) !== JSON.stringify(initial.hashtags)) out.hashtags = form.hashtags;
    if (form.callToAction !== initial.callToAction) out.callToAction = form.callToAction;
    if (form.imagePrompt !== initial.imagePrompt) out.imagePrompt = form.imagePrompt;
    return out;
  };

  async function save() {
    if (!dirty || saving || !editable) return;
    if (!form!.caption.trim()) {
      toast.error('Caption không được để trống.');
      return;
    }
    setSaving(true);
    try {
      const res = await postsApi.update(postId, changes());
      toast.success(res.data.status === 'READY' && post.status !== 'READY' ? 'Đã lưu — bài chuyển sang "Chờ duyệt".' : 'Đã lưu thay đổi.');
      onSaved(res.data);
      onClose();
    } catch (e: any) {
      toast.error(`Lưu thất bại: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  // Esc = close (asks once if dirty), Ctrl/Cmd+S = save
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => setConfirmDiscard(false), [form]);

  async function rewrite(label: string, instruction: string) {
    if (!form?.caption.trim()) return;
    setRewriting(label);
    try {
      const res = await postsApi.improve(postId, instruction, form.caption);
      setForm((f) => ({ ...f!, caption: res.data.caption }));
      toast.info('AI đã viết lại — xem lại rồi bấm Lưu để giữ.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRewriting(null);
    }
  }

  /** Image changes are saved on the server right away; reflect them here and in the list. */
  function applyImage(imageUrl: string | null, imagePrompt?: string) {
    const next = { ...post, imageUrl, ...(imagePrompt !== undefined && { imagePrompt }) };
    setPost(next);
    if (imagePrompt !== undefined) {
      setForm((f) => ({ ...f!, imagePrompt }));
      setInitial((i) => ({ ...i!, imagePrompt }));
    }
    onSaved(next);
  }

  async function generateImage() {
    if (!form?.imagePrompt.trim()) return toast.error('Nhập image prompt trước.');
    setImageBusy('generate');
    try {
      const res = await postsApi.generateImage(postId, form.imagePrompt);
      applyImage(res.data.imageUrl, res.data.imagePrompt);
      toast.success('Đã tạo ảnh mới — ảnh này sẽ được đăng kèm bài.');
    } catch (e: any) {
      toast.error(`Chưa tạo được ảnh: ${e.message}`);
    } finally {
      setImageBusy(null);
    }
  }

  async function uploadImage(file?: File) {
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
    if (file.size > MAX_UPLOAD_BYTES) return toast.error('Ảnh vượt quá 8 MB.');
    setImageBusy('upload');
    try {
      const res = await postsApi.uploadImage(postId, file);
      applyImage(res.data.imageUrl);
      toast.success('Đã thay bằng ảnh tải lên.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImageBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeImage() {
    setImageBusy('remove');
    try {
      await postsApi.removeImage(postId);
      applyImage(null);
      toast.info('Đã gỡ ảnh khỏi bài.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImageBusy(null);
    }
  }

  function addTags(raw: string) {
    const tags = raw.split(/[,\s]+/).map(normalizeTag).filter(Boolean);
    if (!tags.length) return;
    setForm((f) => ({ ...f!, hashtags: [...new Set([...f!.hashtags, ...tags])].slice(0, 30) }));
    setTagDraft('');
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTags(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && form!.hashtags.length) {
      setForm((f) => ({ ...f!, hashtags: f!.hashtags.slice(0, -1) }));
    }
  }

  if (!form || !post) {
    return (
      <div className="modal-overlay">
        <div className="spinner spinner-lg" />
      </div>
    );
  }

  const hook = form.caption.slice(0, HOOK_LENGTH);
  const rest = form.caption.slice(HOOK_LENGTH);
  const message = composeMessage(form);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal-panel edit-post-modal" role="dialog" aria-modal="true" aria-labelledby="edit-post-title">
        <header className="modal-head">
          <div>
            <h2 id="edit-post-title">Chỉnh sửa bài đăng</h2>
            <p className="field-hint" style={{ margin: 0 }}>
              {post.page?.pageName} · tạo {new Date(post.createdAt).toLocaleString('vi-VN')}
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={requestClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        {!editable && (
          <div className="edit-locked">
            <Lock size={14} />
            {post.status === 'PUBLISHED'
              ? 'Bài đã đăng lên Facebook — chỉ xem, không sửa tại đây.'
              : 'Bài đang được xử lý — tạm thời chưa sửa được.'}
          </div>
        )}
        {post.status === 'FAILED' && post.errorMessage && (
          <div className="edit-error">⚠ Lần đăng trước lỗi: {post.errorMessage}</div>
        )}

        <div className="edit-grid">
          {/* ─── Editor ─── */}
          <div className="edit-form">
            <div className="form-group">
              <div className="label-row">
                <label className="form-label" htmlFor="edit-caption">Caption</label>
                <span className={`char-count ${form.caption.length > CAPTION_MAX ? 'over' : ''}`}>
                  {form.caption.length.toLocaleString('vi-VN')} / {CAPTION_MAX.toLocaleString('vi-VN')}
                </span>
              </div>
              <textarea id="edit-caption" ref={captionRef} className="form-textarea" rows={10}
                value={form.caption} disabled={!editable || !!rewriting}
                onChange={(e) => setForm({ ...form, caption: e.target.value })} />
              {editable && (
                <div className="quick-rewrites">
                  <Wand2 size={13} />
                  {QUICK_REWRITES.map((q) => (
                    <button key={q.label} className="chip-btn" disabled={!!rewriting || !form.caption.trim()}
                      onClick={() => rewrite(q.label, q.instruction)}>
                      {rewriting === q.label ? <span className="spinner spinner-xs" /> : null}
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group">
              <div className="label-row">
                <label className="form-label">Hashtags</label>
                <span className="char-count">{form.hashtags.length} / 30</span>
              </div>
              <div className={`tag-input ${!editable ? 'disabled' : ''}`} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
                {form.hashtags.map((t) => (
                  <span key={t} className="tag-chip">
                    #{t}
                    {editable && (
                      <button onClick={() => setForm({ ...form, hashtags: form.hashtags.filter((x) => x !== t) })} aria-label={`Xoá #${t}`}>
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
                {editable && (
                  <input value={tagDraft} placeholder={form.hashtags.length ? '' : 'Gõ rồi Enter, hoặc dán nhiều hashtag…'}
                    onChange={(e) => setTagDraft(e.target.value)} onKeyDown={onTagKey}
                    onBlur={() => addTags(tagDraft)}
                    onPaste={(e) => { e.preventDefault(); addTags(e.clipboardData.getData('text')); }} />
                )}
              </div>
              {form.hashtags.length > 10 && (
                <p className="field-hint"><Hash size={11} /> Trên Facebook, 3–5 hashtag thường hiệu quả hơn một dãy dài.</p>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="edit-cta">Call to action</label>
              <input id="edit-cta" className="form-input" value={form.callToAction} disabled={!editable}
                placeholder="VD: Bạn đang giao việc gì cho AI? Kể mình nghe dưới bình luận 👇"
                onChange={(e) => setForm({ ...form, callToAction: e.target.value })} />
            </div>

            <div className="form-group">
              <span className="form-label">Ảnh đăng kèm</span>
              <div className="image-editor">
                {post.imageUrl ? (
                  <img className="image-editor-thumb" src={assetUrl(post.imageUrl)!} alt="Ảnh hiện tại của bài" />
                ) : (
                  <span className="image-editor-thumb empty" aria-hidden="true"><ImageIcon size={22} strokeWidth={1.6} /></span>
                )}
                <div className="image-editor-body">
                  <label className="form-label" htmlFor="edit-image-prompt" style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>
                    Image prompt (tiếng Anh) — dùng khi tạo bằng AI
                  </label>
                  <textarea id="edit-image-prompt" className="form-textarea" rows={3} style={{ minHeight: 72 }} value={form.imagePrompt} disabled={!editable}
                    onChange={(e) => setForm({ ...form, imagePrompt: e.target.value })} />
                  {editable && (
                    <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={generateImage} disabled={!!imageBusy || !form.imagePrompt.trim()}>
                        {imageBusy === 'generate' ? <span className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />}
                        {post.imageUrl ? 'Tạo lại bằng AI' : 'Tạo bằng AI'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={!!imageBusy}>
                        {imageBusy === 'upload' ? <span className="spinner" /> : <Upload size={14} aria-hidden="true" />}
                        Tải ảnh từ máy
                      </button>
                      {post.imageUrl && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={removeImage} disabled={!!imageBusy}>
                          {imageBusy === 'remove' ? <span className="spinner" /> : <Trash2 size={14} aria-hidden="true" />}
                          Gỡ ảnh
                        </button>
                      )}
                      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                        onChange={(e) => uploadImage(e.target.files?.[0])} />
                    </div>
                  )}
                  <p className="field-hint">
                    JPG, PNG hoặc WebP, tối đa 8 MB. Đổi ảnh được áp dụng ngay, không cần bấm Lưu.
                    {!post.imageUrl && form.imagePrompt.trim() && ' Nếu không có ảnh, AI sẽ tạo ảnh từ prompt khi đăng.'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ─── Live preview ─── */}
          <aside className="edit-preview">
            <div className="preview-label">Xem trước trên Facebook</div>
            <div className="fb-card">
              <div className="fb-head">
                <div className="avatar">{post.page?.pageName?.[0] ?? 'P'}</div>
                <div>
                  <div className="fb-page">{post.page?.pageName}</div>
                  <div className="fb-time">Bản xem trước · Công khai</div>
                </div>
              </div>
              <div className="fb-body">
                <mark className="fb-hook" title="Phần hiển thị trước “Xem thêm” trên điện thoại">{hook}</mark>
                {rest && <span>{rest}</span>}
                {message.slice(form.caption.length)}
              </div>
              {post.imageUrl ? (
                <img className="fb-image" src={assetUrl(post.imageUrl)!} alt="" />
              ) : (
                <div className="fb-image placeholder">{form.imagePrompt.trim() ? 'Ảnh sẽ được AI tạo khi đăng' : 'Bài không có ảnh'}</div>
              )}
            </div>
            <p className="field-hint">
              Phần tô sáng ≈ {HOOK_LENGTH} ký tự đầu — người xem thấy trước khi bấm “Xem thêm”. Hãy đặt điều hấp dẫn nhất ở đây.
            </p>
          </aside>
        </div>

        <footer className="modal-foot">
          {confirmDiscard ? (
            <span className="discard-hint">Có thay đổi chưa lưu — nhấn Đóng/Esc lần nữa để bỏ.</span>
          ) : (
            <span className="field-hint">Ctrl + S để lưu · Esc để đóng</span>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={requestClose}>{dirty ? 'Huỷ' : 'Đóng'}</button>
            {editable && (
              <button className="btn btn-primary" onClick={save} disabled={!dirty || saving || !!rewriting}>
                {saving ? <div className="spinner" /> : <><Save size={16} /> Lưu thay đổi</>}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
