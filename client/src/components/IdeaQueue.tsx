import { useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Sparkles, Plus } from 'lucide-react';
import { schedulesApi, type ScheduleIdea } from '../api';
import { useToast } from './Toast';

interface Props {
  scheduleId: string;
  ideas: ScheduleIdea[];
  onChanged: () => void;
}

/** The ideas a schedule writes from: add (typed or AI-suggested), reorder, remove. */
export default function IdeaQueue({ scheduleId, ideas, onChanged }: Props) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [suggested, setSuggested] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'add' | 'suggest' | 'order'>(null);
  const queued = ideas.filter((i) => i.status === 'QUEUED');
  const used = ideas.filter((i) => i.status === 'USED');

  async function add(texts: string[]) {
    if (!texts.length) return;
    setBusy('add');
    try {
      const res = await schedulesApi.addIdeas(scheduleId, texts);
      toast.success(`Đã thêm ${res.data.added} ý tưởng.`);
      setDraft('');
      setSuggested((s) => s.filter((x) => !texts.includes(x)));
      setPicked([]);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy('suggest');
    try {
      const res = await schedulesApi.suggestIdeas(scheduleId);
      setSuggested(res.data.ideas);
      setPicked(res.data.ideas);
      if (!res.data.ideas.length) toast.info('AI chưa nghĩ ra ý mới, thử lại sau nhé.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function move(index: number, delta: -1 | 1) {
    const ids = queued.map((i) => i.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setBusy('order');
    try {
      await schedulesApi.orderIdeas(scheduleId, ids);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    try {
      await schedulesApi.removeIdea(scheduleId, id);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <section className="card idea-queue" aria-labelledby="idea-queue-title">
      <div className="idea-queue-head">
        <h2 id="idea-queue-title">
          Hàng chờ ý tưởng <span className="muted">({queued.length})</span>
        </h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={suggest} disabled={!!busy}>
          {busy === 'suggest' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} AI gợi ý 10 ý tưởng
        </button>
      </div>

      {suggested.length > 0 && (
        <div className="idea-suggestions">
          {suggested.map((s) => (
            <label key={s} className="check-item">
              <input type="checkbox" checked={picked.includes(s)} onChange={() => setPicked(picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s])} />
              {s}
            </label>
          ))}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => add(picked)} disabled={!picked.length || !!busy}>
            <Plus size={14} aria-hidden="true" /> Thêm {picked.length} ý đã chọn
          </button>
        </div>
      )}

      <ol className="idea-list">
        {queued.map((idea, i) => (
          <li key={idea.id}>
            <span className="idea-text">{idea.text}</span>
            <span className="idea-actions">
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Lên trên" disabled={i === 0 || !!busy} onClick={() => move(i, -1)}>
                <ArrowUp size={15} />
              </button>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Xuống dưới" disabled={i === queued.length - 1 || !!busy} onClick={() => move(i, 1)}>
                <ArrowDown size={15} />
              </button>
              <button type="button" className="btn btn-ghost btn-icon danger-hover" aria-label="Xoá ý tưởng" onClick={() => remove(idea.id)}>
                <Trash2 size={15} />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {queued.length === 0 && <p className="field-hint">Hàng chờ trống — lịch sẽ không viết thêm bài cho tới khi bạn thêm ý tưởng.</p>}

      <div className="idea-add">
        <textarea className="form-textarea" rows={2} value={draft} placeholder="Mỗi dòng một ý tưởng" aria-label="Thêm ý tưởng" onChange={(e) => setDraft(e.target.value)} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!draft.trim() || !!busy}
          onClick={() =>
            add(
              draft
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
            )
          }
        >
          <Plus size={14} aria-hidden="true" /> Thêm
        </button>
      </div>

      {used.length > 0 && (
        <details className="idea-used">
          <summary>Đã dùng ({used.length})</summary>
          <ul>
            {used.map((i) => (
              <li key={i.id}>{i.text}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
