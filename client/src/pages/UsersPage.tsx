import { useEffect, useMemo, useState } from 'react';
import { UserPlus, PenLine, Trash2, Search } from 'lucide-react';
import { adminApi, ApiError, type AdminUserRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { formatWhen } from '../components/PostBits';
import MemberDialog from '../components/MemberDialog';

/** Admin: add, edit, disable and delete members. Only counts are shown — never their content. */
export default function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<{ member?: AdminUserRow } | null>(null);
  const [deleting, setDeleting] = useState<AdminUserRow | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setUsers((await adminApi.listUsers()).data);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không tải được danh sách.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? users.filter((u) => u.name.toLowerCase().includes(needle) || u.email.includes(needle)) : users;
  }, [users, q]);

  async function toggleActive(u: AdminUserRow) {
    setBusy(`active:${u.id}`);
    try {
      await adminApi.updateUser(u.id, { isActive: !u.isActive });
      toast.success(u.isActive ? `Đã vô hiệu hoá ${u.email} — member bị đăng xuất.` : `Đã kích hoạt lại ${u.email}.`);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không cập nhật được.');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy('delete');
    try {
      await adminApi.deleteUser(deleting.id, confirmEmail);
      toast.success(`Đã xoá ${deleting.email} và toàn bộ dữ liệu của họ.`);
      setDeleting(null);
      setConfirmEmail('');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không xoá được.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack users-page">
      <div className="row users-head">
        <div className="page-header">
          <h1>Người dùng</h1>
          <p>Thêm, sửa, vô hiệu hoá hoặc xoá member. Quản trị viên không xem được nội dung của member.</p>
        </div>
        <label className="topbar-search users-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" placeholder="Tìm tên hoặc email" aria-label="Tìm member" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({})}>
          <UserPlus size={16} aria-hidden="true" /> Thêm member
        </button>
      </div>

      <section className="card flush" aria-label="Danh sách member">
        <div className="table-wrap">
          <table className="page-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Vai trò</th>
                <th scope="col">Đăng nhập</th>
                <th scope="col">Page</th>
                <th scope="col">Bài 30 ngày</th>
                <th scope="col">Lần cuối</th>
                <th scope="col"><span className="sr-only">Thao tác</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="table-empty"><div className="spinner" /></td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty muted">Không có member nào khớp.</td>
                </tr>
              ) : (
                visible.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id} className={u.isActive ? '' : 'blocked'}>
                      <td className="member-cell">
                        <div className="name">
                          {u.name}
                          {self && <span className="muted"> (bạn)</span>}
                        </div>
                        <div className="muted member-email">{u.email}</div>
                      </td>
                      <td>{u.role === 'ADMIN' ? 'Quản trị viên' : 'Member'}</td>
                      <td>
                        {self ? (
                          <span className="badge badge-published">Hoạt động</span>
                        ) : (
                          <label className="switch" title={u.isActive ? 'Bấm để vô hiệu hoá đăng nhập' : 'Bấm để cho phép đăng nhập'}>
                            <input
                              type="checkbox"
                              checked={u.isActive}
                              disabled={busy === `active:${u.id}`}
                              onChange={() => toggleActive(u)}
                              aria-label={`Cho phép ${u.email} đăng nhập`}
                            />
                            <span className="switch-track" aria-hidden="true" />
                            <span className="switch-label">{u.isActive ? 'Hoạt động' : 'Vô hiệu hoá'}</span>
                          </label>
                        )}
                      </td>
                      <td className="mono">{u.pages}</td>
                      <td className="mono">{u.posts30d}</td>
                      <td className="muted">{u.lastLoginAt ? formatWhen(u.lastLoginAt) : 'Chưa'}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ member: u })} aria-label={`Sửa ${u.email}`}>
                            <PenLine size={14} aria-hidden="true" /> Sửa
                          </button>
                          {!self && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm danger-hover"
                              onClick={() => {
                                setDeleting(u);
                                setConfirmEmail('');
                              }}
                              aria-label={`Xoá ${u.email}`}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dialog && (
        <MemberDialog
          member={dialog.member}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}

      {deleting && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && busy !== 'delete' && setDeleting(null)}>
          <div className="modal-panel member-dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-title">
            <header className="modal-head">
              <h2 id="del-title">Xoá {deleting.name}?</h2>
            </header>
            <div className="member-body">
              <p className="member-warn">
                Xoá vĩnh viễn tài khoản <strong>{deleting.email}</strong> cùng <strong>{deleting.pages} Page</strong>, toàn bộ bài viết, lịch
                đăng và cấu hình của họ. Không hoàn tác được.
              </p>
              <p className="field-hint">
                Muốn giữ dữ liệu? Dùng công tắc <em>Vô hiệu hoá</em> thay vì xoá.
              </p>
              <label className="form-label" htmlFor="del-confirm">Gõ lại email để xác nhận</label>
              <input
                id="del-confirm"
                className="form-input"
                autoComplete="off"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                placeholder={deleting.email}
              />
            </div>
            <footer className="modal-foot">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)} disabled={busy === 'delete'}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={remove}
                disabled={busy === 'delete' || confirmEmail.trim().toLowerCase() !== deleting.email}
              >
                {busy === 'delete' ? <div className="spinner" /> : <Trash2 size={15} aria-hidden="true" />} Xoá vĩnh viễn
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
