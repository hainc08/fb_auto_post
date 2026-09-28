import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export async function startTestServer(app: Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ApiOptions {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Call the API like the browser client does (CSRF header on by default). */
export async function api(baseUrl: string, method: string, path: string, opts: ApiOptions = {}) {
  const headers: Record<string, string> = {
    'X-Requested-With': 'autopost',
    ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
    ...(opts.cookie && { Cookie: opts.cookie }),
    ...opts.headers,
  };
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}
