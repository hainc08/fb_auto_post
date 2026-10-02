import { describe, it, expect } from 'vitest';
import { buildSsml, parseWordMarks, secMsGec } from '../src/lib/reel/edge-tts';

describe('secMsGec', () => {
  it('is the SHA-256 of the 5-minute Windows tick and the client token', () => {
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 0, 0))).toBe('8FC162997CA89621B9336E90531CDB23EE4D0A96ECAF94FC19E673B3C7EE0B50');
  });

  it('changes every 5 minutes, not in between', () => {
    const at = secMsGec(Date.UTC(2026, 9, 3, 1, 0, 0));
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 4, 59))).toBe(at);
    expect(secMsGec(Date.UTC(2026, 9, 3, 1, 5, 0))).not.toBe(at);
  });
});

describe('buildSsml', () => {
  it('escapes the text', () => {
    const ssml = buildSsml('Giá < 5 & "rẻ" > tốt', 'vi-VN-HoaiMyNeural');
    expect(ssml).toContain("<voice name='vi-VN-HoaiMyNeural'>");
    expect(ssml).toContain('Giá &lt; 5 &amp; "rẻ" &gt; tốt');
  });
});

describe('parseWordMarks', () => {
  it('reads word marks in milliseconds and skips other marks', () => {
    const json = JSON.stringify({
      Metadata: [
        { Type: 'WordBoundary', Data: { Offset: 1_375_000, Duration: 2_000_000, text: { Text: 'Bạn' } } },
        { Type: 'SentenceBoundary', Data: { Offset: 0, Duration: 9, text: { Text: 'Bạn mất' } } },
        { Type: 'WordBoundary', Data: { Offset: 3_375_000, Duration: 1_875_000, text: { Text: 'mất' } } },
      ],
    });
    expect(parseWordMarks(json)).toEqual([
      { text: 'Bạn', startMs: 137.5, durationMs: 200 },
      { text: 'mất', startMs: 337.5, durationMs: 187.5 },
    ]);
  });

  it('returns nothing for a reply without marks', () => {
    expect(parseWordMarks('{}')).toEqual([]);
  });
});
