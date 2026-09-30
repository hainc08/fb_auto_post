import { useState, type FormEvent } from 'react';
import { X, Eye, EyeOff, Shuffle, Copy } from 'lucide-react';
import { adminApi, ApiError, type AdminUserRow } from '../api';
import { useToast } from './Toast';

/** 12 readable characters, generated in the browser. */
function randomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

interface Props {
  member?: AdminUserRow;
  onClose: () => void;
  onSaved: () => void;
}

/** Add a member (admin sets the password) or edit one (empty password = keep it). */
export default function MemberDialog({ member, onClose, onSaved }: Props) {
  const toast = useToast();
  const editing = !!member;
  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'USER'>(member?.role ?? 'USER');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing && password.length < 8) return setError('Mật khẩu cần ít nhất 8 ký tự.');
    if (editing && password && password.length < 8) return setError('Mật khẩu mới cần ít nhất 8 ký tự.');
    setBusy(true);
    setError(null);
    try {
      if (member) {
        await adminApi.updateUser(member.id, {
          ...(name !== member.name && { name }),
          ...(email.trim().toLowerCase() !== member.email && { email }),
          ...(role !== member.role && { role }),
          ...(password && { password }),
        });
        toast.success(`Đã lưu ${name}.`);
      } else {
        await adminApi.createUser({ name, email, password, role });
        toast.success(`Đã tạo tài khoản ${email.trim().toLowerCase()}. Gửi email + mật khẩu cho member.`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không lưu được. Thử lại sau.');
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      toast.success('Đã copy mật khẩu.');
    } catch {
      toast.info('Không copy được — hãy bấm hiện mật khẩu rồi copy thủ công.');
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal-panel member-dialog" role="dialog" aria-modal="true" aria-labelledby="member-title" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2 id="member-title">{member ? `Sửa ${member.name}` : 'Thêm member'}</h2>
            <p className="muted member-sub">
              {editing ? 'Đổi mật khẩu, email hoặc vai trò sẽ đăng xuất member.' : 'Member đăng nhập ngay bằng email và mật khẩu này.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="member-body">
          <label className="form-label" htmlFor="m-name">Tên</label>
          <input id="m-name" className="form-input" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />

          <label className="form-label" htmlFor="m-email">Email đăng nhập</label>
          <input
            id="m-email"
            className="form-input"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label className="form-label" htmlFor="m-password">
            {editing ? 'Mật khẩu mới (để trống = giữ nguyên)' : 'Mật khẩu (ít nhất 8 ký tự)'}
          </label>
          <div className="password-row">
            <div className="password-field">
              <input
                id="m-password"
                className="form-input"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required={!editing}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
                {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setPassword(randomPassword());
                setShow(true);
              }}
            >
              <Shuffle size={14} aria-hidden="true" /> Tạo ngẫu nhiên
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={copyPassword} disabled={!password} aria-label="Copy mật khẩu">
              <Copy size={14} aria-hidden="true" />
            </button>
          </div>

          <label className="form-label" htmlFor="m-role">Vai trò</label>
          <select id="m-role" className="form-select" value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'USER')}>
            <option value="USER">Member</option>
            <option value="ADMIN">Quản trị viên</option>
          </select>

          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Huỷ</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <div className="spinner" />} {editing ? 'Lưu thay đổi' : 'Tạo tài khoản'}
          </button>
        </footer>
      </form>
    </div>
  );
}
