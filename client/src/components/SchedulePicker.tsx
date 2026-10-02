import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { MAX_AHEAD_DAYS, fromInputValue, inputProblem, suggestedTime, toInputValue } from '../lib/schedule-input';

interface Props {
  /** Time of a post that is already timed (ISO); without it the next full hour is suggested */
  initial?: string | null;
  busy?: boolean;
  /** The post cannot be timed right now (e.g. its text was emptied, or another action is running) */
  disabled?: boolean;
  confirmLabel?: string;
  onConfirm: (iso: string) => void;
  onCancel: () => void;
}

/** Date and time for "Hẹn giờ đăng" (Vietnam time); says why a time cannot be used. */
export default function SchedulePicker({ initial, busy = false, disabled = false, confirmLabel = 'Hẹn giờ đăng', onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(() => toInputValue(initial ? new Date(initial) : suggestedTime()));
  const now = new Date();
  const problem = inputProblem(value, now);

  return (
    <div className="timed-picker" role="group" aria-label="Hẹn giờ đăng">
      <label htmlFor="timed-at" className="form-label">Ngày giờ đăng</label>
      <input
        id="timed-at"
        type="datetime-local"
        className="form-input"
        value={value}
        min={toInputValue(now)}
        max={toInputValue(new Date(now.getTime() + MAX_AHEAD_DAYS * 86_400_000))}
        aria-invalid={!!problem}
        aria-describedby="timed-at-hint"
        onChange={(e) => setValue(e.target.value)}
      />
      <p id="timed-at-hint" className={problem ? 'field-warning' : 'field-hint'} role={problem ? 'alert' : undefined}>
        {problem ?? 'Giờ Việt Nam. Đến giờ bài tự đăng, không cần duyệt lại.'}
      </p>
      <div className="row timed-picker-actions">
        <button type="button" className="btn btn-primary" disabled={busy || disabled || !!problem} onClick={() => onConfirm(fromInputValue(value)!.toISOString())}>
          {busy ? <div className="spinner" /> : <CalendarClock size={16} aria-hidden="true" />} {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Thôi</button>
      </div>
    </div>
  );
}
