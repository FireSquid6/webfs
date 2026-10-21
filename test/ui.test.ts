import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../src/server/http';
import { parseConfig } from '../src/server/config';

describe('online frontend delivery', () => {
  test('serves entry page, manifest and network-only service worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'files-ui-'));
    try {
      const fetch = handler(await parseConfig({ root }));
      const get = (route: string) => fetch(new Request(`http://localhost${route}`));
      const page = await get('/');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('/assets/index.js');
      const manifest = await get('/manifest.webmanifest');
      expect((await manifest.json()).display).toBe('standalone');
      const worker = await get('/sw.js');
      const source = await worker.text();
      expect(source).toContain('fetch(event.request)');
      expect(source).not.toContain('caches.');
      const icon = await get('/icon.svg');
      expect(icon.headers.get('Content-Type')).toBe('image/svg+xml');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
