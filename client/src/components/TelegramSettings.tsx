import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { telegramApi, type TelegramStatus } from '../api';
import { useToast } from './Toast';

/** Poll the link status this often, and give up after this many checks (2 minutes) */
const POLL_MS = 3000;
const POLL_MAX = 40;

/** Settings → Telegram: connect the member's own bot, link a chat, choose the morning time. */
export default function TelegramSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const polls = useRef(0);

  async function load() {
    try {
      setStatus((await telegramApi.get()).data);
    } catch (e: any) {
      toast.error(`Không tải được cấu hình Telegram: ${e.message}`);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Waiting for the member to press Start in Telegram: look for the link every few seconds, for a while
  const waiting = !!status?.configured && !status.linked;
  useEffect(() => {
    if (!waiting) return;
    polls.current = 0;
    const timer = setInterval(() => {
      if (++polls.current > POLL_MAX) return clearInterval(timer);
      telegramApi
        .get()
        .then((r) => {
          setStatus(r.data);
          if (r.data.linked) toast.success('Đã liên kết Telegram.');
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run('connect', async () => {
      setStatus((await telegramApi.connect(token.trim())).data);
      setToken('');
      toast.success('Đã kết nối bot. Bấm "Mở Telegram để liên kết" rồi bấm Start.');
    });

  const save = (change: { enabled?: boolean; digestTime?: string }) =>
    run('save', async () => {
      setStatus((await telegramApi.save(change)).data);
    });

  const disconnect = () => {
    if (!confirmingDisconnect) return setConfirmingDisconnect(true);
    setConfirmingDisconnect(false);
    return run('disconnect', async () => {
      await telegramApi.disconnect();
      setStatus((await telegramApi.get()).data);
      toast.success('Đã ngắt kết nối Telegram.');
    });
  };

  if (!status) return <div className="spinner" aria-label="Đang tải" />;

  return (
    <section className="card settings-card" aria-labelledby="tg-title">
      <div className="settings-card-header">
        <div className="settings-icon"><Send size={18} aria-hidden="true" /></div>
        <div>
          <h3 id="tg-title" className="card-title">Telegram</h3>
          <p className="field-hint" style={{ margin: 0 }}>Nhận danh sách bài chờ duyệt mỗi sáng và duyệt ngay trong Telegram</p>
        </div>
      </div>
      <div className="settings-card-body">
        <ol className="field-hint telegram-steps">
          <li>Mở Telegram, tìm @BotFather, gõ /newbot và làm theo hướng dẫn.</li>
          <li>Sao chép token bot nhận được và dán vào đây.</li>
          <li>Bấm "Mở Telegram để liên kết" rồi bấm Start.</li>
        </ol>

        {!status.canReceive && (
          <p className="field-warning">
            ⚠ Địa chỉ web của app chưa dùng https nên Telegram chưa gửi được tin về. Đặt PUBLIC_URL (hoặc CLIENT_URL) là địa chỉ https của app.
          </p>
        )}

        {!status.configured ? (
          <div className="form-group">
            <label className="form-label" htmlFor="tg-token">Token bot</label>
            <input
              id="tg-token"
              className="form-input"
              type="password"
              autoComplete="new-password"
              placeholder="123456789:AA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || token.trim().length < 20 || !status.canReceive} onClick={connect}>
                {busy === 'connect' ? <div className="spinner" /> : 'Kết nối bot'}
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p>
              Bot: <strong>@{status.botUsername}</strong>{' '}
              <span className={status.linked ? 'ok-text' : 'warn-text'}>{status.linked ? '· đã liên kết' : '· chưa liên kết chat'}</span>
            </p>

            {status.lastError && <p className="field-warning">⚠ {status.lastError}</p>}

            {!status.linked && status.linkUrl && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <a className="btn btn-primary btn-sm" href={status.linkUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden="true" /> Mở Telegram để liên kết
                </a>
                <span className="muted">Bấm Start trong Telegram, trang này sẽ tự cập nhật.</span>
              </div>
            )}

            {status.linked && (
              <>
                <label className="switch">
                  <input type="checkbox" checked={status.enabled} disabled={busy !== null} onChange={(e) => save({ enabled: e.target.checked })} />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">Gửi danh sách bài chờ duyệt mỗi sáng</span>
                </label>
                <div className="form-group" style={{ maxWidth: 220 }}>
                  <label className="form-label" htmlFor="tg-time">Giờ gửi</label>
                  <input
                    id="tg-time"
                    className="form-input"
                    type="time"
                    value={status.digestTime}
                    disabled={busy !== null}
                    onChange={(e) => e.target.value && save({ digestTime: e.target.value })}
                  />
                  <p className="field-hint">Giờ Việt Nam. Chỉ gửi khi có bài đang chờ duyệt.</p>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => run('test', async () => { await telegramApi.test(); toast.success('Đã gửi tin thử vào Telegram.'); })}>
                    Gửi thử
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run('digest', async () => {
                        const { total, sent } = (await telegramApi.sendDigest()).data;
                        toast.success(total ? `Đã gửi ${sent}/${total} bài vào Telegram.` : 'Không có bài nào đang chờ duyệt.');
                      })
                    }
                  >
                    Gửi danh sách ngay
                  </button>
                </div>
              </>
            )}

            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {status.linked && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => run('code', async () => setStatus((await telegramApi.newLinkCode()).data))}>
                  Lấy mã liên kết mới
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={disconnect} onBlur={() => setConfirmingDisconnect(false)}>
                {busy === 'disconnect' ? <div className="spinner" /> : confirmingDisconnect ? 'Bấm lần nữa để ngắt kết nối' : 'Ngắt kết nối'}
              </button>
            </div>
            {status.linked && status.linkUrl && (
              <p className="field-hint">
                Muốn liên kết chat khác? Mở <a href={status.linkUrl} target="_blank" rel="noopener noreferrer">link này</a> trong Telegram của chat đó.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
