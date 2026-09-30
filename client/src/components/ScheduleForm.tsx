import { useEffect, useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { schedulesApi, pagesApi, domainsApi, type ContentDomain, type PageInfo, type ScheduleSummary } from '../api';
import { useToast } from './Toast';
import { WEEKDAY_ORDER, WEEKDAY_SHORT } from './ScheduleBits';

interface Props {
  /** Editing an existing schedule; creating when absent */
  initial?: ScheduleSummary;
  onClose: () => void;
  onSaved: (s: ScheduleSummary) => void;
}

const todayVN = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
/** "2026-10-31" (Vietnam day) → ISO of 00:00 that day in Vietnam */
const dayStartIso = (day: string) => new Date(`${day}T00:00:00+07:00`).toISOString();
const isoToDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10) : '');

export default function ScheduleForm({ initial, onClose, onSaved }: Props) {
  const toast = useToast();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [domains, setDomains] = useState<ContentDomain[]>([]);
  const [name, setName] = useState(initial?.name ?? '');
  // Disconnected Pages are not listed, so they cannot stay selected (the API refuses them)
  const [pageIds, setPageIds] = useState<string[]>(initial?.pages.filter((p) => p.isActive).map((p) => p.id) ?? []);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [slots, setSlots] = useState<string[]>(initial?.slots ?? ['08:00']);
  const [bufferSize, setBufferSize] = useState(initial?.bufferSize ?? 3);
  const [domainId, setDomainId] = useState(initial?.domain?.id ?? '');
  const [formatId, setFormatId] = useState(initial?.format?.id ?? '');
  const [startDay, setStartDay] = useState(initial ? isoToDay(initial.startDate) : todayVN());
  const [endDay, setEndDay] = useState(isoToDay(initial?.endDate ?? null));
  const [ideasText, setIdeasText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([pagesApi.list(), domainsApi.list()])
      .then(([p, d]) => {
        setPages(p.data.filter((x: PageInfo) => x.isActive));
        setDomains(d.data.filter((x) => !x.isArchived));
      })
      .catch((e) => toast.error(e.message));
  }, []);

  const domain = domains.find((d) => d.id === domainId) ?? domains[0];
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        pageIds,
        weekdays,
        slots,
        bufferSize,
        startDate: dayStartIso(startDay || todayVN()),
        endDate: endDay ? dayStartIso(endDay) : null,
        ...(domain && { domainId: domain.id }),
        ...(formatId && { formatId }),
      };
      const res = initial
        ? await schedulesApi.update(initial.id, body)
        : await schedulesApi.create({
            ...body,
            ideas: ideasText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
          });
      toast.success(initial ? 'Đã lưu lịch.' : 'Đã tạo lịch — AI sẽ viết sẵn bài cho các khung giờ tới.');
      onSaved(res.data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const valid = !!name.trim() && pageIds.length > 0 && weekdays.length > 0 && slots.length > 0 && slots.every(Boolean);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel schedule-form" role="dialog" aria-modal="true" aria-labelledby="schedule-form-title">
        <header className="modal-head">
          <h2 id="schedule-form-title">{initial ? 'Sửa lịch đăng' : 'Tạo lịch đăng'}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        <div className="schedule-form-body">
          <div className="form-group">
            <label className="form-label" htmlFor="sf-name">Tên lịch</label>
            <input id="sf-name" className="form-input" value={name} maxLength={100} placeholder="VD: Mẹo nhà nông mỗi sáng" onChange={(e) => setName(e.target.value)} />
          </div>

          <fieldset className="form-group">
            <legend className="form-label">Đăng lên Page</legend>
            {pages.length === 0 && <p className="field-hint">Chưa có Page nào đang kết nối.</p>}
            <div className="check-list">
              {pages.map((p) => (
                <label key={p.id} className="check-item">
                  <input type="checkbox" checked={pageIds.includes(p.id)} onChange={() => setPageIds(toggle(pageIds, p.id))} />
                  {p.pageName}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group">
            <legend className="form-label">Ngày đăng trong tuần</legend>
            <div className="weekday-picker">
              {WEEKDAY_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip-btn ${weekdays.includes(d) ? 'active' : ''}`}
                  aria-pressed={weekdays.includes(d)}
                  onClick={() => setWeekdays(toggle(weekdays, d))}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group">
            <legend className="form-label">Khung giờ mỗi ngày (giờ Việt Nam, 1–3 khung)</legend>
            <div className="slot-list">
              {slots.map((s, i) => (
                <span key={i} className="slot-item">
                  <input
                    type="time"
                    className="form-input"
                    value={s}
                    aria-label={`Khung giờ ${i + 1}`}
                    onChange={(e) => setSlots(slots.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  {slots.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Bỏ khung giờ ${i + 1}`} onClick={() => setSlots(slots.filter((_, j) => j !== i))}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              ))}
              {slots.length < 3 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSlots([...slots, '19:30'])}>
                  <Plus size={14} /> Thêm khung giờ
                </button>
              )}
            </div>
          </fieldset>

          <div className="grid-2 schedule-form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="sf-domain">Lĩnh vực</label>
              <select
                id="sf-domain"
                className="form-select"
                value={domain?.id ?? ''}
                onChange={(e) => {
                  setDomainId(e.target.value);
                  setFormatId('');
                }}
              >
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-format">Định dạng bài</label>
              <select id="sf-format" className="form-select" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
                <option value="">Mặc định của lĩnh vực</option>
                {domain?.formats
                  ?.filter((f) => !f.isArchived)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {f.withImage ? '' : ' (chỉ chữ)'}
                    </option>
                  ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-buffer">Số bài AI viết sẵn</label>
              <input
                id="sf-buffer"
                type="number"
                min={1}
                max={7}
                className="form-input"
                value={bufferSize}
                onChange={(e) => setBufferSize(Math.min(7, Math.max(1, Number(e.target.value) || 1)))}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-start">Bắt đầu từ ngày</label>
              <input id="sf-start" type="date" className="form-input" value={startDay} onChange={(e) => setStartDay(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sf-end">Kết thúc (tuỳ chọn)</label>
              <input id="sf-end" type="date" className="form-input" value={endDay} onChange={(e) => setEndDay(e.target.value)} />
            </div>
          </div>

          {!initial && (
            <div className="form-group">
              <label className="form-label" htmlFor="sf-ideas">Ý tưởng ban đầu (mỗi dòng một ý, thêm sau cũng được)</label>
              <textarea
                id="sf-ideas"
                className="form-textarea"
                rows={4}
                value={ideasText}
                placeholder={'Cách tưới lúa tiết kiệm nước mùa khô\nNhận biết rầy nâu sớm'}
                onChange={(e) => setIdeasText(e.target.value)}
              />
            </div>
          )}
          <p className="field-hint">AI viết sẵn bài cho các khung giờ tới; bạn duyệt từng bài. Bài chưa duyệt kịp sẽ dời sang khung sau.</p>
        </div>

        <footer className="modal-foot">
          <span />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose}>Huỷ</button>
            <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>
              {saving ? <div className="spinner" /> : initial ? 'Lưu lịch' : 'Tạo lịch'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
