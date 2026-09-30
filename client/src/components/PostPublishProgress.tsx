import { useState } from 'react';
import { Check, X, Loader } from 'lucide-react';
import { publishProgress, shortError, type TargetSummary } from '../lib/post-display';

/** "Đã đăng 4/4" / "3/4 thành công" with a per-Page popover on hover or click (multi-Page posts only). */
export default function PostPublishProgress({ targets }: { targets?: TargetSummary[] }) {
  const [open, setOpen] = useState(false);
  const progress = publishProgress(targets);
  if (!progress || !targets) return null;
  const withNames = targets.some((t) => t.page);

  return (
    <span className="publish-progress" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`progress-chip tone-${progress.tone}`}
        aria-expanded={withNames ? open : undefined}
        aria-label={`${progress.label}${withNames ? ' — xem từng Page' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onBlur={() => setOpen(false)}
      >
        {progress.label}
      </button>
      {open && withNames && (
        <span className="progress-popover" role="tooltip">
          {targets.map((t, i) => (
            <span key={t.page?.id ?? i} className={`progress-line status-${t.status.toLowerCase()}`} title={t.errorMessage ?? undefined}>
              {t.status === 'PUBLISHED' ? (
                <Check size={13} aria-hidden="true" />
              ) : t.status === 'FAILED' ? (
                <X size={13} aria-hidden="true" />
              ) : (
                <Loader size={13} aria-hidden="true" />
              )}
              <span className="progress-page">{t.page?.pageName ?? 'Page'}</span>
              {t.status === 'FAILED' && <span className="progress-error">{shortError(t.errorMessage)}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
