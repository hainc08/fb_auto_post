import { useEffect, useRef, useState } from 'react';
import { Clapperboard, ImagePlus, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { postsApi, assetUrl, MAX_UPLOAD_BYTES, REEL_VOICES, UPLOAD_TYPES, type ReelDraftView } from '../api';
import { useToast } from './Toast';

interface Props {
  postId: string;
  hasCaption: boolean;
  onClose: () => void;
  /** A render is queued or already running: the page follows it and reports the result, also after this dialog is closed */
  onStarted: () => void;
}

/** A scene being edited; `id` comes from the server once the scenes are saved */
interface Scene {
  id?: string;
  text: string;
  imagePrompt: string;
  imageUrl: string | null;
}

const MIN_WORDS = 5;
const MAX_CHARS = 1500;
const MAX_SCENES = 8;
/** Vietnamese read aloud: about 3 words a second */
const WORDS_PER_SECOND = 3;
const STAGE_LABEL = {
  voice: 'Bước 1/3 · Đang tạo giọng đọc…',
  render: 'Bước 2/3 · Đang dựng video…',
  saving: 'Bước 3/3 · Đang lưu…',
} as const;
const countWords = (s: string) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** Scenes (spoken text + picture) → voice + karaoke subtitles → the post's Reel. */
export default function ReelMaker({ postId, hasCaption, onClose, onStarted }: Props) {
  const toast = useToast();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [voice, setVoice] = useState<string>(REEL_VOICES[0].value);
  /** What is running: 'load', 'script', 'save', 'start', 'render', 'pictures', or 'scene:<index>' */
  const [busy, setBusy] = useState<string | null>('load');
  /** "AI viết kịch bản" replaces the scenes: asked twice when there are some */
  const [armed, setArmed] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** Step and percentage reported by the server while the Reel is made */
  const [progress, setProgress] = useState<{ stage: keyof typeof STAGE_LABEL; percent: number }>({ stage: 'voice', percent: 3 });
  const fileRef = useRef<HTMLInputElement>(null);
  /** Scene the file picker was opened for */
  const uploadFor = useRef<number | null>(null);

  const apply = (draft: ReelDraftView) => {
    setScenes(draft.scenes);
    setVoice(draft.voice);
  };

  useEffect(() => {
    postsApi
      .reelDraft(postId)
      .then((r) => apply(r.data))
      .catch((e) => toast.error(e.message))
      .finally(() => setBusy((b) => (b === 'load' ? null : b)));
    // A render started earlier (the tab was closed or reloaded) is picked up again
    postsApi
      .reelProgress(postId)
      .then((r) => {
        if (r.data.state !== 'queued' && r.data.state !== 'running') return;
        setBusy('render');
        onStarted();
      })
      .catch(() => {});
  }, [postId]);

  // Follow the job once a second until it is done or failed
  useEffect(() => {
    if (busy !== 'render') return;
    let stopped = false;
    const timer = setInterval(() => {
      postsApi
        .reelProgress(postId)
        .then(({ data }) => {
          if (stopped) return;
          if (data.state === 'done') {
            stopped = true; // the page announces the result and reloads the list
            setVideoUrl(assetUrl(data.video.videoUrl));
            setBusy(null);
          } else if (data.state === 'failed' || data.state === 'idle') {
            stopped = true;
            setBusy(null);
          } else {
            // never backwards: a late answer must not pull the bar back
            setProgress((p) => (data.percent >= p.percent ? { stage: data.stage, percent: data.percent } : p));
          }
        })
        .catch(() => {}); // a missed poll: the next one answers
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, postId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (!busy || busy === 'render') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  /** Run one action; the scenes are locked while it runs */
  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  }

  /** Save the scenes as they are on screen; the answer carries the ids pictures are attached to */
  async function persist(): Promise<ReelDraftView> {
    const res = await postsApi.saveReelDraft(postId, { voice, scenes: scenes.map((s) => ({ id: s.id, text: s.text, imagePrompt: s.imagePrompt })) });
    apply(res.data);
    return res.data;
  }

  const edit = (i: number, patch: Partial<Scene>) => setScenes((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  function writeScript() {
    if (scenes.some((s) => s.text.trim() || s.imageUrl) && !armed) return setArmed(true);
    setArmed(false);
    void act('script', async () => apply((await postsApi.reelScript(postId)).data));
  }

  const generate = (i: number) =>
    act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.generateSceneImage(postId, draft.scenes[i].id)).data);
    });

  /** One picture after another: each is a separate AI call of the member's quota */
  const generateMissing = () =>
    act('pictures', async () => {
      let draft = await persist();
      for (let i = 0; i < draft.scenes.length; i++) {
        if (draft.scenes[i].imageUrl || !draft.scenes[i].imagePrompt.trim()) continue;
        draft = (await postsApi.generateSceneImage(postId, draft.scenes[i].id)).data;
        apply(draft);
      }
    });

  function pickFile(i: number) {
    uploadFor.current = i;
    fileRef.current?.click();
  }

  function upload(file?: File) {
    const i = uploadFor.current;
    if (fileRef.current) fileRef.current.value = '';
    if (!file || i === null) return;
    if (!UPLOAD_TYPES.includes(file.type)) return toast.error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
    if (file.size > MAX_UPLOAD_BYTES) return toast.error('Ảnh vượt quá 8 MB.');
    void act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.uploadSceneImage(postId, draft.scenes[i].id, file)).data);
    });
  }

  const removePicture = (i: number) =>
    act(`scene:${i}`, async () => {
      const draft = await persist();
      apply((await postsApi.removeSceneImage(postId, draft.scenes[i].id)).data);
    });

  const render = () =>
    act('start', async () => {
      await persist();
      setProgress({ stage: 'voice', percent: 3 });
      await postsApi.makeReel(postId);
      setVideoUrl(null);
      onStarted();
      // only now: polling before the job is booked would read the previous Reel's "done"
      setBusy('render');
    });

  const script = scenes.map((s) => s.text.trim()).filter(Boolean).join(' ');
  const words = countWords(script);
  const seconds = Math.round(words / WORDS_PER_SECOND);
  const silent = scenes.findIndex((s) => countWords(s.text) === 0);
  const problem = !scenes.length
    ? 'Chưa có cảnh nào: bấm "AI viết kịch bản" hoặc "Thêm cảnh".'
    : silent !== -1 && scenes.length > 1
      ? `Cảnh ${silent + 1} chưa có lời đọc.`
      : script.length > MAX_CHARS
        ? `Kịch bản tối đa ${MAX_CHARS} ký tự (đang ${script.length}).`
        : words < MIN_WORDS
          ? `Kịch bản cần ít nhất ${MIN_WORDS} từ.`
          : seconds > 90
            ? 'Kịch bản quá dài: Reels tối đa 90 giây.'
            : null;
  const locked = !!busy;
  const missing = scenes.filter((s) => !s.imageUrl && s.imagePrompt.trim()).length;
  const closable = !busy || busy === 'render';

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && closable && onClose()}>
      <div className="modal-panel reel-maker" role="dialog" aria-modal="true" aria-labelledby="reel-title">
        <header className="modal-head">
          <div>
            <h2 id="reel-title">Tạo Reel từ bài</h2>
            <p className="field-hint" style={{ margin: 0 }}>Mỗi cảnh có lời đọc và ảnh riêng; ảnh đổi khi giọng đọc sang cảnh mới. Reel sẽ thay ảnh/video hiện tại của bài.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={!closable} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>

        <div className="member-body">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={writeScript} onBlur={() => setArmed(false)} disabled={locked || !hasCaption}>
              {busy === 'script' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />}
              {armed ? 'Bấm lần nữa: thay các cảnh hiện tại' : 'AI viết kịch bản từ bài'}
            </button>
            <label htmlFor="reel-voice" className="sr-only">Giọng đọc</label>
            <select id="reel-voice" className="form-select select-sm reel-voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={locked}>
              {REEL_VOICES.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
            <span className={`char-count ${problem && scenes.length ? 'over' : ''}`} style={{ marginLeft: 'auto' }}>{scenes.length} cảnh · {words} từ · ~{seconds} giây</span>
          </div>

          {busy === 'load' ? (
            <div className="loading-page" style={{ minHeight: 120 }}><div className="spinner spinner-lg" /></div>
          ) : (
            <ol className="reel-scenes">
              {scenes.map((s, i) => (
                <li key={s.id ?? `new-${i}`} className="reel-scene">
                  <div className="reel-scene-thumb">
                    {busy === `scene:${i}` ? <div className="spinner" /> : s.imageUrl ? <img src={assetUrl(s.imageUrl)!} alt={`Ảnh của cảnh ${i + 1}`} /> : <ImagePlus size={22} strokeWidth={1.6} aria-hidden="true" />}
                  </div>
                  <div className="reel-scene-body">
                    <div className="label-row">
                      <label htmlFor={`scene-text-${i}`} className="form-label">Cảnh {i + 1}</label>
                      <button type="button" className="link-btn" onClick={() => setScenes((list) => list.filter((_, j) => j !== i))} disabled={locked} aria-label={`Xoá cảnh ${i + 1}`}>
                        Xoá cảnh
                      </button>
                    </div>
                    <textarea
                      id={`scene-text-${i}`}
                      className="form-textarea"
                      rows={2}
                      value={s.text}
                      onChange={(e) => edit(i, { text: e.target.value })}
                      disabled={locked}
                      placeholder="Lời đọc của cảnh này, 1–2 câu"
                    />
                    <input
                      className="form-input"
                      aria-label={`Mô tả ảnh của cảnh ${i + 1} (tiếng Anh)`}
                      maxLength={1000}
                      value={s.imagePrompt}
                      onChange={(e) => edit(i, { imagePrompt: e.target.value })}
                      disabled={locked}
                      placeholder="Mô tả ảnh bằng tiếng Anh, VD: an office worker reading a long document at dusk"
                    />
                    <div className="row reel-scene-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void generate(i)} disabled={locked || !s.imagePrompt.trim()}>
                        <Sparkles size={14} aria-hidden="true" /> {s.imageUrl ? 'Tạo lại ảnh' : 'Tạo ảnh AI'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => pickFile(i)} disabled={locked}>
                        <Upload size={14} aria-hidden="true" /> Tải ảnh
                      </button>
                      {s.imageUrl && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removePicture(i)} disabled={locked} aria-label={`Bỏ ảnh của cảnh ${i + 1}`}>
                          <Trash2 size={14} aria-hidden="true" /> Bỏ ảnh
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />

          {busy !== 'load' && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setScenes((list) => [...list, { text: '', imagePrompt: '', imageUrl: null }])} disabled={locked || scenes.length >= MAX_SCENES}>
                <Plus size={14} aria-hidden="true" /> Thêm cảnh
              </button>
              {missing > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void generateMissing()} disabled={locked}>
                  {busy === 'pictures' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} Tạo ảnh cho {missing} cảnh chưa có
                </button>
              )}
            </div>
          )}
          <p className={problem && scenes.length ? 'field-warning' : 'field-hint'}>
            {problem ?? 'Cảnh chưa có ảnh riêng sẽ dùng ảnh của bài. Mỗi lần "Tạo ảnh AI" tốn một lượt tạo ảnh Cloudflare của bạn.'}
          </p>

          {busy === 'render' && (
            <div className="reel-progress">
              <div className="upload-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ dựng Reel">
                <span style={{ width: `${progress.percent}%` }} />
                <em>{progress.percent}%</em>
              </div>
              <p className="field-hint" role="status">
                {STAGE_LABEL[progress.stage]}
                {progress.stage === 'voice' ? ' Bước này lâu nhất (thường 5–30 giây) và không đo được phần trăm.' : ''} Bạn có thể đóng cửa sổ này; Reel vẫn được dựng tiếp.
              </p>
            </div>
          )}
          {videoUrl && busy !== 'render' && <video className="reel-preview" src={videoUrl} controls playsInline preload="metadata" />}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={!closable}>{videoUrl ? 'Xong' : 'Đóng'}</button>
          <button type="button" className="btn btn-primary" onClick={() => void render()} disabled={locked || !!problem}>
            {busy === 'start' || busy === 'render' ? <div className="spinner" /> : <Clapperboard size={16} aria-hidden="true" />}
            {videoUrl ? 'Dựng lại' : 'Dựng Reel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
