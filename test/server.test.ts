import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/server/config';
import { handler } from '../src/server/http';

let base: string, root: string, outside: string;
let api: ReturnType<typeof handler>;
const call = async (route: string, method = 'GET', payload?: object) => {
  const response = await api(new Request(`http://localhost${route}`, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }) }));
  return { status: response.status, data: await response.json() as any };
};
const query = (route: string, target: string) => `${route}?path=${encodeURIComponent(target)}`;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'filesystem-app-'));
  root = path.join(base, 'root'); outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside); await mkdir(path.join(root, '.trash'));
  api = handler(await parseConfig({ root, trash: '.trash', limits: { edit: 12, preview: 8, upload: 5 } }));
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe('confinement and symlinks', () => {
  test('rejects traversal, absolute paths, and direct trash access', async () => {
    for (const target of ['../outside/secret', '/etc/passwd', 'a/../b', '.trash', '.trash/item']) {
      expect((await call(query('/api/metadata', target))).status).toBeGreaterThanOrEqual(400);
    }
    expect((await call(query('/api/list', ''))).data.entries).toEqual([]);
  });
  test('shows external link but never reads it; can rename, move and trash link itself', async () => {
    await writeFile(path.join(outside, 'secret'), 'SECRET');
    await symlink(path.join(outside, 'secret'), path.join(root, 'link'));
    const meta = await call(query('/api/metadata', 'link'));
    expect(meta.data.kind).toBe('symlink'); expect(meta.data.link.outside).toBe(true);
    expect((await call(query('/api/raw', 'link'))).status).toBe(403);
    expect((await call('/api/move', 'POST', { source: 'link', destination: 'renamed' })).status).toBe(200);
    const removed = await call('/api/delete', 'POST', { path: 'renamed', confirmed: true });
    expect(removed.status).toBe(200);
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('SECRET');
    expect((await call('/api/trash')).data[0].kind).toBe('symlink');
  });
  test('rejects directory symlink to outside for create, browse, move destination and upload', async () => {
    await symlink(outside, path.join(root, 'escape'));
    expect((await call(query('/api/list', 'escape'))).status).toBe(403);
    expect((await call('/api/create', 'POST', { path: 'escape/new', kind: 'file' })).status).toBe(403);
    await writeFile(path.join(root, 'a'), 'a');
    expect((await call('/api/move', 'POST', { source: 'a', destination: 'escape/a' })).status).toBe(403);
    const form = new FormData(); form.append('files', new File(['x'], 'x'));
    expect((await api(new Request(`http://localhost${query('/api/upload', 'escape')}`, { method: 'POST', body: form }))).status).toBe(403);
    expect(await readdir(outside)).toEqual([]);
  });
  test('allows internal symlink browsing but not editing through the link', async () => {
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, 'folder', 'text'), 'hello');
    await symlink('folder', path.join(root, 'alias'));
    expect((await call(query('/api/list', 'alias'))).data.entries[0].path).toBe('alias/text');
    expect((await call(query('/api/text', 'alias/text'))).data.content).toBe('hello');
    await symlink('folder/text', path.join(root, 'file-link'));
    const version = (await call(query('/api/text', 'file-link'))).data.version;
    expect((await call('/api/save', 'PUT', { path: 'file-link', version, content: 'new' })).data.error.code).toBe('SYMLINK_WRITE');
  });
});

