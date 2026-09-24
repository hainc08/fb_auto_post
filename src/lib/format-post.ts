/**
 * Deterministic layout clean-up for AI-written Facebook posts.
 *
 * Facebook renders plain text only, and posts are mostly read on phones, so:
 *  - one blank line between paragraphs (list items stay together)
 *  - no Markdown (**bold**, # headings); "-"/"*" bullets become "•"
 *  - the "Prompt mẫu" block is framed by ━ separator lines, each on its own line
 *  - trailing hashtags are split off so they can go on the last line
 *
 * It only fixes layout; it never rewrites words.
 */

export const SEPARATOR = '━━━━━━━━━━━━━━';

const SEPARATOR_LINE = /^[━─═=_-]{5,}$/;
const LIST_ITEM = /^(•|\d+[.)]|[①-⑩]|[1-9]️⃣)\s*/u;
const MARKDOWN_BULLET = /^[-*+]\s+/;
const MARKDOWN_HEADING = /^#{1,6}\s+/;
const PROMPT_LABEL = /^(?:📋\s*)?\**prompt mẫu\**\s*:?\s*(.*)$/iu;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const TRAILING_HASHTAGS = /(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;

type Block = { kind: 'para' | 'label' | 'prompt' | 'group'; lines: string[] };

export function formatPostText(input: string): string {
  const lines = input
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .map((l) => l.replace(MARKDOWN_HEADING, ''))
    .map((l) => l.replace(MARKDOWN_BULLET, '• ').replace(/^(\s*)•\s+/, '$1• '));

  const blocks: Block[] = [];
  let current: Block | null = null;
  let inPrompt = false;
  /** Prompt closed by a ━ line (framed) or, without separators, by the first blank line */
  let promptFramed = false;

  const flush = () => {
    if (current && current.lines.length) blocks.push(current);
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim() === '' ? '' : raw;

    // Normalise "Prompt mẫu:" label (text after the colon moves to the next line)
    const label = line.trim().match(PROMPT_LABEL);
    if (label && !inPrompt) {
      flush();
      blocks.push({ kind: 'label', lines: ['📋 Prompt mẫu:'] });
      promptFramed = lines.slice(index + 1).some((l) => SEPARATOR_LINE.test(l.trim()));
      current = { kind: promptFramed ? 'prompt' : 'group', lines: [] };
      inPrompt = true;
      if (label[1]) current.lines.push(label[1]);
      continue;
    }

    if (SEPARATOR_LINE.test(line.trim())) {
      if (inPrompt && current?.kind === 'prompt' && current.lines.some((l) => l.trim())) {
        // closing separator
        flush();
        inPrompt = false;
      }
      // opening separator (or a stray one): dropped, re-added when rendering the prompt block
      continue;
    }

    if (inPrompt) {
      if (!promptFramed && line === '' && current!.lines.length > 0) {
        // Unframed prompt ends at the first blank line
        flush();
        inPrompt = false;
        continue;
      }
      // Inside the prompt keep the author's line breaks
      if (line !== '' || current!.lines.length > 0) current!.lines.push(line);
      continue;
    }

    if (line === '') {
      flush();
      continue;
    }

    const prev: string | undefined = current?.lines[current.lines.length - 1];
    const keepTogether = prev !== undefined && LIST_ITEM.test(line.trim()) && (LIST_ITEM.test(prev.trim()) || prev.trim().endsWith(':'));
    if (!keepTogether) flush();
    if (!current) current = { kind: 'para', lines: [] };
    current.lines.push(line.trim());
  }
  flush();

  const render = (b: Block) => {
    const body = trimBlankEdges(b.lines).join('\n');
    return b.kind === 'prompt' ? `${SEPARATOR}\n${body.replace(/\n{3,}/g, '\n\n')}\n${SEPARATOR}` : body;
  };

  // The "📋 Prompt mẫu:" label sits directly above its prompt (no blank line in between)
  return blocks
    .map((b, i) => (i === 0 ? '' : blocks[i - 1].kind === 'label' ? '\n' : '\n\n') + render(b))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split hashtags at the very end of the post (e.g. "…câu hỏi? #A #B") from the body.
 * Hashtags used inside sentences are left alone.
 */
export function splitTrailingHashtags(text: string): { body: string; hashtags: string[] } {
  const match = text.match(TRAILING_HASHTAGS);
  if (!match) return { body: text.trim(), hashtags: [] };

  const hashtags = [...new Set((match[0].match(HASHTAG) ?? []).map((h) => h.slice(1)))];
  return { body: text.slice(0, match.index).trim(), hashtags };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}
