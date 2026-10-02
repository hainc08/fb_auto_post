/** Karaoke subtitles for a Reel: pure text work, no I/O (tested from tests/reel-subtitles.test.ts). */

export interface ReelWord {
  text: string;
  /** From the start of the audio */
  startMs: number;
  durationMs: number;
}

const MAX_WORDS_PER_LINE = 4;
const MAX_CHARS_PER_LINE = 24;
/** The last line stays this long after its last word */
const TAIL_MS = 400;
/** A token the voice reads has at least one letter or digit */
const SPOKEN = /[\p{L}\p{N}]/u;

const spokenTokens = (script: string) => script.split(/\s+/).filter((t) => SPOKEN.test(t));

export const countSpokenWords = (script: string) => spokenTokens(script).length;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * What to show for each spoken word. The voice service drops punctuation and case,
 * so the script's own words are used when there is exactly one per mark; otherwise
 * (symbols read aloud, numbers split…) the words the service reports are shown.
 */
export function displayWords(script: string, words: ReelWord[]): ReelWord[] {
  const tokens = spokenTokens(script);
  const exact = tokens.length === words.length;
  return words.map((w, i) => ({ ...w, text: exact ? tokens[i] : unescapeXml(w.text) }));
}

/** Short lines: a sentence end closes the line; a comma closes it once it has two words. */
export function buildLines(words: ReelWord[]): ReelWord[][] {
  const lines: ReelWord[][] = [];
  let line: ReelWord[] = [];
  const flush = () => {
    if (line.length) lines.push(line);
    line = [];
  };
  for (const w of words) {
    const length = line.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (line.length >= MAX_WORDS_PER_LINE || (line.length > 0 && length > MAX_CHARS_PER_LINE)) flush();
    line.push(w);
    if (/[.!?…]["')\]]?$/.test(w.text) || (/[,;:]$/.test(w.text) && line.length >= 2)) flush();
  }
  flush();
  return lines;
}

/** Milliseconds → ASS time "H:MM:SS.cc" */
function assTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360_000)}:${two(Math.floor(cs / 6000) % 60)}:${two(Math.floor(cs / 100) % 60)}.${two(cs % 100)}`;
}

/** `{`, `}` and `\` are syntax in ASS */
const plain = (text: string) => text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ');

/**
 * 1080×1920 karaoke subtitles: a word turns yellow when it is spoken.
 * With a picture the text sits under it; without one it is centred.
 */
export function buildAss(lines: ReelWord[][], opts: { withImage: boolean; font?: string }): string {
  const events = lines.map((line, i) => {
    const start = line[0].startMs;
    const last = line[line.length - 1];
    const end = lines[i + 1] ? lines[i + 1][0].startMs : last.startMs + last.durationMs + TAIL_MS;
    let cursor = start;
    const text = line
      .map((w, j) => {
        const next = line[j + 1]?.startMs ?? end;
        const k = Math.max(1, Math.round((next - cursor) / 10));
        cursor = next;
        return `{\\k${k}}${plain(w.text)}`;
      })
      .join(' ');
    return `Dialogue: 0,${assTime(start)},${assTime(end)},K,,0,0,0,,${text}`;
  });
  // Colours are &HAABBGGRR: sung = yellow, not yet sung = white, dark outline
  const style = `Style: K,${opts.font ?? 'Arial'},78,&H0000E5FF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,${opts.withImage ? '2,80,80,430' : '5,80,80,0'},1`;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
