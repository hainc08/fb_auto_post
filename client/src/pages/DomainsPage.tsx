import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, Star, Archive, ArchiveRestore, Trash2, ImageIcon, Type, X } from 'lucide-react';
import { domainsApi, ApiError, LENGTH_LABEL, type ContentDomain, type ContentFormat } from '../api';
import { useToast } from '../components/Toast';
import FormatDrawer from '../components/FormatDrawer';
import PromptPreview from '../components/PromptPreview';
import { cleanTagInput } from '../components/PostBits';

export const DOMAINS_SEEN_KEY = 'autopost.domainsSeen';

interface Draft {
  name: string;
  description: string;
  audience: string;
  voice: string;
  rules: string;
  imageStyle: string;
  defaultHashtags: string[];
}

const EMPTY: Draft = { name: '', description: '', audience: '', voice: '', rules: '', imageStyle: '', defaultHashtags: [] };
const NEW_FORMAT = {
  name: 'Bài chuẩn',
  instructions: 'Mở bằng 1 câu gây chú ý, 3–4 đoạn ngắn dễ đọc trên điện thoại, kết bằng lời mời bình luận.',
};

const toDraft = (d: ContentDomain): Draft => ({
  name: d.name,
  description: d.description ?? '',
  audience: d.audience ?? '',
  voice: d.voice ?? '',
  rules: d.rules ?? '',
  imageStyle: d.imageStyle ?? '',
  defaultHashtags: d.defaultHashtags ?? [],
});

