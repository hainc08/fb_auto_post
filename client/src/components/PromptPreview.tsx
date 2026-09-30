import { useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import { domainsApi, ApiError, type ContentFormat, type FormatPreview } from '../api';

interface Props {
  formats: ContentFormat[];
  /** Fixed format (Create Post); otherwise a select is shown */
  formatId?: string;
  pageId?: string;
  idea?: string;
  compact?: boolean;
}

/** "Xem prompt" (free) and "Thử viết" (1 Gemini call) for a format. */
export default function PromptPreview({ formats, formatId: fixedFormat, pageId, idea: fixedIdea, compact = false }: Props) {
  const [formatId, setFormatId] = useState(fixedFormat ?? formats.find((f) => f.isDefault)?.id ?? formats[0]?.id ?? '');
  const [idea, setIdea] = useState('');
  const [result, setResult] = useState<FormatPreview | null>(null);
  const [busy, setBusy] = useState<null | 'prompt' | 'write'>(null);
  const [error, setError] = useState<string | null>(null);
  const activeFormat = fixedFormat ?? formatId;
  const activeIdea = (fixedIdea ?? idea).trim();

  async function run(generate: boolean) {
    if (!activeFormat || !activeIdea) return setError('Nhập ý tưởng để xem prompt.');
    setBusy(generate ? 'write' : 'prompt');
    setError(null);
    try {
      setResult((await domainsApi.preview(activeFormat, { idea: activeIdea, pageId, generate })).data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không xem trước được.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`prompt-preview ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="prompt-preview-inputs">
          <label className="form-label" htmlFor="pp-idea">Ý tưởng thử</label>
          <input
            id="pp-idea"
            className="form-input"
            value={idea}
            maxLength={500}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="VD: Cách chào sếp buổi sáng"
          />
          {!fixedFormat && formats.length > 1 && (
            <select className="form-select" aria-label="Định dạng để thử" value={formatId} onChange={(e) => setFormatId(e.target.value)}>
              {formats.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="row prompt-preview-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(false)} disabled={!!busy}>
          {busy === 'prompt' ? <div className="spinner" /> : <Eye size={14} aria-hidden="true" />} Xem prompt
        </button>
        {!compact && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(true)} disabled={!!busy}>
            {busy === 'write' ? <div className="spinner" /> : <Sparkles size={14} aria-hidden="true" />} Thử viết
          </button>
        )}
        {!compact && <span className="field-hint prompt-cost">Thử viết dùng 1 lượt Gemini của bạn · không tạo bài</span>}
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {result && (
        <div className="prompt-result">
          <pre className="prompt-text" aria-label="Prompt gửi cho AI">{result.prompt}</pre>
          {result.post && (
            <div className="prompt-sample">
              <strong>Bài thử</strong>
              <p>{result.post}</p>
              {!!result.hashtags?.length && <p className="muted">{result.hashtags.map((h) => `#${h}`).join(' ')}</p>}
              {result.imagePrompt && <p className="muted mono">image_prompt: {result.imagePrompt}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
