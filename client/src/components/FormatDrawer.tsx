import { useState, type FormEvent } from 'react';
import { X, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { domainsApi, ApiError, LENGTH_LABEL, type ContentFormat, type FormatLength } from '../api';
import { useToast } from './Toast';

interface Props {
  domainId: string;
  format?: ContentFormat;
  onClose: () => void;
  onSaved: () => void;
}

const LENGTHS: FormatLength[] = ['SHORT', 'MEDIUM', 'LONG'];

/** Side panel to add or edit a post format of a domain. */
export default function FormatDrawer({ domainId, format, onClose, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState(format?.name ?? '');
  const [instructions, setInstructions] = useState(format?.instructions ?? '');
  const [example, setExample] = useState(format?.example ?? '');
  const [length, setLength] = useState<FormatLength>(format?.length ?? 'MEDIUM');
  const [withImage, setWithImage] = useState(format?.withImage ?? true);
  const [isDefault, setIsDefault] = useState(format?.isDefault ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(done);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không lưu được. Thử lại sau.');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name, instructions, example: example.trim() || null, length, withImage, isDefault };
    void act(
      () => (format ? domainsApi.updateFormat(format.id, body) : domainsApi.createFormat(domainId, body)),
      format ? `Đã lưu định dạng "${name}".` : `Đã thêm định dạng "${name}".`
    );
  }

  return (
    <div className="modal-overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="fd-title" onSubmit={submit}>
        <header className="modal-head">
          <h2 id="fd-title">{format ? `Sửa định dạng "${format.name}"` : 'Thêm định dạng bài'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="member-body">
          {format?.legacyPrompt && (
            <p className="field-hint legacy-note">
              Định dạng chuyển từ System prompt cũ: AI dùng <strong>nguyên văn</strong> phần cấu trúc bên dưới, không dùng các khối của lĩnh vực.
            </p>
          )}
          <label className="form-label" htmlFor="fd-name">Tên định dạng</label>
          <input id="fd-name" className="form-input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Hỏi đáp" />

          <label className="form-label" htmlFor="fd-ins">Cấu trúc bài</label>
          <textarea
            id="fd-ins"
            className="form-textarea"
            rows={7}
            required
            maxLength={4000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Mở bài thế nào, thân bài gồm gì, kết bài ra sao. Có thể dùng {{idea}}, {{page_name}}."
          />

          <span className="form-label" id="fd-len">Độ dài</span>
          <div className="segmented" role="radiogroup" aria-labelledby="fd-len">
            {LENGTHS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={length === l} className={length === l ? 'active' : ''} onClick={() => setLength(l)}>
                {LENGTH_LABEL[l]}
              </button>
            ))}
          </div>

          <label className="form-label" htmlFor="fd-ex">Bài mẫu (tuỳ chọn)</label>
          <textarea
            id="fd-ex"
            className="form-textarea"
            rows={5}
            maxLength={4000}
            value={example}
            onChange={(e) => setExample(e.target.value)}
            placeholder="AI tham khảo phong cách, không chép lại."
          />

          <label className="check-row">
            <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} />
            Kèm ảnh AI (bỏ chọn cho bài chỉ có chữ)
          </label>
          <label className="check-row">
            <input type="checkbox" checked={isDefault} disabled={format?.isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Định dạng mặc định của lĩnh vực
          </label>

          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>

        <footer className="modal-foot">
          <div className="row" style={{ gap: 6 }}>
            {format && !format.isDefault && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => domainsApi.updateFormat(format.id, { isArchived: !format.isArchived }),
                      format.isArchived ? 'Đã dùng lại định dạng.' : 'Đã lưu trữ định dạng.'
                    )
                  }
                >
                  {format.isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                  {format.isArchived ? 'Dùng lại' : 'Lưu trữ'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm danger-hover"
                  disabled={busy}
                  aria-label="Xoá định dạng"
                  onClick={() => act(() => domainsApi.removeFormat(format.id), 'Đã xoá định dạng.')}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Huỷ</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy && <div className="spinner" />} {format ? 'Lưu' : 'Thêm định dạng'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
