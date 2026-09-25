import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { pagesApi, type PageInfo, type SyncAction, type SyncItem, type SyncPreview } from '../api';
import { useToast } from './Toast';
import { FacebookIcon } from './Icons';
import { pageInitials } from './PostBits';
import { loginWithFacebook } from '../lib/fb-sdk';
import { notifyPagesChanged } from './PageStatus';

const GROUPS: Array<{ action: SyncAction; title: string; hint: string }> = [
  { action: 'update', title: 'Cập nhật token', hint: 'Page đã kết nối, chuyển sang token của App hiện tại.' },
  { action: 'add', title: 'Page mới', hint: 'Chưa có trong app. Bỏ tick nếu không muốn thêm.' },
  { action: 'reconnect', title: 'Kết nối lại', hint: 'Page bạn từng ngắt kết nối. Tick để dùng lại.' },
  { action: 'disconnect', title: 'Không còn quyền', hint: 'Token mới không bao gồm Page này. Được tick sẽ chuyển sang "Đã ngắt" (bài cũ vẫn giữ).' },
];

const looksLikeAppSecret = (v: string) => /^[0-9a-f]{32}$/i.test(v.trim());

interface Props {
  appId: string;
  onApplied: (pages: PageInfo[]) => void;
  onCancel?: () => void;
}

/**
 * Đồng bộ Page: get a User token (Facebook login or paste) → preview what changes
 * → apply. Pages always end up on tokens issued by the App ID in Settings.
 */
export default function PageSync({ appId, onApplied, onCancel }: Props) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<null | 'login' | 'preview' | 'apply'>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const keyOf = (item: SyncItem) => `${item.action}:${item.pageId}`;

  async function runPreview(userToken: string) {
    setBusy('preview');
    try {
      const res = await pagesApi.syncPreview(userToken);
      setPreview(res.data);
      setPicked(new Set(res.data.items.filter((i) => i.selected).map(keyOf)));
      setToken('');
      if (res.data.items.length === 0) toast.info('Tài khoản này không quản trị Page nào, hoặc chưa cấp quyền Page cho App.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function login() {
    setBusy('login');
    try {
      const userToken = await loginWithFacebook(appId);
      await runPreview(userToken);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    const chosen = preview.items.filter((i) => picked.has(keyOf(i)));
    const refs = chosen.flatMap((i) => (i.ref ? [i.ref] : []));
    const disconnect = chosen.flatMap((i) => (i.action === 'disconnect' && i.pageDbId ? [i.pageDbId] : []));
    setBusy('apply');
    try {
      const res = await pagesApi.syncApply(refs, disconnect);
      toast.success(
        `Đã đồng bộ ${res.data.connected} Page${res.data.disconnected ? `, ngắt ${res.data.disconnected} Page không còn quyền` : ''}.`
      );
      setPreview(null);
      onApplied(res.data.pages);
      notifyPagesChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (item: SyncItem) =>
    setPicked((s) => {
      const next = new Set(s);
      const k = keyOf(item);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  if (preview) {
    const chosen = preview.items.filter((i) => picked.has(keyOf(i)));
    const count = (a: SyncAction) => chosen.filter((i) => i.action === a).length;
    const summary = [
      count('update') && `cập nhật ${count('update')}`,
      count('add') && `thêm ${count('add')}`,
      count('reconnect') && `kết nối lại ${count('reconnect')}`,
      count('disconnect') && `ngắt ${count('disconnect')}`,
    ].filter(Boolean);

    return (
      <div className="sync-panel">
        <div className="sync-head">
          <strong>Xem trước thay đổi</strong>
          <span className="muted">App {preview.appId} · {preview.items.length - preview.counts.disconnect} Page trong tài khoản Facebook</span>
        </div>
        {GROUPS.filter((g) => preview.counts[g.action] > 0).map((g) => (
          <section key={g.action} className={`sync-group sync-${g.action}`} aria-label={g.title}>
            <div className="sync-group-head">
              <span>{g.title} · {preview.counts[g.action]}</span>
              <span className="field-hint" style={{ margin: 0 }}>{g.hint}</span>
            </div>
            {preview.items.filter((i) => i.action === g.action).map((item) => (
              <label key={keyOf(item)} className="sync-row">
                <input type="checkbox" checked={picked.has(keyOf(item))} onChange={() => toggle(item)} disabled={item.action === 'update'} />
                {item.picture ? <img className="avatar" src={item.picture} alt="" /> : <span className="avatar" aria-hidden="true">{pageInitials(item.pageName)}</span>}
                <span className="sync-name">
                  <span title={item.pageName}>{item.pageName}</span>
                  <span className="muted">ID {item.pageId}{item.category ? ` · ${item.category}` : ''}</span>
                  {item.problem && <span className="sync-problem">{item.problem}</span>}
                </span>
              </label>
            ))}
          </section>
        ))}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreview(null)} disabled={!!busy}>Làm lại</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={apply} disabled={!!busy || chosen.length === 0}>
            {busy === 'apply' ? <div className="spinner" /> : null}
            Áp dụng{summary.length ? `: ${summary.join(', ')}` : ''}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sync-panel">
      <div className="sync-head">
        <strong>Đồng bộ Page với App {appId || '(chưa cấu hình)'}</strong>
        <span className="muted">Lấy lại token cho mọi Page bạn quản trị bằng App hiện tại. Bạn sẽ xem trước trước khi lưu.</span>
      </div>

      <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={login} disabled={!!busy || !appId}>
        {busy === 'login' || (busy === 'preview' && !token) ? <div className="spinner" /> : <FacebookIcon size={16} />}
        Đăng nhập Facebook để đồng bộ
      </button>
      <p className="field-hint" style={{ margin: 0 }}>
        Cần thêm tên miền của app này vào Facebook App (App Domains + Facebook Login → Allowed Domains for the JavaScript SDK).
      </p>

      <div className="sync-or"><span>hoặc dán User Access Token</span></div>
      <ol className="tool-steps" style={{ margin: 0 }}>
        <li>Mở <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Graph API Explorer</a>, ô <b>Meta App</b> chọn app <b>{appId || '…'}</b>.</li>
        <li>Chọn <b>Get User Access Token</b>, tick <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code>, rồi chọn đủ các Page.</li>
      </ol>
      <div className="tool-row">
        <label htmlFor="sync-token" className="sr-only">User Access Token</label>
        <input
          id="sync-token"
          className={`form-input ${looksLikeAppSecret(token) ? 'input-warn' : ''}`}
          type="password"
          autoComplete="off"
          placeholder="User Access Token (EAA…)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token.trim().length >= 20 && !busy && runPreview(token.trim())}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => runPreview(token.trim())} disabled={!!busy || token.trim().length < 20}>
          {busy === 'preview' && token ? <div className="spinner" /> : <KeyRound size={14} />} Xem trước
        </button>
      </div>
      {looksLikeAppSecret(token) && <p className="field-warning">Đây giống App Secret (32 ký tự). Ô này cần User Access Token bắt đầu bằng EAA…</p>}
      {onCancel && (
        <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={onCancel}>
          Đóng
        </button>
      )}
    </div>
  );
}
