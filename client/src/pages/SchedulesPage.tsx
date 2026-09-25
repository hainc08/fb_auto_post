import { useState, useEffect } from 'react';
import { Calendar, Plus, Trash2, Power, PowerOff, X } from 'lucide-react';
import { schedulesApi, pagesApi } from '../api';

interface ScheduleData {
  id: string;
  name: string;
  isActive: boolean;
  frequency: string;
  timezone: string;
  startDate: string;
  endDate: string | null;
  templateId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  createdAt: string;
  page: { id: string; pageName: string; pageAvatar: string | null };
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [form, setForm] = useState({
    pageId: '',
    name: '',
    frequency: 'DAILY',
    startDate: '',
    endDate: '',
    idea: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [s, p] = await Promise.all([
        schedulesApi.list().catch(() => ({ data: [] })),
        pagesApi.list().catch(() => ({ data: [] })),
      ]);
      setSchedules(s.data);
      setPages(p.data);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    try {
      const { idea, ...rest } = form;
      await schedulesApi.create({
        ...rest,
        inputData: { basicInfo: idea.trim() },
        startDate: new Date(form.startDate).toISOString(),
        endDate: form.endDate ? new Date(form.endDate).toISOString() : undefined,
      });
      setShowModal(false);
      loadData();
    } catch (err: any) { alert(err.message); }
  }

  async function handleToggle(id: string) {
    try {
      await schedulesApi.toggle(id);
      loadData();
    } catch (err: any) { alert(err.message); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Xóa lịch đăng này?')) return;
    try {
      await schedulesApi.delete(id);
      setSchedules(schedules.filter(s => s.id !== id));
    } catch (err: any) { alert(err.message); }
  }

  const freqLabels: Record<string, string> = {
    ONCE: 'Một lần',
    DAILY: 'Hàng ngày',
    WEEKLY: 'Hàng tuần',
    MONTHLY: 'Hàng tháng',
    CUSTOM_CRON: 'Tùy chỉnh (cũ)',
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Lịch đăng <span className="nav-tag" style={{ verticalAlign: 6, fontSize: 12 }}>Beta</span></h1>
          <p>Tự động đăng bài theo lịch trình</p>
        </div>
        <button className="btn btn-primary" onClick={() => {
          setForm({ pageId: '', name: '', frequency: 'DAILY', startDate: '', endDate: '', idea: '' });
          setShowModal(true);
        }}>
          <Plus size={18} /> Tạo lịch mới
        </button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : schedules.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Calendar size={56} style={{ opacity: 0.3 }} />
            <h3>Chưa có lịch đăng bài</h3>
            <p>Tạo lịch để tự động đăng bài hàng ngày, hàng tuần</p>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              <Plus size={18} /> Tạo lịch đầu tiên
            </button>
          </div>
        </div>
      ) : (
        <div className="grid-2">
          {schedules.map(s => (
            <div className="card" key={s.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: s.isActive ? 'var(--success-400)' : 'var(--text-tertiary)',
                      display: 'inline-block',
                    }} />
                    {s.name}
                  </h3>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                    {s.page.pageName} · {freqLabels[s.frequency]}
                  </div>
                </div>
                <span className={`badge ${s.isActive ? 'badge-published' : 'badge-draft'}`}>
                  {s.isActive ? 'Đang chạy' : 'Tạm dừng'}
                </span>
              </div>

              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px',
                fontSize: '0.8rem', marginBottom: 16,
              }}>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Tổng đã chạy:</span>
                  <strong style={{ marginLeft: 6 }}>{s.totalRuns}</strong>
                </div>
                {s.lastRunAt && (
                  <div>
                    <span style={{ color: 'var(--text-tertiary)' }}>Lần cuối:</span>
                    <span style={{ marginLeft: 6 }}>{new Date(s.lastRunAt).toLocaleDateString('vi-VN')}</span>
                  </div>
                )}
                {s.nextRunAt && (
                  <div>
                    <span style={{ color: 'var(--text-tertiary)' }}>Tiếp theo:</span>
                    <span style={{ marginLeft: 6 }}>{new Date(s.nextRunAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                <button className={`btn btn-sm ${s.isActive ? 'btn-secondary' : 'btn-primary'}`}
                  style={{ flex: 1 }} onClick={() => handleToggle(s.id)}>
                  {s.isActive ? <><PowerOff size={14} /> Tạm dừng</> : <><Power size={14} /> Kích hoạt</>}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, backdropFilter: 'blur(4px)',
        }} onClick={() => setShowModal(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 480 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2>Tạo lịch đăng bài</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Tên lịch *</label>
              <input className="form-input" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="VD: Đăng bài hàng ngày" />
            </div>

            <div className="form-group">
              <label className="form-label">Facebook Page *</label>
              <select className="form-select" value={form.pageId}
                onChange={e => setForm({ ...form, pageId: e.target.value })}>
                <option value="">Chọn trang...</option>
                {pages.map((p: any) => <option key={p.id} value={p.id}>{p.pageName}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Tần suất *</label>
              <select className="form-select" value={form.frequency}
                onChange={e => setForm({ ...form, frequency: e.target.value })}>
                <option value="ONCE">Một lần</option>
                <option value="DAILY">Hàng ngày</option>
                <option value="WEEKLY">Hàng tuần</option>
                <option value="MONTHLY">Hàng tháng</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Bắt đầu từ * <small style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>(giờ Việt Nam; lịch lặp lại giữ đúng giờ này)</small></label>
              <input className="form-input" type="datetime-local" value={form.startDate}
                onChange={e => setForm({ ...form, startDate: e.target.value })} />
            </div>

            <div className="form-group">
              <label className="form-label">Ý tưởng / chủ đề cho AI *</label>
              <textarea className="form-textarea" rows={3} value={form.idea}
                placeholder="VD: Mỗi lần chạy, chọn một thủ thuật AI giúp dân văn phòng xử lý email nhanh hơn"
                onChange={e => setForm({ ...form, idea: e.target.value })} />
              <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', marginTop: 6 }}>
                Mỗi lần chạy, AI viết bài mới từ ý tưởng này theo System prompt trong Cài đặt.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Hủy</button>
              <button className="btn btn-primary" onClick={handleCreate}
                disabled={!form.name || !form.pageId || !form.startDate}>
                Tạo lịch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
