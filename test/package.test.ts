import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

test('packaged Linux executables: native architecture runs independently with UI and API, other architecture is produced', async () => {
  const project = path.resolve(import.meta.dir, '..');
  const work = await mkdtemp(path.join(os.tmpdir(), 'files-package-'));
  let app: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(['bun', 'run', 'package'], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    if (code !== 0) throw new Error(`Packaging failed:\n${stdout}\n${stderr}`);

    if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error(`Unsupported test host architecture: ${process.arch}`);
    const nativeArch = process.arch;
    const otherArch = nativeArch === 'x64' ? 'arm64' : 'x64';
    const other = await readFile(path.join(project, `dist/files-linux-${otherArch}`));
    expect(other.subarray(0, 4).toString('hex')).toBe('7f454c46');
    expect(other.readUInt16LE(18)).toBe(otherArch === 'arm64' ? 183 : 62); // ELF AArch64 or x86-64

    const deploy = path.join(work, 'deploy');
    const elsewhere = path.join(work, 'elsewhere');
    await mkdir(deploy);
    await mkdir(elsewhere);
    await mkdir(path.join(work, 'data'));
    await writeFile(path.join(work, 'data', 'packaged.txt'), 'Hello from the packaged executable');
    const executable = path.join(deploy, 'files');
    await copyFile(path.join(project, `dist/files-linux-${nativeArch}`), executable);
    const port = await new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        listener.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('No port')));
      });
    });
    await writeFile(path.join(deploy, 'config.yaml'), `root: ../data\nport: ${port}\n`);
    app = Bun.spawn([executable, '--config', '../deploy/config.yaml'], { cwd: elsewhere, env: { PATH: '/nonexistent' }, stdout: 'pipe', stderr: 'pipe' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/list?path=`)).ok) { ready = true; break; } } catch { /* waiting for server */ }
      if (await Promise.race([app.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
    }
    if (!ready) {
      app.kill();
      await app.exited;
      throw new Error(`Executable did not start from unrelated working directory: ${await new Response(app.stderr as ReadableStream<Uint8Array>).text()}`);
    }
    const listing = await (await fetch(`${base}/api/list?path=`)).json() as { entries: { name: string }[] };
    expect(listing.entries.some(entry => entry.name === 'packaged.txt')).toBe(true);
    expect((await (await fetch(`${base}/api/config`)).json()).trash).toBe(false);
    for (const asset of ['index.js', 'index.css']) {
      const response = await fetch(`${base}/assets/${asset}`);
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ serviceWorkers: 'block' });
      await page.goto(base);
      await page.getByRole('button', { name: 'packaged.txt', exact: true }).waitFor();
      expect(await page.locator('header').evaluate(element => getComputedStyle(element).display)).toBe('flex');
      await page.getByRole('button', { name: 'packaged.txt', exact: true }).click();
      await page.locator('.cm-content').getByText('Hello from the packaged executable').waitFor();
      await page.close();
    } finally { await browser.close(); }
  } finally {
    app?.kill();
    if (app) await app.exited;
    await rm(work, { recursive: true, force: true });
  }
}, 120000);
