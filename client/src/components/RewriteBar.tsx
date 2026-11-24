import { useState } from 'react';
import { Undo2, Wand2 } from 'lucide-react';
import { postsApi, type RewriteMode } from '../api';
import { useToast } from './Toast';

const QUICK_REWRITES = [
  { label: 'Hook mạnh hơn', instruction: 'Viết lại câu mở đầu thật gây tò mò, giữ nguyên ý chính và bố cục' },
  { label: 'Ngắn gọn hơn', instruction: 'Rút gọn còn khoảng một nửa, giữ ý quan trọng nhất' },
  { label: 'Thân thiện hơn', instruction: 'Đổi sang giọng thân thiện, gần gũi như nói chuyện với bạn bè, giữ bố cục' },
  { label: 'Chia đoạn dễ đọc', instruction: 'Chia thành các đoạn 1-2 câu, dễ đọc trên điện thoại, thêm emoji hợp lý' },
];

const INSTRUCTION_MAX = 500;

/**
 * "Viết lại bằng AI" under a caption editor: the member's own request, "Viết lại theo lĩnh vực" (the domain's writing
 * prompt + the post's format), quick rewrites, and "Hoàn tác" back through the versions before each rewrite.
 * Nothing is saved here: the result only replaces the draft.
 */
export default function RewriteBar(props: {
  postId: string | null;
  caption: string;
  onCaption: (caption: string) => void;
  /** Another action of the editor is running */
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  doneMessage: string;
}) {
  const { postId, caption, onCaption, disabled, onBusy, doneMessage } = props;
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // versions before each rewrite, kept for the post they belong to (another post starts empty)
  const [saved, setSaved] = useState<{ postId: string | null; list: string[] }>({ postId, list: [] });
  const history = saved.postId === postId ? saved.list : [];
  const setHistory = (next: (h: string[]) => string[]) =>
    setSaved((s) => ({ postId, list: next(s.postId === postId ? s.list : []) }));

  const hasText = caption.trim().length > 0;
  const off = !postId || !hasText || !!busy || !!disabled;

  async function run(key: string, mode: RewriteMode, text?: string) {
    if (off) return;
    setBusy(key);
    onBusy?.(true);
    const before = caption;
    try {
      const res = await postsApi.improve(postId!, { mode, instruction: text?.trim() || undefined, caption: before });
      setHistory((h) => [...h, before].slice(-10));
      onCaption(res.data.caption);
      if (key === 'ask') setInstruction('');
      toast.info(doneMessage);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
      onBusy?.(false);
    }
  }

  function undo() {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory((h) => h.slice(0, -1));
    onCaption(prev);
  }

  return (
    <div className="rewrite-bar">
      <div className="rewrite-ask">
        <input
          className="form-input"
          aria-label="Yêu cầu cho AI"
          maxLength={INSTRUCTION_MAX}
          value={instruction}
          disabled={!postId || !!busy || !!disabled}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && instruction.trim()) {
              e.preventDefault();
              void run('ask', 'instruction', instruction);
            }
          }}
          placeholder="Yêu cầu cho AI, VD: thêm đoạn ưu đãi cuối bài, xưng mình"
        />
        <button type="button" className="btn btn-secondary btn-sm" disabled={off || !instruction.trim()} onClick={() => run('ask', 'instruction', instruction)}>
          {busy === 'ask' ? <span className="spinner spinner-xs" /> : <Wand2 size={14} />} Viết lại
        </button>
      </div>
      <div className="quick-rewrites">
        <button type="button" className="chip-btn" disabled={off} onClick={() => run('domain', 'domain')} title="Viết lại cả bài theo Prompt viết bài của lĩnh vực và định dạng bài">
          {busy === 'domain' ? <span className="spinner spinner-xs" /> : null}
          Viết lại theo lĩnh vực
        </button>
        {QUICK_REWRITES.map((q) => (
          <button key={q.label} type="button" className="chip-btn" disabled={off} onClick={() => run(q.label, 'instruction', q.instruction)}>
            {busy === q.label ? <span className="spinner spinner-xs" /> : null}
            {q.label}
          </button>
        ))}
        {history.length > 0 && (
          <button type="button" className="chip-btn" disabled={!!busy || !!disabled} onClick={undo} title="Quay lại bản trước lần AI viết lại gần nhất">
            <Undo2 size={13} aria-hidden="true" /> Hoàn tác
          </button>
        )}
      </div>
    </div>
  );
}
