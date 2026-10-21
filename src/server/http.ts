import mime from 'mime';
import { ApiError, Files } from './files';
import type { Config } from './config';
import path from 'node:path';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const body = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const result: unknown = await request.json();
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new ApiError(400, 'INVALID_INPUT', 'Expected a JSON object');
};
const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${name} must be a string`);
  return value;
};

export function handler(config: Config): (request: Request) => Promise<Response> {
  const files = new Files(config);
  return async request => {
    try {
      const url = new URL(request.url);
      const route = url.pathname;
      const method = request.method;
      const p = () => string(url.searchParams.get('path'), 'path');
      if (method === 'GET' && (route === '/' || route === '/index.html')) return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#17324a"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/assets/index.css"><title>Files</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (method === 'GET' && route === '/manifest.webmanifest') return Response.json({ name: 'Files', short_name: 'Files', start_url: '/', display: 'standalone', theme_color: '#17324a', background_color: '#f5f7fa', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
      if (method === 'GET' && route === '/icon.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="22" fill="#17324a"/><path d="M20 42h38l11 12h39v43H20z" fill="#65d6c0"/></svg>', { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
      if (method === 'GET' && route === '/sw.js') return new Response("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));", { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
      if (method === 'GET' && /^\/assets\/[\w.-]+\.(js|css)$/.test(route)) {
        const file = Bun.file(path.resolve(import.meta.dir, '../../dist', route.slice(1)));
        if (await file.exists()) return new Response(file, { headers: { 'Content-Type': route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (route === '/api/config' && method === 'GET') return json({ limits: config.limits, trash: !!config.trash });
      if (route === '/api/list' && method === 'GET') return json(await files.list(p()));
      if (route === '/api/metadata' && method === 'GET') return json(await files.describe(p()));
      if (route === '/api/text' && method === 'GET') return json(await files.text(p()));
      if (route === '/api/text-preview' && method === 'GET') return json(await files.previewText(p()));
      if ((route === '/api/raw' || route === '/api/preview') && method === 'GET') {
        const { target, info } = await files.file(p(), route === '/api/preview' ? config.limits.preview : undefined);
        const type = mime.getType(target) ?? 'application/octet-stream';
        if (route === '/api/preview' && !(type === 'application/pdf' || type.startsWith('image/'))) {
          throw new ApiError(415, 'PREVIEW_UNSUPPORTED', 'Only images and PDFs can be previewed');
        }
        const filename = target.split('/').at(-1) ?? 'download';
        return new Response(Bun.file(target), { headers: {
          'Content-Type': type,
          'Content-Length': String(info.size),
          'Content-Disposition': `${route === '/api/raw' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
        } });
      }
      if (route === '/api/save' && method === 'PUT') {
        const data = await body(request);
        return json(await files.mutate(() => files.save(string(data.path, 'path'), string(data.content, 'content'), string(data.version, 'version'), data.overwrite === true)));
      }
      if (route === '/api/create' && method === 'POST') {
        const data = await body(request);
        return json(await files.mutate(() => files.create(string(data.path, 'path'), string(data.kind, 'kind') as 'file' | 'directory')), 201);
      }
      if (route === '/api/move' && method === 'POST') {
        const data = await body(request);
        return json(await files.mutate(() => files.move(string(data.source, 'source'), string(data.destination, 'destination'), data.overwrite === true)));
      }
      if (route === '/api/delete' && method === 'POST') {
        const data = await body(request);
        return json(await files.mutate(() => files.delete(string(data.path, 'path'), data.confirmed === true)));
      }
      if (route === '/api/upload' && method === 'POST') {
        const directory = p();
        const form = await request.formData();
        const uploaded = form.getAll('files');
        if (uploaded.some(item => !(item instanceof File))) throw new ApiError(400, 'INVALID_INPUT', 'files must be file parts');
        return json(await files.mutate(() => files.upload(directory, uploaded as File[], url.searchParams.get('overwrite') === 'true')), 201);
      }
      if (route === '/api/trash' && method === 'GET') return json(await files.trashList());
      const match = /^\/api\/trash\/([^/]+)\/(restore|purge)$/.exec(route);
      if (match && method === 'POST') {
        const data = await body(request);
        if (match[2] === 'restore') return json(await files.mutate(() => files.restore(match[1]!, data.destination === undefined ? undefined : string(data.destination, 'destination'))));
        return json(await files.mutate(() => files.purge(match[1]!, data.confirmed === true)));
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return json({ error: { code: 'NOT_FOUND', message: 'Path not found' } }, 404);
      if (code === 'EEXIST') return json({ error: { code: 'NAME_CONFLICT', message: 'Destination already exists' } }, 409);
      if (code === 'EACCES' || code === 'EPERM') return json({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }, 403);
      console.error(error);
      return json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
    }
  };
}

export function createServer(config: Config, hostname = '127.0.0.1') {
  return Bun.serve({ hostname, port: config.port, maxRequestBodySize: Math.max(config.limits.edit, config.limits.upload * 10 + 65536), fetch: handler(config) });
}
