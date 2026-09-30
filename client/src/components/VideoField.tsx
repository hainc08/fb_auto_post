import { useEffect, useRef, useState } from 'react';
import { Film, Upload, Trash2 } from 'lucide-react';
import { postsApi, assetUrl, ApiError, MAX_VIDEO_BYTES, VIDEO_TYPES, EMPTY_VIDEO, type VideoKind, type VideoState } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string | null;
  /** Create the post first when needed (Create Post page) */
  ensurePost?: () => Promise<string>;
  value: VideoState;
  onChange: (value: VideoState) => void;
  disabled?: boolean;
  /** Tells the parent an upload/removal is running, so it can hold publish and image changes */
  onBusyChange?: (busy: boolean) => void;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Upload a local video (≤ 100 MB), choose "Bài video" or "Reels", remove it. */
export default function VideoField({ postId, ensurePost, value, onChange, disabled, onBusyChange }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  async function pick(file?: File) {
    if (!file) return;
    if (!VIDEO_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ video MP4 hoặc MOV.');
    if (file.size > MAX_VIDEO_BYTES) return toast.error('Video vượt quá 100 MB.');
    setBusy(true);
    setProgress(0);
    try {
      const id = postId ?? (ensurePost ? await ensurePost() : null);
      if (!id) throw new Error('Chưa có bài để gắn video.');
      onChange(await postsApi.uploadVideo(id, file, setProgress));
      toast.success('Đã tải video lên — video sẽ được đăng thay cho ảnh.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Tải video lên thất bại.');
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function setKind(kind: VideoKind) {
    if (!postId || kind === value.videoKind) return;
    try {
      await postsApi.update(postId, { videoKind: kind });
      onChange({ ...value, videoKind: kind });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không đổi được kiểu đăng.');
    }
  }

  async function remove() {
    if (!postId) return;
    setBusy(true);
    try {
      await postsApi.removeVideo(postId);
      onChange(EMPTY_VIDEO);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Không bỏ được video.');
    } finally {
      setBusy(false);
    }
  }

  const input = <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" hidden onChange={(e) => pick(e.target.files?.[0])} />;
  const progressBar =
    progress !== null ? (
      <div className="upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ tải video">
        <span style={{ width: `${progress}%` }} />
        <em>{progress}%</em>
      </div>
    ) : null;

  if (!value.videoUrl) {
    return (
      <div className="video-field empty">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>
          {busy ? <div className="spinner" /> : <Upload size={14} aria-hidden="true" />} Tải video lên
        </button>
        <span className="field-hint">MP4/MOV, tối đa 100 MB. Video sẽ thay cho ảnh.</span>
        {progressBar}
        {input}
      </div>
    );
  }

  const meta = value.videoMeta;
  return (
    <div className="video-field">
      <video className="video-preview" src={assetUrl(value.videoUrl)!} controls preload="metadata" />
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        {meta && (
          <span className="muted video-meta">
            <Film size={13} aria-hidden="true" /> {mmss(meta.durationSec)} · {meta.width}×{meta.height} · {mb(meta.bytes)}
          </span>
        )}
        <div className="segmented" role="radiogroup" aria-label="Kiểu đăng video">
          <button
            type="button"
            role="radio"
            aria-checked={value.videoKind !== 'REEL'}
            className={value.videoKind !== 'REEL' ? 'active' : ''}
            onClick={() => setKind('FEED')}
            disabled={disabled}
          >
            Bài video
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value.videoKind === 'REEL'}
            className={value.videoKind === 'REEL' ? 'active' : ''}
            onClick={() => setKind('REEL')}
            disabled={disabled || !!value.reelsProblem}
            title={value.reelsProblem ?? 'Đăng dạng Reels'}
          >
            Reels
          </button>
        </div>
        {value.reelsProblem && <span className="field-hint">Không đăng Reels được: {value.reelsProblem}</span>}
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>
            <Upload size={14} aria-hidden="true" /> Đổi video
          </button>
          <button type="button" className="btn btn-secondary btn-sm danger-hover" onClick={remove} disabled={disabled || busy} aria-label="Bỏ video">
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
        {progressBar}
      </div>
      {input}
    </div>
  );
}
