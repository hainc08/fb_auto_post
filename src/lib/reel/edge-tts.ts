import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ReelWord } from './subtitles';

/**
 * Microsoft Edge "read aloud" text-to-speech: MP3 audio plus a time mark for every word.
 * Unofficial endpoint (no contract): it can change or be blocked at any time, so callers
 * treat every failure as "voice service unavailable". Protocol ported from the Python
 * `edge-tts` project. Other providers can replace `edgeTts` with the same `synthesize`.
 */

export const EDGE_VOICES = ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'] as const;
export type EdgeVoice = (typeof EDGE_VOICES)[number];

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0];
const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TIMEOUT_MS = 60_000;
/** Seconds between 1601-01-01 and 1970-01-01 */
const WINDOWS_EPOCH_S = 11_644_473_600;

/** Token the service expects: SHA-256 of the current 5-minute Windows tick + the client token */
export function secMsGec(nowMs = Date.now()): string {
  let seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_S;
  seconds -= seconds % 300;
  // 100-nanosecond ticks: seconds × 10^7
  return createHash('sha256').update(`${seconds}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSsml(text: string, voice: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
  );
}

/** The service counts in 100-nanosecond ticks */
export function parseWordMarks(json: string): ReelWord[] {
  const marks: Array<{ Type: string; Data: { Offset: number; Duration: number; text: { Text: string } } }> = JSON.parse(json).Metadata ?? [];
  return marks
    .filter((m) => m.Type === 'WordBoundary')
    .map((m) => ({ text: m.Data.text.Text, startMs: m.Data.Offset / 10_000, durationMs: m.Data.Duration / 10_000 }));
}

/** "Fri Oct 02 2026 05:00:00 GMT+0000 (Coordinated Universal Time)" */
const jsDate = () =>
  new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
const hexId = () => randomUUID().replace(/-/g, '');

function synthesize(text: string, voice: EdgeVoice): Promise<{ audio: Buffer; words: ReelWord[] }> {
  return new Promise((resolve, reject) => {
    const url = `${ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${hexId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });
    const audio: Buffer[] = [];
    const words: ReelWord[] = [];
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(new Error(error));
      else resolve({ audio: Buffer.concat(audio), words });
    };
    const timer = setTimeout(() => finish('Dịch vụ giọng đọc không phản hồi (quá 60 giây).'), TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      );
      // The trailing "Z" after the timestamp is what the Edge browser sends
      ws.send(`X-RequestId:${hexId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${buildSsml(text, voice)}`);
    });
    ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
      try {
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (isBinary) {
          // 2-byte big-endian header length, the headers, then audio bytes
          const headerLength = data.readUInt16BE(0);
          if (data.subarray(2, 2 + headerLength).toString().includes('Path:audio')) audio.push(data.subarray(2 + headerLength));
          return;
        }
        const message = data.toString();
        const split = message.indexOf('\r\n\r\n');
        const headers = message.slice(0, split);
        if (headers.includes('Path:audio.metadata')) words.push(...parseWordMarks(message.slice(split + 4)));
        else if (headers.includes('Path:turn.end')) finish(audio.length ? undefined : 'Dịch vụ giọng đọc không trả về âm thanh.');
      } catch {
        finish('Dịch vụ giọng đọc trả về dữ liệu không đọc được.');
      }
    });
    ws.on('unexpected-response', (_req, res) => finish(`Dịch vụ giọng đọc từ chối kết nối (HTTP ${res.statusCode}).`));
    ws.on('error', () => finish('Không kết nối được dịch vụ giọng đọc.'));
    ws.on('close', () => finish('Dịch vụ giọng đọc ngắt kết nối giữa chừng.'));
  });
}

/** An object, so tests (and other providers) replace `synthesize` */
export const edgeTts = { synthesize };
