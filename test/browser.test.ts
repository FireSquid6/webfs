import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { parseConfig } from '../src/server/config';
import { handler } from '../src/server/http';

let root: string;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [path.resolve('src/client/index.tsx')], outdir: path.resolve('dist/assets'), target: 'browser' });
  if (!built.success) throw new Error(built.logs.map(log => String(log)).join('\n'));
  root = await mkdtemp(path.join(os.tmpdir(), 'files-browser-'));
  await mkdir(path.join(root, '.trash'));
  await writeFile(path.join(root, 'note.md'), '# Original');
  await writeFile(path.join(root, 'source.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(path.join(root, 'source.pdf'), 'plain UTF-8 text in a PDF-named file');
  await writeFile(path.join(root, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/OX8AAAAASUVORK5CYII=', 'base64'));
  await writeFile(path.join(root, 'large.png'), Buffer.alloc(1600, 0xff));
  await symlink('large.png', path.join(root, 'small-link.png'));
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler(await parseConfig({ root, trash: '.trash', limits: { edit: 1024, preview: 1500, upload: 100 } })) });
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(); if (root) await rm(root, { recursive: true, force: true }); });

test('browser: draft remount, text media, binary preview, symlink limit, upload loading and trash names', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  try {
    await page.addInitScript(() => localStorage.setItem('files.vim', 'false'));
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/config', async route => { await paused; await route.continue(); });
    await page.goto(server.url.toString());
    const upload = page.getByRole('button', { name: 'Upload files' });
    await upload.waitFor();
    expect(await upload.isDisabled()).toBe(true);
    expect(await page.locator('input[type=file]').getAttribute('tabindex')).toBe('-1');
    release();
    await page.getByRole('button', { name: 'Trash', exact: true }).waitFor();
    expect(await upload.isEnabled()).toBe(true);
    const chooserPromise = page.waitForEvent('filechooser');
    await upload.focus();
    await page.keyboard.press('Enter');
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded') });
    await page.getByRole('button', { name: 'uploaded.txt', exact: true }).waitFor();

    await page.getByRole('button', { name: 'note.md', exact: true }).click();
    await page.locator('.cm-content').fill('# Unsaved');
    await page.getByRole('button', { name: 'Preview Markdown' }).click();
    expect(await page.locator('.markdown').innerText()).toContain('Unsaved');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    expect(await page.locator('.cm-content').innerText()).toBe('# Unsaved');
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+z');
    expect(await page.locator('.cm-content').innerText()).toBe('# Original');
    await page.keyboard.press('Control+Shift+z');
    expect(await page.locator('.cm-content').innerText()).toBe('# Unsaved');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.notice').filter({ hasText: 'Saved.' }).waitFor();
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# Unsaved');
    await page.getByRole('button', { name: 'Back to folder' }).click();

    for (const filename of ['source.svg', 'source.pdf']) {
      await page.getByRole('button', { name: filename, exact: true }).click();
      await page.locator('.cm-content').waitFor();
      expect(await page.getByRole('button', { name: 'Preview saved file' }).count()).toBe(1);
      if (filename === 'source.svg') {
        await page.getByRole('button', { name: 'Preview saved file' }).click();
        await page.locator('img.image-preview').waitFor();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.cm-content').waitFor();
      }
      await page.getByRole('button', { name: 'Back to folder' }).click();
    }
    await page.getByRole('button', { name: 'picture.png', exact: true }).click();
    await page.locator('img.image-preview').waitFor();
    expect(await page.locator('img.image-preview').count()).toBe(1);
    await page.getByRole('button', { name: 'Back to folder' }).click();
    await page.getByRole('button', { name: 'small-link.png', exact: true }).click();
    await page.locator('.notice').filter({ hasText: 'Preview limit' }).waitFor();
    expect(await page.getByRole('alert').first().innerText()).toContain('Preview limit');
    expect(await page.locator('img.image-preview').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'Download', exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Back to folder' }).click();

    await page.getByRole('button', { name: 'Delete note.md' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete note.md' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await page.getByRole('button', { name: 'Restore note.md' }).waitFor();
    expect(await page.getByRole('button', { name: 'Restore note.md' }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Permanently delete note.md' }).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); }
}, 30000);
