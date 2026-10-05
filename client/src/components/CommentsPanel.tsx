import { useEffect } from 'react';
import { X } from 'lucide-react';
import CommentsBoard from './CommentsBoard';

interface Props {
  postId: string;
  onClose: () => void;
  /** Counts changed (reply, handled, refresh): the list reloads */
  onChanged: () => void;
}

/** The comments of one post in a dialog (Posts page). The "Bình luận" page shows the same board inline. */
export default function CommentsPanel({ postId, onClose, onChanged }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel comments-panel" role="dialog" aria-modal="true" aria-labelledby="comments-title">
        <header className="modal-head">
          <h2 id="comments-title">Bình luận</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>
        <div className="comments-body">
          <CommentsBoard postId={postId} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}
