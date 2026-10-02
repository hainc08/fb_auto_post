import { useEffect, useState } from 'react';
import { Clapperboard, Sparkles, X } from 'lucide-react';
import { postsApi, assetUrl, REEL_VOICES } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string;
  /** Script and voice of the last Reel made for this post */
  initialScript?: string;
  initialVoice?: string;
  hasCaption: boolean;
  onClose: () => void;
  /** A Reel was made: the list and the preview reload */
  onDone: () => void;
}

const MIN_WORDS = 5;
const MAX_CHARS = 1500;
/** Vietnamese read aloud: about 3 words a second */
const WORDS_PER_SECOND = 3;
const countWords = (s: string) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** Script → voice + karaoke subtitles → the post's Reel. */
export default function ReelMaker({ postId, initialScript = '', initialVoice, hasCaption, onClose, onDone }: Props) {
  const toast = useToast();
  const [script, setScript] = useState(initialScript);
  const [voice, setVoice] = useState(initialVoice ?? REEL_VOICES[0].value);
  const [busy, setBusy] = useState<'script' | 'render' | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const words = countWords(script);
  const seconds = Math.round(words / WORDS_PER_SECOND);
  const problem =
    words < MIN_WORDS ? `Kịch bản cần ít nhất ${MIN_WORDS} từ.` : seconds > 90 ? 'Kịch bản quá dài: Reels tối đa 90 giây.' : null;

  async function writeScript() {
    setBusy('script');
    try {
      setScript((await postsApi.reelScript(postId)).data.script);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function render() {
    setBusy('render');
    try {
      const res = await postsApi.makeReel(postId, { script: script.trim(), voice });
      setVideoUrl(assetUrl(res.data.videoUrl));
      toast.success('Đã dựng xong Reel — xem thử rồi duyệt đăng như bài thường.');
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal-panel reel-maker" role="dialog" aria-modal="true" aria-labelledby="reel-title">
        <header className="modal-head">
          <div>
            <h2 id="reel-title">Tạo Reel từ bài</h2>
            <p className="field-hint" style={{ margin: 0 }}>Giọng đọc kịch bản, phụ đề chạy theo lời. Reel sẽ thay ảnh của bài.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={!!busy} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        <div className="member-body">
          <div className="label-row">
            <label htmlFor="reel-script" className="form-label">Kịch bản lời đọc</label>
            <span className={`char-count ${problem ? 'over' : ''}`}>{words} từ · ~{seconds} giây</span>
          </div>
          <textarea
            id="reel-script"
            className="form-textarea"
            rows={8}
            maxLength={MAX_CHARS}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={!!busy}
            placeholder="Nên 40–100 từ: một câu mở gây tò mò, một ý chính, một lời kêu gọi."
            aria-describedby="reel-script-hint"
          />
          <p id="reel-script-hint" className={problem && script ? 'field-warning' : 'field-hint'}>
            {problem && script ? problem : 'Viết số và ký hiệu như bình thường (15%, 10:30) — giọng đọc tự đọc được.'}
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={writeScript} disabled={!!busy || !hasCaption}>
              {busy === 'script' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} AI viết kịch bản từ bài
            </button>
            <label htmlFor="reel-voice" className="sr-only">Giọng đọc</label>
            <select id="reel-voice" className="form-select select-sm reel-voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!!busy}>
              {REEL_VOICES.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>

          {busy === 'render' && (
            <p className="field-hint" role="status">Đang tạo giọng đọc và dựng video… thường mất 20–60 giây, đừng đóng cửa sổ này.</p>
          )}
          {videoUrl && busy !== 'render' && <video className="reel-preview" src={videoUrl} controls playsInline preload="metadata" />}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={!!busy}>{videoUrl ? 'Xong' : 'Đóng'}</button>
          <button type="button" className="btn btn-primary" onClick={render} disabled={!!busy || !!problem}>
            {busy === 'render' ? <div className="spinner" /> : <Clapperboard size={16} aria-hidden="true" />}
            {videoUrl ? 'Dựng lại' : 'Dựng Reel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
