import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app';
import { startTestServer, api } from './helpers/http';

let server: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { server = await startTestServer(createApp()); });
afterAll(() => server.close());

describe('createApp', () => {
  it('serves the API index without touching the database', async () => {
    const res = await api(server.baseUrl, 'GET', '/api');
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('Auto Post Facebook API');
  });

  it('lets the Vite dev client (5173) send cookies', async () => {
    const res = await fetch(`${server.baseUrl}/api`, { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