describe('conflicts and limits', () => {
  test('create, move and upload never silently replace names', async () => {
    await writeFile(path.join(root, 'a'), 'a'); await writeFile(path.join(root, 'b'), 'b');
    expect((await call('/api/create', 'POST', { path: 'a', kind: 'file' })).status).toBe(409);
    expect((await call('/api/move', 'POST', { source: 'a', destination: 'b' })).status).toBe(409);
    expect(await readFile(path.join(root, 'b'), 'utf8')).toBe('b');
    const form = new FormData(); form.append('files', new File(['z'], 'b'));
    expect((await api(new Request(`http://localhost${query('/api/upload', '')}`, { method: 'POST', body: form }))).status).toBe(409);
    expect((await call('/api/move', 'POST', { source: 'a', destination: 'b', overwrite: true })).status).toBe(200);
    expect(await readFile(path.join(root, 'b'), 'utf8')).toBe('a');
  });
  test('text UTF-8 validation, text/preview/upload limits, raw always available', async () => {
    await writeFile(path.join(root, 'large.pdf'), '1234567890123');
    expect((await call(query('/api/text', 'large.pdf'))).status).toBe(413);
    expect((await call(query('/api/preview', 'large.pdf'))).status).toBe(413);
    expect((await api(new Request(`http://localhost${query('/api/raw', 'large.pdf')}`))).status).toBe(200);
    await writeFile(path.join(root, 'binary'), Buffer.from([0xff, 0x00]));
    expect((await call(query('/api/text', 'binary'))).data.error.code).toBe('BINARY_FILE');
    const form = new FormData(); form.append('files', new File(['123456'], 'big'));
    expect((await api(new Request(`http://localhost${query('/api/upload', '')}`, { method: 'POST', body: form }))).status).toBe(413);
    const upload = new FormData(); upload.append('files', new File(['x'], 'one')); upload.append('files', new File(['y'], 'two'));
    expect((await api(new Request(`http://localhost${query('/api/upload', '')}`, { method: 'POST', body: upload }))).status).toBe(201);
  });
  test('versioned saves detect external changes and require deliberate overwrite', async () => {
    await writeFile(path.join(root, 'note'), 'first');
    const opened = (await call(query('/api/text', 'note'))).data;
    await writeFile(path.join(root, 'note'), 'changed externally');
    expect((await call('/api/save', 'PUT', { path: 'note', content: 'new', version: opened.version })).data.error.code).toBe('SIZE_LIMIT');
    await writeFile(path.join(root, 'note'), 'changed');
    expect((await call('/api/save', 'PUT', { path: 'note', content: 'new', version: opened.version })).data.error.code).toBe('VERSION_CONFLICT');
    expect((await call('/api/save', 'PUT', { path: 'note', content: 'new', version: opened.version, overwrite: true })).status).toBe(200);
    expect(await readFile(path.join(root, 'note'), 'utf8')).toBe('new');
  });
});

describe('trash', () => {
  test('confirmed deletion, conflict on restore, alternate destination and permanent purge', async () => {
    await writeFile(path.join(root, 'note'), 'original');
    expect((await call('/api/delete', 'POST', { path: 'note' })).data.error.code).toBe('CONFIRM_REQUIRED');
    const removed = await call('/api/delete', 'POST', { path: 'note', confirmed: true });
    const id = removed.data.id;
    expect((await call('/api/trash')).data[0].original).toBe('note');
    await writeFile(path.join(root, 'note'), 'replacement');
    expect((await call(`/api/trash/${id}/restore`, 'POST', {})).data.error.code).toBe('NAME_CONFLICT');
    expect((await call(`/api/trash/${id}/restore`, 'POST', { destination: 'recovered' })).status).toBe(200);
    expect(await readFile(path.join(root, 'note'), 'utf8')).toBe('replacement');
    expect(await readFile(path.join(root, 'recovered'), 'utf8')).toBe('original');
    const second = await call('/api/delete', 'POST', { path: 'recovered', confirmed: true });
    expect((await call(`/api/trash/${second.data.id}/purge`, 'POST', {})).status).toBe(400);
    expect((await call(`/api/trash/${second.data.id}/purge`, 'POST', { confirmed: true })).status).toBe(200);
  });
  test('config rejects trash outside root and symlink to outside; without trash deletion is permanent', async () => {
    await symlink(outside, path.join(root, 'bad-trash'));
    expect(parseConfig({ root, trash: '../outside' })).rejects.toThrow();
    expect(parseConfig({ root, trash: 'bad-trash' })).rejects.toThrow();
    api = handler(await parseConfig({ root }));
    await writeFile(path.join(root, 'item'), 'x');
    expect((await call('/api/delete', 'POST', { path: 'item', confirmed: true })).status).toBe(200);
    expect((await call(query('/api/metadata', 'item'))).status).toBe(404);
  });
  test('prevents moving or deleting an ancestor of nested trash', async () => {
    await mkdir(path.join(root, 'nested'));
    await mkdir(path.join(root, 'nested', 'trash'));
    api = handler(await parseConfig({ root, trash: 'nested/trash' }));
    expect((await call('/api/delete', 'POST', { path: 'nested', confirmed: true })).data.error.code).toBe('TRASH_RESERVED');
    expect((await call('/api/move', 'POST', { source: 'nested', destination: 'elsewhere' })).status).toBe(403);
  });
});