/** Content domains: how AI writes (spec §6 "/domains"). */
export default function DomainsPage() {
  const toast = useToast();
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ format?: ContentFormat } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  async function load(keep?: string) {
    try {
      const list = (await domainsApi.list(true)).data;
      setDomains(list);
      const next = keep && list.some((d) => d.id === keep) ? keep : list.find((d) => !d.isArchived)?.id ?? null;
      setSelectedId((cur) => (cur === 'new' && !keep ? cur : next));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không tải được lĩnh vực.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    try {
      localStorage.setItem(DOMAINS_SEEN_KEY, '1');
    } catch {
      /* private mode: the dashboard checklist just won't tick */
    }
  }, []);

  const selected = domains.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    setDraft(selected ? toDraft(selected) : EMPTY);
    setTagDraft('');
  }, [selectedId, selected?.id]);

  const active = useMemo(() => domains.filter((d) => !d.isArchived), [domains]);
  const archived = useMemo(() => domains.filter((d) => d.isArchived), [domains]);
  const set = (key: Exclude<keyof Draft, 'defaultHashtags'>) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  function addTags(raw: string) {
    const tags = raw.split(/[,\s]+/).map(cleanTagInput).filter(Boolean);
    if (tags.length) setDraft((d) => ({ ...d, defaultHashtags: [...new Set([...d.defaultHashtags, ...tags])].slice(0, 10) }));
    setTagDraft('');
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTags(tagDraft);
    }
  }

  async function run(key: string, fn: () => Promise<unknown>, done: string, keep?: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load(keep);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không lưu được.');
    } finally {
      setBusy(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: draft.name,
      description: draft.description,
      audience: draft.audience,
      voice: draft.voice,
      rules: draft.rules,
      imageStyle: draft.imageStyle,
      defaultHashtags: draft.defaultHashtags,
    };
    if (selectedId === 'new') {
      setBusy('save');
      try {
        const created = (await domainsApi.create({ ...body, format: NEW_FORMAT })).data;
        toast.success(`Đã tạo lĩnh vực "${created.name}" kèm định dạng "Bài chuẩn".`);
        await load(created.id);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Không tạo được.');
      } finally {
        setBusy(null);
      }
      return;
    }
    if (selected) await run('save', () => domainsApi.update(selected.id, body), 'Đã lưu lĩnh vực.', selected.id);
  }

  if (loading) {
    return (
      <div className="loading-page">
        <div className="spinner spinner-lg" />
      </div>
    );
  }

  const count = (d: ContentDomain) =>
    `${d.formats.filter((f) => !f.isArchived).length} định dạng · ${d._count?.pages ?? 0} Page · ${d._count?.posts ?? 0} bài`;

  return (
    <div className="stack domains-page">
      <div className="page-header">
        <h1>Lĩnh vực nội dung</h1>
        <p>Mỗi lĩnh vực là một cách viết (đối tượng, giọng văn, quy tắc, ảnh) với nhiều định dạng bài. Khi tạo bài bạn chọn lĩnh vực + định dạng.</p>
      </div>

      <div className="domains-grid">
        <aside className="card flush domain-list" aria-label="Danh sách lĩnh vực">
          {active.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`domain-item ${d.id === selectedId ? 'selected' : ''}`}
              aria-current={d.id === selectedId}
              onClick={() => setSelectedId(d.id)}
            >
              <span className="name">{d.name}</span>
              <span className="muted">{count(d)}</span>
            </button>
          ))}
          <button type="button" className="domain-item add" onClick={() => setSelectedId('new')} disabled={domains.length >= 20}>
            <Plus size={15} aria-hidden="true" /> Lĩnh vực mới
          </button>
          {archived.length > 0 && (
            <>
              <button type="button" className="link-btn domain-archived-toggle" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? 'Ẩn' : 'Xem'} {archived.length} lĩnh vực đã lưu trữ
              </button>
              {showArchived &&
                archived.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`domain-item archived ${d.id === selectedId ? 'selected' : ''}`}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <span className="name">{d.name}</span>
                    <span className="muted">Đã lưu trữ · {count(d)}</span>
                  </button>
                ))}
            </>
          )}
        </aside>

        {selectedId && (
          <div className="stack" style={{ minWidth: 0 }}>
            <form className="card stack domain-form" onSubmit={save} key={selectedId}>
              <div className="row domain-form-head">
                <h2 className="card-title">{selectedId === 'new' ? 'Lĩnh vực mới' : draft.name || 'Lĩnh vực'}</h2>
                {selected?.isArchived && <span className="badge badge-draft">Đã lưu trữ</span>}
              </div>

              <fieldset className="domain-block">
                <legend>Thông tin</legend>
                <label className="form-label" htmlFor="d-name">Tên lĩnh vực</label>
                <input
                  id="d-name"
                  className="form-input"
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => set('name')(e.target.value)}
                  placeholder="VD: Tiếng Nhật cho người đi làm"
                />
                <label className="form-label" htmlFor="d-desc">Mô tả ngắn</label>
                <input id="d-desc" className="form-input" maxLength={300} value={draft.description} onChange={(e) => set('description')(e.target.value)} />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Đối tượng & giọng văn</legend>
                <label className="form-label" htmlFor="d-aud">Đối tượng độc giả</label>
                <textarea
                  id="d-aud"
                  className="form-textarea"
                  rows={2}
                  maxLength={1000}
                  value={draft.audience}
                  onChange={(e) => set('audience')(e.target.value)}
                  placeholder="Ai đọc bài? Tuổi, nghề, họ quan tâm gì."
                />
                <label className="form-label" htmlFor="d-voice">Giọng văn</label>
                <textarea
                  id="d-voice"
                  className="form-textarea"
                  rows={2}
                  maxLength={1000}
                  value={draft.voice}
                  onChange={(e) => set('voice')(e.target.value)}
                  placeholder="VD: Thân thiện, dí dỏm, xưng mình – bạn."
                />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Quy tắc</legend>
                <textarea
                  id="d-rules"
                  aria-label="Quy tắc bắt buộc"
                  className="form-textarea"
                  rows={3}
                  maxLength={2000}
                  value={draft.rules}
                  onChange={(e) => set('rules')(e.target.value)}
                  placeholder="Điều AI luôn/không bao giờ làm. VD: không hứa hẹn cam kết đầu ra."
                />
              </fieldset>

              <fieldset className="domain-block">
                <legend>Hashtag mặc định</legend>
                <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
                  {draft.defaultHashtags.map((t) => (
                    <span key={t} className="tag-chip">
                      #{t}
                      <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, defaultHashtags: d.defaultHashtags.filter((x) => x !== t) }))}
                        aria-label={`Xoá #${t}`}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    aria-label="Thêm hashtag mặc định"
                    placeholder={draft.defaultHashtags.length ? '' : 'Gõ rồi Enter · tối đa 10, được thêm vào mọi bài'}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={onTagKey}
                    onBlur={() => addTags(tagDraft)}
                  />
                </div>
              </fieldset>

              <fieldset className="domain-block">
                <legend>Phong cách ảnh</legend>
                <input
                  id="d-style"
                  aria-label="Phong cách ảnh (tiếng Anh)"
                  className="form-input"
                  maxLength={500}
                  value={draft.imageStyle}
                  onChange={(e) => set('imageStyle')(e.target.value)}
                  placeholder="Tiếng Anh, VD: flat illustration, pastel colors, soft light"
                />
              </fieldset>

              <div className="row domain-actions">
                {selected && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          'archive',
                          () => domainsApi.update(selected.id, { isArchived: !selected.isArchived }),
                          selected.isArchived ? 'Đã dùng lại lĩnh vực.' : 'Đã lưu trữ — các Page dùng lĩnh vực này làm mặc định được bỏ chọn.',
                          selected.id
                        )
                      }
                    >
                      {selected.isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                      {selected.isArchived ? 'Dùng lại' : 'Lưu trữ'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm danger-hover"
                      disabled={!!busy}
                      aria-label="Xoá lĩnh vực"
                      onClick={() => run('delete', () => domainsApi.remove(selected.id), `Đã xoá "${selected.name}".`)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </>
                )}
                <button type="submit" className="btn btn-primary" disabled={!!busy} style={{ marginLeft: 'auto' }}>
                  {busy === 'save' && <div className="spinner" />} {selectedId === 'new' ? 'Tạo lĩnh vực' : 'Lưu lĩnh vực'}
                </button>
              </div>
            </form>

            {selected && (
              <section className="card stack" aria-labelledby="formats-title">
                <div className="row">
                  <h2 id="formats-title" className="card-title" style={{ flex: 1 }}>Định dạng bài</h2>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer({})} disabled={selected.formats.length >= 10}>
                    <Plus size={14} aria-hidden="true" /> Định dạng
                  </button>
                </div>
                <div className="format-grid">
                  {selected.formats.map((f) => (
                    <article key={f.id} className={`format-card ${f.isArchived ? 'archived' : ''}`}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <strong className="format-name">{f.name}</strong>
                        {f.isDefault && (
                          <span className="badge badge-published">
                            <Star size={11} aria-hidden="true" /> Mặc định
                          </span>
                        )}
                        {f.legacyPrompt && <span className="badge badge-draft">Prompt cũ</span>}
                        {f.isArchived && <span className="badge badge-draft">Lưu trữ</span>}
                      </div>
                      <p className="format-meta">
                        {LENGTH_LABEL[f.length]} ·{' '}
                        {f.withImage ? (
                          <>
                            <ImageIcon size={12} aria-hidden="true" /> Có ảnh
                          </>
                        ) : (
                          <>
                            <Type size={12} aria-hidden="true" /> Chỉ chữ
                          </>
                        )}{' '}
                        · {f._count?.posts ?? 0} bài
                      </p>
                      <p className="format-ins">{f.instructions}</p>
                      <div className="row" style={{ gap: 6 }}>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer({ format: f })}>Sửa</button>
                        {!f.isDefault && !f.isArchived && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={!!busy}
                            onClick={() =>
                              run(`default:${f.id}`, () => domainsApi.updateFormat(f.id, { isDefault: true }), `"${f.name}" là định dạng mặc định.`, selected.id)
                            }
                          >
                            Đặt mặc định
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {selected && selected.formats.some((f) => !f.isArchived) && (
              <section className="card stack" aria-labelledby="try-title">
                <h2 id="try-title" className="card-title">Xem prompt & thử viết</h2>
                <PromptPreview key={selected.id} formats={selected.formats.filter((f) => !f.isArchived)} />
              </section>
            )}
          </div>
        )}
      </div>

      {drawer && selected && (
        <FormatDrawer
          domainId={selected.id}
          format={drawer.format}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            void load(selected.id);
          }}
        />
      )}
    </div>
  );
}
