import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { buildSsml, parseWordMarks, secMsGec, synthesizeOnce, withRetries } from '../src/lib/reel/edge-tts';

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

describe('withRetries', () => {
  it('tries again when the service drops the connection, and returns the first success', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('ngắt')).mockResolvedValue('audio');
    expect(await withRetries(run, 3, 0)).toBe('audio');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt with the last reason', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('lần 1')).mockRejectedValueOnce(new Error('lần 2')).mockRejectedValue(new Error('lần 3'));
    await expect(withRetries(run, 3, 0)).rejects.toThrow('lần 3');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not try again when the failure is not worth retrying', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('từ chối'), { retryable: false }));
    await expect(withRetries(run, 3, 0, (e) => (e as { retryable?: boolean }).retryable === true)).rejects.toThrow('từ chối');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run again after a success', async () => {
    const run = vi.fn().mockResolvedValue('audio');
    await withRetries(run, 3, 0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('synthesizeOnce (against a local server, never the real service)', () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  /** A server on a free port; `onRequest` gets the socket once the config and the SSML have arrived */
  function serve(onRequest: (socket: import('ws').WebSocket, ssml: string) => void): Promise<string> {
    return new Promise((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => resolve(`ws://127.0.0.1:${(server!.address() as AddressInfo).port}/edge`));
      server.on('connection', (socket) => {
        const received: string[] = [];
        socket.on('message', (data) => {
          received.push(data.toString());
          if (received.length === 2) onRequest(socket, received[1]);
        });
      });
    });
  }
  const audioFrame = (bytes: string) => {
    const headers = Buffer.from('X-RequestId:x\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(headers.length);
    return Buffer.concat([length, headers, Buffer.from(bytes)]);
  };

  it('collects the audio and the word marks until the turn ends', async () => {
    let ssml = '';
    const url = await serve((socket, request) => {
      ssml = request;
      socket.send('X-RequestId:x\r\nPath:turn.start\r\n\r\n{}');
      socket.send(`X-RequestId:x\r\nPath:audio.metadata\r\n\r\n${JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: 1_000_000, Duration: 2_000_000, text: { Text: 'Giá' } } }] })}`);
      socket.send(audioFrame('AAA'));
      socket.send(audioFrame('BBB'));
      socket.send('X-RequestId:x\r\nPath:turn.end\r\n\r\n{}');
    });
    const result = await synthesizeOnce('Giá < 5', 'vi-VN-HoaiMyNeural', url);
    expect(result.audio.toString()).toBe('AAABBB');
    expect(result.words).toEqual([{ text: 'Giá', startMs: 100, durationMs: 200 }]);
    expect(ssml).toContain('Path:ssml');
    expect(ssml).toContain('Giá &lt; 5');
  });

  it('a dropped connection is a failure worth retrying', async () => {
    const url = await serve((socket) => socket.close());
    await expect(synthesizeOnce('Xin chào', 'vi-VN-HoaiMyNeural', url)).rejects.toMatchObject({ message: 'Dịch vụ giọng đọc ngắt kết nối giữa chừng.', retryable: true });
  });

  it('a turn with no audio is a failure, not worth retrying', async () => {
    const url = await serve((socket) => socket.send('X-RequestId:x\r\nPath:turn.end\r\n\r\n{}'));
    await expect(synthesizeOnce('Xin chào', 'vi-VN-HoaiMyNeural', url)).rejects.toMatchObject({ message: 'Dịch vụ giọng đọc không trả về âm thanh.', retryable: false });
  });
});

