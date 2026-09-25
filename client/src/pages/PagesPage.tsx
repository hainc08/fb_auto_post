import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, ExternalLink, PlugZap, Unplug, ShieldCheck } from 'lucide-react';
import { FacebookIcon } from '../components/Icons';
import { pagesApi, type PageInfo } from '../api';
import { useToast } from '../components/Toast';
import PageSync from '../components/PageSync';
import { PageStatusBadge, notifyPagesChanged, staleAppPages } from '../components/PageStatus';
import { formatWhen, pageInitials } from '../components/PostBits';

const dateOnly = (iso: string) => new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const DAY = 24 * 60 * 60 * 1000;

export default function PagesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [appId, setAppId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const syncOpen = params.get('sync') === '1';

  const setSyncOpen = (open: boolean) => {
    const next = new URLSearchParams(params);
    open ? next.set('sync', '1') : next.delete('sync');
    setParams(next, { replace: true });
  };

  async function load() {
    try {
      const res = await pagesApi.list();
      setPages(res.data);
      setAppId(res.meta?.appId ?? '');
    } catch (e: any) {
      toast.error(`Không tải được danh sách Page: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function checkAll() {
    setBusy('check-all');
    try {
      const res = await pagesApi.check();
      setPages(res.data);
      notifyPagesChanged();
      const blocked = res.data.filter((p) => p.isActive && !p.postable).length;
      blocked ? toast.error(`${blocked} Page chưa đăng được — xem cột Trạng thái.`) : toast.success('Mọi Page đều đăng được.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function checkOne(id: string) {
    setBusy(`check:${id}`);
    try {
      const res = await pagesApi.checkOne(id);
      setPages((list) => list.map((p) => (p.id === id ? { ...p, ...res.data } : p)));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string) {
    if (confirmId !== id) return setConfirmId(id);
    setBusy(`disconnect:${id}`);
    try {
      await pagesApi.disconnect(id);
      toast.success('Đã ngắt kết nối Page. Bài cũ vẫn được giữ.');
      setConfirmId(null);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const active = useMemo(() => pages.filter((p) => p.isActive), [pages]);
  const inactive = useMemo(() => pages.filter((p) => !p.isActive), [pages]);
  const postable = active.filter((p) => p.postable).length;
  const stale = staleAppPages(pages);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div className="page-header" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
          <h1>Kênh Facebook</h1>
          <p>Các Page đăng bài bằng Facebook App trong Cài đặt. Chỉ Page có trạng thái "Đăng được" mới chọn được khi tạo bài.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={checkAll} disabled={!!busy || active.length === 0}>
            {busy === 'check-all' ? <div className="spinner" /> : <ShieldCheck size={16} aria-hidden="true" />} Kiểm tra tất cả
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(!syncOpen)}>
            <RefreshCw size={16} aria-hidden="true" /> Đồng bộ Page
          </button>
        </div>
      </div>

      <section className="card app-strip" aria-label="Facebook App hiện tại">
        <span className="app-strip-icon"><FacebookIcon size={18} color="white" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="app-strip-title">Facebook App {appId ? <code>{appId}</code> : <em>chưa cấu hình</em>}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {postable}/{active.length} Page đăng được{stale.length ? ` · ${stale.length} Page còn dùng token của app cũ` : ''}
          </div>
        </div>
        <Link to="/settings#facebook" className="link-btn">Đổi App ID / Secret</Link>
      </section>

      {stale.length > 0 && !syncOpen && (
        <div className="app-banner inline" role="status">
          <span>
            <strong>{stale.length} Page</strong> vẫn dùng token của Facebook App khác nên đang bị chặn đăng. Đồng bộ để cấp lại token bằng App {appId}.
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setSyncOpen(true)}>Đồng bộ ngay</button>
        </div>
      )}

      {syncOpen && (
        <section className="card">
          <PageSync
            appId={appId}
            onApplied={(list) => {
              setPages(list);
              setSyncOpen(false);
            }}
            onCancel={() => setSyncOpen(false)}
          />
        </section>
      )}

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : pages.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <FacebookIcon size={56} style={{ color: '#1877F2', opacity: 0.5 }} />
            <h3>Chưa kết nối Facebook Page nào</h3>
            <p>Đồng bộ để lấy mọi Page bạn quản trị bằng Facebook App trong Cài đặt.</p>
            {!syncOpen && (
              <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(true)}>
                <RefreshCw size={16} aria-hidden="true" /> Đồng bộ Page
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <section className="card flush" aria-label="Page đang kết nối">
            <div className="table-wrap">
              <table className="page-table">
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col">Trạng thái</th>
                    <th scope="col">Token do app</th>
                    <th scope="col">Hạn token</th>
                    <th scope="col">Kiểm tra</th>
                    <th scope="col"><span className="sr-only">Thao tác</span></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((p) => (
                    <PageRow
                      key={p.id}
                      page={p}
                      appId={appId}
                      busy={busy}
                      confirming={confirmId === p.id}
                      onCheck={() => checkOne(p.id)}
                      onDisconnect={() => disconnect(p.id)}
                    />
                  ))}
                  {active.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Không có Page nào đang kết nối.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {inactive.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowInactive((v) => !v)}>
                {showInactive ? 'Ẩn' : 'Xem'} {inactive.length} Page đã ngắt
              </button>
              {showInactive && (
                <section className="card flush" aria-label="Page đã ngắt">
                  <ul className="inactive-list">
                    {inactive.map((p) => (
                      <li key={p.id}>
                        <span className="avatar" aria-hidden="true">{pageInitials(p.pageName)}</span>
                        <span className="name">{p.pageName}</span>
                        <span className="muted">{p._count?.posts ?? 0} bài · kết nối lại bằng Đồng bộ Page</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface RowProps {
  page: PageInfo;
  appId: string;
  busy: string | null;
  confirming: boolean;
  onCheck: () => void;
  onDisconnect: () => void;
}

function PageRow({ page: p, appId, busy, confirming, onCheck, onDisconnect }: RowProps) {
  const expiresSoon = p.tokenExpiresAt && new Date(p.tokenExpiresAt).getTime() - Date.now() < 7 * DAY;
  return (
    <tr className={p.postable ? '' : 'blocked'}>
      <td>
        <div className="page-cell">
          {p.pageAvatar ? <img className="avatar" src={p.pageAvatar} alt="" /> : <span className="avatar" aria-hidden="true">{pageInitials(p.pageName)}</span>}
          <div style={{ minWidth: 0 }}>
            <div className="name" title={p.pageName}>{p.pageName}</div>
            <div className="muted" style={{ fontSize: 12 }}>ID {p.pageId} · {p._count?.posts ?? 0} bài</div>
          </div>
        </div>
      </td>
      <td>
        <PageStatusBadge page={p} />
        {p.blockMessage && <div className="cell-note error">{p.blockMessage}</div>}
        {!p.blockMessage && p.tokenStatus === 'ERROR' && p.tokenError && <div className="cell-note">{p.tokenError}</div>}
      </td>
      <td className="mono">
        {p.tokenAppId ? (
          p.tokenAppId === appId ? <span className="ok-text">✓ App hiện tại</span> : <span className="warn-text">{p.tokenAppId}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {p.tokenExpiresAt ? (
          <span className={expiresSoon ? 'warn-text' : ''}>{dateOnly(p.tokenExpiresAt)}</span>
        ) : p.tokenStatus === 'VALID' ? (
          <span className="muted">Không hết hạn</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="muted">{p.tokenCheckedAt ? formatWhen(p.tokenCheckedAt) : 'Chưa'}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCheck} disabled={!!busy} aria-label={`Kiểm tra lại ${p.pageName}`}>
            {busy === `check:${p.id}` ? <div className="spinner" /> : <PlugZap size={14} aria-hidden="true" />}
          </button>
          <a className="btn btn-secondary btn-sm" href={`https://facebook.com/${p.pageId}`} target="_blank" rel="noreferrer" aria-label={`Mở ${p.pageName} trên Facebook`}>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <button type="button" className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-secondary'}`} onClick={onDisconnect} disabled={!!busy && !confirming}>
            {busy === `disconnect:${p.id}` ? <div className="spinner" /> : <Unplug size={14} aria-hidden="true" />}
            {confirming ? 'Bấm lần nữa để ngắt' : null}
          </button>
        </div>
      </td>
    </tr>
  );
}
