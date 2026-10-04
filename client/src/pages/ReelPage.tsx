import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clapperboard, ImagePlus, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { postsApi, assetUrl, MAX_UPLOAD_BYTES, REEL_VOICES, UPLOAD_TYPES, type ReelDraftView } from '../api';
import { useToast } from '../components/Toast';
import { postTitle } from '../components/PostBits';
import { reelWatch } from '../lib/reel-watch';

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

/** "Tạo Reel từ bài": scenes (spoken text + picture) → voice + karaoke subtitles → the post's Reel. */
export default function ReelPage() {
  const { id: postId = '' } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const back = `/posts?selected=${postId}`;
  const [post, setPost] = useState<{ caption: string | null } | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [voice, setVoice] = useState<string>(REEL_VOICES[0].value);
  /** What is running: 'load', 'script', 'save', 'start', 'render', 'pictures', or 'scene:<index>' */
  const [busy, setBusy] = useState<string | null>('load');
  /** The saved scenes could not be loaded: nothing may be edited (saving would replace them) */
  const [broken, setBroken] = useState(false);
  /** "AI viết kịch bản" replaces the scenes: asked twice when there are some */
  const [armed, setArmed] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** Step and percentage reported by the server while the Reel is made */
  const [progress, setProgress] = useState<{ stage: keyof typeof STAGE_LABEL; percent: number }>({ stage: 'voice', percent: 3 });
  /** Scenes or voice edited since they were last saved or loaded */
  const dirty = useRef(false);
  /** What is on screen, for the save that runs when the page is left */
  const latest = useRef({ voice, scenes });
  useEffect(() => {
    latest.current = { voice, scenes };
  });
  const fileRef = useRef<HTMLInputElement>(null);
  /** Scene the file picker was opened for */
  const uploadFor = useRef<number | null>(null);
  const runRef = useRef<HTMLDivElement>(null);

  const apply = (draft: ReelDraftView) => {
    setScenes(draft.scenes);
    setVoice(draft.voice);
    dirty.current = false;
  };

  /** Every edit of the scenes on screen goes through here, so leaving knows there is something to save */
  const change = (next: (list: Scene[]) => Scene[]) => {
    dirty.current = true;
    setScenes(next);
  };

  const draftBody = (d: { voice: string; scenes: Scene[] }) => ({ voice: d.voice, scenes: d.scenes.map((s) => ({ id: s.id, text: s.text, imagePrompt: s.imagePrompt })) });

  useEffect(() => {
    postsApi
      .get(postId)
      .then((r) => setPost(r.data))
      .catch(() => {
        toast.error('Không tìm thấy bài đăng.');
        navigate('/posts', { replace: true });
      });
    postsApi
      .reelDraft(postId)
      .then((r) => apply(r.data))
      .catch((e) => {
        setBroken(true);
        toast.error(`Chưa tải được kịch bản: ${e.message}`);
      })
      .finally(() => setBusy((b) => (b === 'load' ? null : b)));
    // A render started earlier (the tab was closed or reloaded) is picked up again
    postsApi
      .reelProgress(postId)
      .then((r) => {
        if (r.data.state === 'queued' || r.data.state === 'running') setBusy('render');
        else if (r.data.state === 'done') setVideoUrl(assetUrl(r.data.video.videoUrl));
      })
      .catch(() => {});
    // Leaving by the menu or the browser's back button: scenes typed but not saved yet are saved (nothing else saves them)
    return () => {
      if (dirty.current) void postsApi.saveReelDraft(postId, draftBody(latest.current)).catch(() => {});
    };
  }, [postId]);

  // Follow the job once a second until it is done or failed
  useEffect(() => {
    if (busy !== 'render') return;
    // if this page is left meanwhile, the Posts page announces the result
    reelWatch.set(postId);
    let stopped = false;
    const timer = setInterval(() => {
      postsApi
        .reelProgress(postId)
        .then(({ data }) => {
          if (stopped) return;
          if (data.state === 'queued' || data.state === 'running') {
            // never backwards: a late answer must not pull the bar back
            return setProgress((p) => (data.percent >= p.percent ? { stage: data.stage, percent: data.percent } : p));
          }
          stopped = true;
          reelWatch.set(null);
          setBusy(null);
          if (data.state === 'done') {
            setVideoUrl(assetUrl(data.video.videoUrl));
            toast.success('Đã dựng xong Reel — xem thử rồi duyệt đăng như bài thường.');
          } else if (data.state === 'failed') {
            toast.error(`Chưa dựng được Reel: ${data.error}`);
          }
        })
        .catch(() => {}); // a missed poll: the next one answers
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, postId]);

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
    const res = await postsApi.saveReelDraft(postId, draftBody({ voice, scenes }));
    apply(res.data);
    return res.data;
  }

  const edit = (i: number, patch: Partial<Scene>) => change((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

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
      // only now: polling before the job is booked would read the previous Reel's "done"
      setBusy('render');
      // phones: the bar and the video are above the scenes
      runRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

  const script = scenes.map((s) => s.text.trim()).filter(Boolean).join(' ');
  const words = countWords(script);
  const seconds = Math.round(words / WORDS_PER_SECOND);
  const silent = scenes.findIndex((s) => countWords(s.text) === 0);
  const problem = !scenes.length
    ? 'Chưa có cảnh nào: bấm "AI viết kịch bản từ bài" hoặc "Thêm cảnh".'
    : silent !== -1 && scenes.length > 1
      ? `Cảnh ${silent + 1} chưa có lời đọc.`
      : script.length > MAX_CHARS
        ? `Kịch bản tối đa ${MAX_CHARS} ký tự (đang ${script.length}).`
        : words < MIN_WORDS
          ? `Kịch bản cần ít nhất ${MIN_WORDS} từ.`
          : seconds > 90
            ? 'Kịch bản quá dài: Reels tối đa 90 giây.'
            : null;
  const locked = !!busy || broken;
  const missing = scenes.filter((s) => !s.imageUrl && s.imagePrompt.trim()).length;
  const rendering = busy === 'start' || busy === 'render';
  const renderButton = (
    <button type="button" className="btn btn-primary btn-block" onClick={() => void render()} disabled={locked || !!problem}>
      {rendering ? <div className="spinner" /> : <Clapperboard size={16} aria-hidden="true" />}
      {busy === 'render' ? `Đang dựng… ${progress.percent}%` : videoUrl ? 'Dựng lại' : 'Dựng Reel'}
    </button>
  );

  return (
    <div className="reel-page">
      <Link to={back} className="back-link">
        <ArrowLeft size={15} aria-hidden="true" /> Bài đăng
      </Link>
      <div className="page-header">
        <h1>Tạo Reel từ bài</h1>
        <p>
          {post?.caption ? `"${postTitle(post.caption)}" · ` : ''}Mỗi cảnh có lời đọc và ảnh riêng; ảnh đổi khi giọng đọc sang cảnh mới. Reel sẽ thay ảnh/video hiện tại của bài.
        </p>
      </div>

      <div className="reel-layout">
        <aside className="reel-side">
          <div className="card reel-tools">
            <button type="button" className="btn btn-secondary btn-block" onClick={writeScript} onBlur={() => setArmed(false)} disabled={locked || !post?.caption}>
              {busy === 'script' ? <div className="spinner" /> : <Sparkles size={15} aria-hidden="true" />}
              {armed ? 'Bấm lần nữa: thay các cảnh hiện tại' : 'AI viết kịch bản từ bài'}
            </button>
            <div>
              <label htmlFor="reel-voice" className="form-label">Giọng đọc</label>
              <select
                id="reel-voice"
                className="form-select"
                value={voice}
                onChange={(e) => {
                  dirty.current = true;
                  setVoice(e.target.value);
                }}
                disabled={locked}
              >
                {REEL_VOICES.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
            <p className={`char-count ${problem && scenes.length ? 'over' : ''}`}>{scenes.length} cảnh · {words} từ · ~{seconds} giây</p>
            {missing > 0 && (
              <button type="button" className="btn btn-secondary btn-block" onClick={() => void generateMissing()} disabled={locked}>
                {busy === 'pictures' ? <div className="spinner" /> : <Sparkles size={15} aria-hidden="true" />} Tạo ảnh cho {missing} cảnh chưa có
              </button>
            )}
          </div>

          <div className="card reel-run" ref={runRef}>
            <div className="reel-run-button">{renderButton}</div>
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
                  {progress.stage === 'voice' ? ' Bước này lâu nhất (thường 5–30 giây) và không đo được phần trăm.' : ''} Bạn có thể rời trang này; Reel vẫn được dựng tiếp.
                </p>
              </div>
            )}
            {videoUrl && busy !== 'render' && <video className="reel-preview" src={videoUrl} controls playsInline preload="metadata" />}
          </div>
        </aside>

        <section className="reel-main" aria-label="Các cảnh của Reel">
          {busy === 'load' ? (
            <div className="loading-page" style={{ minHeight: 160 }}><div className="spinner spinner-lg" /></div>
          ) : (
            <ol className="reel-scenes">
              {scenes.map((s, i) => (
                <li key={s.id ?? `new-${i}`} className="reel-scene">
                  <div className="reel-scene-thumb">
                    {busy === `scene:${i}` ? <div className="spinner" /> : s.imageUrl ? <img src={assetUrl(s.imageUrl)!} alt={`Ảnh của cảnh ${i + 1}`} /> : <ImagePlus size={26} strokeWidth={1.6} aria-hidden="true" />}
                  </div>
                  <div className="reel-scene-body">
                    <div className="label-row">
                      <label htmlFor={`scene-text-${i}`} className="form-label">Cảnh {i + 1}</label>
                      <button type="button" className="link-btn" onClick={() => change((list) => list.filter((_, j) => j !== i))} disabled={locked} aria-label={`Xoá cảnh ${i + 1}`}>
                        Xoá cảnh
                      </button>
                    </div>
                    <textarea
                      id={`scene-text-${i}`}
                      className="form-textarea"
                      rows={3}
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
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => change((list) => [...list, { text: '', imagePrompt: '', imageUrl: null }])} disabled={locked || scenes.length >= MAX_SCENES}>
              <Plus size={14} aria-hidden="true" /> Thêm cảnh
            </button>
          )}
        </section>
      </div>

      {/* Phones: the render button stays in reach under the scenes */}
      <div className="reel-bottom">{renderButton}</div>
    </div>
  );
}
