import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, PenLine, Power, PowerOff, Trash2, Settings2 } from 'lucide-react';
import { schedulesApi, postsApi, type ScheduleDetail } from '../api';
import { useToast } from '../components/Toast';
import ScheduleForm from '../components/ScheduleForm';
import EditPostModal from '../components/EditPostModal';
import IdeaQueue from '../components/IdeaQueue';
import { PostThumb, postTitle } from '../components/PostBits';
import { describeSlots, queueStatus, slotLabel } from '../components/ScheduleBits';

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState<ScheduleDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingPost, setEditingPost] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    schedulesApi
      .get(id!)
      .then((r) => setS(r.data))
      .catch((e) => {
        toast.error(e.message);
        navigate('/schedules');
      });
  useEffect(() => void load(), [id]);
  // AI writes in the background: refresh while something is being written
  useEffect(() => {
    if (!s?.queue.some((p) => p.status === 'DRAFT' || p.status === 'GENERATING')) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [s]);

  async function approve(postId: string) {
    setBusy(postId);
    try {
      const res = await postsApi.approve(postId);
      toast.success(`Đã duyệt — bài sẽ đăng lúc ${slotLabel(res.data.scheduledAt)}.`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    try {
      await schedulesApi.toggle(s!.id);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove() {
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await schedulesApi.delete(s!.id);
      toast.success('Đã xoá lịch. Các bài đã viết vẫn nằm trong Bài đăng.');
      navigate('/schedules');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (!s) return <div className="loading-page"><div className="spinner spinner-lg" /></div>;

  return (
    <div className="schedule-detail">
      <Link to="/schedules" className="back-link">
        <ArrowLeft size={15} aria-hidden="true" /> Lịch đăng
      </Link>
      <div className="page-header schedules-header">
        <div>
          <h1>
            {s.name} <span className={`badge ${s.isActive ? 'badge-published' : 'badge-draft'}`}>{s.isActive ? 'Đang chạy' : 'Tạm dừng'}</span>
          </h1>
          <p>
            {describeSlots(s.weekdays, s.slots)} · {s.pages.map((p) => p.pageName).join(', ')}
            {s.domain ? ` · ${s.domain.name}` : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Settings2 size={14} aria-hidden="true" /> Sửa lịch
          </button>
          <button className={`btn btn-sm ${s.isActive ? 'btn-secondary' : 'btn-primary'}`} onClick={toggle}>
            {s.isActive ? (
              <><PowerOff size={14} aria-hidden="true" /> Tạm dừng</>
            ) : (
              <><Power size={14} aria-hidden="true" /> Chạy lại</>
            )}
          </button>
          <button className="btn btn-danger btn-sm" onClick={remove}>
            <Trash2 size={14} aria-hidden="true" /> {confirmDelete ? 'Bấm lần nữa để xoá' : 'Xoá'}
          </button>
        </div>
      </div>

      <div className="schedule-detail-grid">
        <section className="card" aria-labelledby="queue-title">
          <h2 id="queue-title">Bài sắp đăng</h2>
          {s.queue.length === 0 ? (
            <p className="field-hint">{s.ideasLeft ? 'AI sẽ viết bài trong ít phút tới.' : 'Chưa có bài — thêm ý tưởng để AI viết.'}</p>
          ) : (
            <ul className="queue-list">
              {s.queue.map((p) => {
                const st = queueStatus(p);
                return (
                  <li key={p.id} className="queue-item">
                    <PostThumb src={p.imageUrl} size={48} video={!!p.videoUrl} />
                    <span className="queue-main">
                      <strong>{slotLabel(p.scheduledAt)}</strong>
                      <span className={p.caption ? '' : 'muted'}>{postTitle(p.caption) || (p.status === 'FAILED' ? p.errorMessage : 'AI đang viết…')}</span>
                    </span>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    <span className="queue-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingPost(p.id)} disabled={p.status === 'GENERATING'}>
                        <PenLine size={14} aria-hidden="true" /> Sửa
                      </button>
                      {p.status === 'READY' && (
                        <button className="btn btn-primary btn-sm" onClick={() => approve(p.id)} disabled={busy === p.id}>
                          {busy === p.id ? <div className="spinner" /> : <Check size={14} aria-hidden="true" />} Duyệt
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="field-hint">Bài chưa duyệt khi tới giờ sẽ dời sang khung sau; các bài phía sau lùi theo.</p>
        </section>

        <IdeaQueue scheduleId={s.id} ideas={s.ideas} onChanged={() => void load()} />
      </div>

      {editing && (
        <ScheduleForm
          initial={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {editingPost && <EditPostModal postId={editingPost} onClose={() => setEditingPost(null)} onSaved={() => void load()} />}
    </div>
  );
}
