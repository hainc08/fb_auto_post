import { useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  domainsApi,
  productsApi,
  platformOf,
  PLATFORM_LABEL,
  type AffiliatePlatform,
  type AffiliateProduct,
  type ContentDomain,
} from '../api';
import { useToast } from '../components/Toast';

interface Draft {
  platform: AffiliatePlatform;
  name: string;
  url: string;
  price: string;
  highlights: string;
  domainId: string;
}

const EMPTY: Draft = { platform: 'SHOPEE', name: '', url: '', price: '', highlights: '', domainId: '' };

const toDraft = (p: AffiliateProduct): Draft => ({
  platform: p.platform,
  name: p.name,
  url: p.url,
  price: p.price ?? '',
  highlights: p.highlights ?? '',
  domainId: p.domainId ?? '',
});

/** "Sản phẩm affiliate": the member's Shopee / Lazada / TikTok Shop links, attached to posts. */
export default function ProductsPage() {
  const toast = useToast();
  const [products, setProducts] = useState<AffiliateProduct[]>([]);
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  /** null = form closed, 'new' = adding, else the product being edited */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setProducts((await productsApi.list({ archived: true })).data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    domainsApi.list().then((r) => setDomains(r.data)).catch(() => {});
  }, []);

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const domainName = (id: string | null) => domains.find((d) => d.id === id)?.name ?? '—';

  function open(product: AffiliateProduct | null) {
    setEditing(product?.id ?? 'new');
    setDraft(product ? toDraft(product) : EMPTY);
  }

  function pasteUrl(url: string) {
    const guessed = platformOf(url);
    setDraft((d) => ({ ...d, url, ...(guessed && { platform: guessed }) }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      platform: draft.platform,
      name: draft.name,
      url: draft.url,
      price: draft.price,
      highlights: draft.highlights,
      domainId: draft.domainId || null,
    };
    setBusy(true);
    try {
      if (editing === 'new') await productsApi.create(body);
      else if (editing) await productsApi.update(editing, body);
      toast.success(editing === 'new' ? `Đã thêm sản phẩm "${draft.name}".` : 'Đã lưu sản phẩm.');
      setEditing(null);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast.success(done);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  const visible = products.filter((p) => showArchived || !p.isArchived);
  const archivedCount = products.filter((p) => p.isArchived).length;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Sản phẩm affiliate</h1>
        <p>
          Dán link affiliate Shopee, Lazada hoặc TikTok Shop của bạn. Khi tạo bài, chọn tối đa 3 sản phẩm: AI nhắc tên và lợi ích trong bài, còn link
          được thêm tự động vào cuối bài và bình luận đầu.
        </p>
      </div>

      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => open(null)}>
          <Plus size={15} aria-hidden="true" /> Thêm sản phẩm
        </button>
        {archivedCount > 0 && (
          <button type="button" className="link-btn" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Ẩn' : 'Xem'} {archivedCount} sản phẩm đã lưu trữ
          </button>
        )}
      </div>

      {editing && (
        <form className="card stack product-form" onSubmit={save}>
          <h2 className="card-title">{editing === 'new' ? 'Sản phẩm mới' : 'Sửa sản phẩm'}</h2>
          <div>
            <label className="form-label" htmlFor="p-url">Link affiliate</label>
            <input id="p-url" className="form-input" required maxLength={1000} value={draft.url} onChange={(e) => pasteUrl(e.target.value)} placeholder="https://s.shopee.vn/…" />
            <p className="field-hint">Link bạn lấy từ trang tiếp thị liên kết của sàn. App nhận ra sàn từ link.</p>
          </div>
          <div className="product-form-grid">
            <div>
              <label className="form-label" htmlFor="p-platform">Sàn</label>
              <select id="p-platform" className="form-select" value={draft.platform} onChange={(e) => set('platform')(e.target.value)}>
                {(Object.keys(PLATFORM_LABEL) as AffiliatePlatform[]).map((p) => (
                  <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="p-name">Tên sản phẩm</label>
              <input id="p-name" className="form-input" required maxLength={200} value={draft.name} onChange={(e) => set('name')(e.target.value)} placeholder="VD: Bình xịt điện 16L" />
            </div>
            <div>
              <label className="form-label" htmlFor="p-price">Giá (không bắt buộc)</label>
              <input id="p-price" className="form-input" maxLength={50} value={draft.price} onChange={(e) => set('price')(e.target.value)} placeholder="VD: 450.000đ" />
            </div>
            <div>
              <label className="form-label" htmlFor="p-domain">Lĩnh vực</label>
              <select id="p-domain" className="form-select" value={draft.domainId} onChange={(e) => set('domainId')(e.target.value)}>
                <option value="">— Không —</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label" htmlFor="p-highlights">Điểm nổi bật để AI nhắc tới</label>
            <textarea
              id="p-highlights"
              className="form-textarea"
              rows={2}
              maxLength={500}
              value={draft.highlights}
              onChange={(e) => set('highlights')(e.target.value)}
              placeholder="VD: pin dùng 12 tiếng, bình 16 lít, bảo hành 6 tháng"
            />
            <p className="field-hint">AI chỉ nói về sản phẩm theo thông tin ở đây, không tự bịa giá hay khuyến mãi.</p>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? <div className="spinner" /> : 'Lưu sản phẩm'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Huỷ</button>
          </div>
        </form>
      )}

      <section className="card flush" aria-label="Danh sách sản phẩm">
        {loading ? (
          <div className="spinner" />
        ) : visible.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>Chưa có sản phẩm nào. Bấm "Thêm sản phẩm" để dán link affiliate đầu tiên.</p>
        ) : (
          <div className="table-wrap">
            <table className="page-table">
              <thead>
                <tr>
                  <th scope="col">Sản phẩm</th>
                  <th scope="col">Sàn</th>
                  <th scope="col">Giá</th>
                  <th scope="col">Lĩnh vực</th>
                  <th scope="col">Đã gắn</th>
                  <th scope="col"><span className="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id} className={p.isArchived ? 'muted' : ''}>
                    <td data-label="Sản phẩm">
                      <strong>{p.name}</strong>
                      {p.isArchived && <span className="badge badge-draft" style={{ marginLeft: 8 }}>Đã lưu trữ</span>}
                      <div className="cell-note product-url">
                        <a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a>
                      </div>
                    </td>
                    <td data-label="Sàn">{PLATFORM_LABEL[p.platform]}</td>
                    <td data-label="Giá">{p.price || <span className="muted">—</span>}</td>
                    <td data-label="Lĩnh vực">{domainName(p.domainId)}</td>
                    <td data-label="Đã gắn">{p.usedCount ?? 0} bài</td>
                    <td data-label="Thao tác">
                      <div className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-ghost btn-sm" aria-label={`Sửa ${p.name}`} onClick={() => open(p)}>
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={p.isArchived ? `Khôi phục ${p.name}` : `Lưu trữ ${p.name}`}
                          title={p.isArchived ? 'Khôi phục' : 'Lưu trữ: không còn gợi ý khi tạo bài'}
                          onClick={() => run(() => productsApi.update(p.id, { isArchived: !p.isArchived }), p.isArchived ? 'Đã khôi phục sản phẩm.' : 'Đã lưu trữ sản phẩm.')}
                        >
                          {p.isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                        </button>
                        {!p.usedCount && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={`Xoá ${p.name}`}
                            onClick={() => run(() => productsApi.remove(p.id), 'Đã xoá sản phẩm.')}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
