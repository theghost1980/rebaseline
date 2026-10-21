import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StateView } from '../src/review/view.js';
import { type RunningServer, startServer } from '../src/server/server.js';
import { png } from './helpers.js';
import { makeSession } from './review-helpers.js';

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(port?: number) {
  const fixture = await makeSession();
  const server = await startServer(fixture.session, port === undefined ? { html: '<p>TEST PAGE</p>' } : { html: '<p>TEST PAGE</p>', port });
  running.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method: string, route: string, auth = true) =>
    fetch(`${base}${route}`, { method, headers: auth ? { 'x-rebaseline-token': server.token } : {} });
  return { ...fixture, server, base, call };
}

/** A raw request, to send a Host header that fetch() does not allow. */
function rawGet(port: number, route: string, host: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: route, headers: { host, 'x-rebaseline-token': token } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

describe('review server', () => {
  it('listens on 127.0.0.1 and prints an address with the token', async () => {
    const { server } = await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    expect(server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the page with a restrictive content security policy', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>TEST PAGE</p>');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('requires the token for the API', async () => {
    const { call, base, server } = await start();
    expect((await call('GET', '/api/state', false)).status).toBe(401);
    expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/state?token=${server.token}`)).status).toBe(200);
  });

  it('does not accept the token in the address for actions', async () => {
    const { base, server, id, root } = await start();
    const res = await fetch(`${base}/api/shots/${encodeURIComponent(id('hero'))}/accept?token=${server.token}`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(readFileSync(path.join(root, 'shots', 'hero.png'))).toEqual(png('hero old'));
  });

  it('refuses requests made under another host name', async () => {
    const { server } = await start();
    expect(await rawGet(server.port, '/api/state', `localhost:${server.port}`, server.token)).toBe(200);
    expect(await rawGet(server.port, '/api/state', `evil.example:${server.port}`, server.token)).toBe(403);
  });

  it('returns the review state', async () => {
    const { call } = await start();
    const state = (await (await call('GET', '/api/state')).json()) as StateView;
    expect(state.shots).toHaveLength(4);
    expect(state.others).toHaveLength(1);
  });

  it('serves screenshot images and nothing else', async () => {
    const { base, server, id } = await start();
    const image = await fetch(`${base}/api/image/${encodeURIComponent(id('hero'))}/actual?token=${server.token}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png('hero new'));
    expect((await fetch(`${base}/api/image/nope/actual?token=${server.token}`)).status).toBe(404);
    expect((await fetch(`${base}/api/image/${encodeURIComponent(id('hero'))}/secret?token=${server.token}`)).status).toBe(404);
    expect((await fetch(`${base}/api/image/..%2F..%2Fpackage.json/actual?token=${server.token}`)).status).toBe(404);
  });

  it('accepts and rejects screenshots', async () => {
    const { call, id, root } = await start();
    const file = path.join(root, 'shots', 'hero.png');
    const accepted = await call('POST', `/api/shots/${encodeURIComponent(id('hero'))}/accept`);
    expect(accepted.status).toBe(200);
    expect(readFileSync(file)).toEqual(png('hero new'));
    const rejected = await call('POST', `/api/shots/${encodeURIComponent(id('hero'))}/reject`);
    expect(((await rejected.json()) as { message: string }).message).toContain('Restored');
    expect(readFileSync(file)).toEqual(png('hero old'));
  });

  it('explains why a screenshot cannot be accepted', async () => {
    const { call, id } = await start();
    const res = await call('POST', `/api/shots/${encodeURIComponent(id('lost'))}/accept`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('cannot be accepted');
  });

  it('finishes when the page says it is done', async () => {
    const { call, server } = await start();
    let finished = false;
    void server.finished.then(() => {
      finished = true;
    });
    expect((await call('POST', '/api/done')).status).toBe(200);
    await server.finished;
    expect(finished).toBe(true);
  });

  it('explains when the port is taken', async () => {
    const { server } = await start();
    await expect(start(server.port)).rejects.toMatchObject({ name: 'UserError', message: `Port ${server.port} is already in use` });
  });
});
