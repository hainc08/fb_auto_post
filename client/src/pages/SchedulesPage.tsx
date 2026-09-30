import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Plus, AlertTriangle } from 'lucide-react';
import { schedulesApi, type ScheduleSummary } from '../api';
import { useToast } from '../components/Toast';
import ScheduleForm from '../components/ScheduleForm';
import { describeSlots, slotLabel } from '../components/ScheduleBits';

export default function SchedulesPage() {
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = () =>
    schedulesApi
      .list()
      .then((r) => setSchedules(r.data))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  useEffect(() => void load(), []);

  return (
    <div>
      <div className="page-header schedules-header">
        <div>
          <h1>Lịch đăng</h1>
          <p>AI viết sẵn bài theo hàng chờ ý tưởng, bạn duyệt, hệ thống tự đăng đúng khung giờ.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={18} /> Tạo lịch
        </button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : schedules.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Calendar size={56} style={{ opacity: 0.3 }} aria-hidden="true" />
            <h3>Chưa có lịch đăng</h3>
            <p>Chọn ngày, khung giờ và thêm vài ý tưởng — AI sẽ viết sẵn bài để bạn duyệt.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={18} /> Tạo lịch đầu tiên
            </button>
          </div>
        </div>
      ) : (
        <div className="grid-2">
          {schedules.map((s) => (
            <Link key={s.id} to={`/schedules/${s.id}`} className="card schedule-card">
              <div className="schedule-card-head">
                <h3>{s.name}</h3>
                <span className={`badge ${s.isActive ? 'badge-published' : 'badge-draft'}`}>{s.isActive ? 'Đang chạy' : 'Tạm dừng'}</span>
              </div>
              <p className="muted">{describeSlots(s.weekdays, s.slots)}</p>
              <p className="muted">
                {s.pages.map((p) => p.pageName).join(', ') || 'Chưa có Page'}
                {s.domain ? ` · ${s.domain.name}` : ''}
              </p>
              <dl className="schedule-stats">
                <div><dt>Khung tới</dt><dd>{s.isActive ? slotLabel(s.nextSlotAt) : '—'}</dd></div>
                <div><dt>Bài viết sẵn</dt><dd>{s.queuedCount}/{s.bufferSize}</dd></div>
                <div><dt>Chờ duyệt</dt><dd className={s.awaitingApproval ? 'attention' : ''}>{s.awaitingApproval}</dd></div>
                <div><dt>Ý tưởng còn</dt><dd className={s.ideasLeft <= 3 ? 'attention' : ''}>{s.ideasLeft}</dd></div>
              </dl>
              {s.ideasLeft <= 3 && s.isActive && (
                <p className="schedule-warn">
                  <AlertTriangle size={14} aria-hidden="true" /> {s.ideasLeft ? `Chỉ còn ${s.ideasLeft} ý tưởng` : 'Hết ý tưởng'} — thêm ý tưởng để lịch không bị ngắt.
                </p>
              )}
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <ScheduleForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
