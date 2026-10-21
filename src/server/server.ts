import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserError } from '../lib/errors.js';
import { type ReviewSession, SessionError } from '../review/session.js';
import type { ImageKind } from '../review/view.js';

export interface ServerOptions {
  /** Page served at "/". */
  html: string;
  /** 0 or undefined picks a free port. */
  port?: number;
}

export interface RunningServer {
  /** Address to open, including the access token. */
  url: string;
  port: number;
  token: string;
  /** Resolves when the page asks to finish. */
  finished: Promise<void>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const IMAGE_KINDS = new Set<string>(['expected', 'actual', 'diff']);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Serves the review page and its API on 127.0.0.1 only. Every API call needs
 * the random token: as a header for actions (so other web pages cannot send
 * them), or in the query string for images.
 */
export async function startServer(session: ReviewSession, options: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(16).toString('hex');
  let port = options.port ?? 0;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Refuse requests that reach us under another host name (DNS rebinding).
    if (req.headers.host !== `${HOST}:${port}` && req.headers.host !== `localhost:${port}`) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      res.end(options.html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const headerToken = req.headers['x-rebaseline-token'];
    const authorized = headerToken === token || (method === 'GET' && url.searchParams.get('token') === token);
    if (!authorized) {
      sendJson(res, 401, { error: 'Missing or wrong access token. Open the address printed in the terminal.' });
      return;
    }

    const parts = url.pathname.split('/').slice(2).map((p) => decodeURIComponent(p));

    if (method === 'GET' && parts.length === 1 && parts[0] === 'state') {
      sendJson(res, 200, session.view());
      return;
    }

    if (method === 'GET' && parts.length === 3 && parts[0] === 'image' && IMAGE_KINDS.has(parts[2] ?? '')) {
      const file = session.imagePath(parts[1] ?? '', parts[2] as ImageKind);
      if (!file) {
        sendJson(res, 404, { error: 'Image not found' });
        return;
      }
      // Report images never change during a review, so the page may keep them.
      res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/png' });
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'shots' && (parts[2] === 'accept' || parts[2] === 'reject')) {
      try {
        const id = parts[1] ?? '';
        sendJson(res, 200, parts[2] === 'accept' ? await session.accept(id) : await session.reject(id));
      } catch (err) {
        if (err instanceof SessionError) sendJson(res, err.status, { error: err.message });
        else throw err;
      }
      return;
    }

    if (method === 'POST' && parts.length === 1 && parts[0] === 'done') {
      sendJson(res, 200, { ok: true });
      finish();
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new UserError(`Port ${port} is already in use`, 'Use another --port, or leave it out to pick a free one.'));
      } else if (err.code === 'EACCES') {
        reject(new UserError(`Not allowed to use port ${port}`, 'Use a port above 1024, or leave --port out.'));
      } else {
        reject(err);
      }
    });
    server.listen(port, HOST, () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    token,
    finished,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
