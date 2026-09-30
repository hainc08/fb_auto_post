import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn, Eye, EyeOff } from 'lucide-react';
import { authApi, ApiError } from '../api';
import { useAuth } from '../auth';

/** Where to go after login: only same-app paths (no open redirect). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

export default function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to={safeNext(params.get('next'))} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.login(email, password);
      setUser(res.data);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không kết nối được máy chủ. Thử lại sau.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="auth-brand">
          <div className="logo-mark" aria-hidden="true" />
          <div>
            <h1 id="login-title">Đăng nhập Auto Post</h1>
            <p>Dùng email và mật khẩu quản trị viên đã cấp.</p>
          </div>
        </div>

        <label className="form-label" htmlFor="login-email">Email</label>
        <input
          id="login-email"
          className="form-input"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="form-label" htmlFor="login-password">Mật khẩu</label>
        <div className="password-field">
          <input
            id="login-password"
            className="form-input"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
            {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>

        {error && <p className="auth-error" role="alert">{error}</p>}

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <div className="spinner" /> : <LogIn size={16} aria-hidden="true" />} Đăng nhập
        </button>
        <p className="field-hint auth-foot">Quên mật khẩu? Nhờ quản trị viên đặt lại.</p>
      </form>
    </main>
  );
}
