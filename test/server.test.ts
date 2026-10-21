import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
    for (const target of ['../outside/secret', '/etc/passwd', 'a/../b']) {
      const response = await call(query('/api/metadata', target));
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe('INVALID_PATH');
    }
    for (const target of ['.trash', '.trash/item']) {
      const response = await call(query('/api/metadata', target));
      expect(response.status).toBe(403);
      expect(response.data.error.code).toBe('TRASH_RESERVED');
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
  test('marks missing internal symlink targets as dangling but not outside', async () => {
    await symlink('missing', path.join(root, 'internal'));
    await symlink('../outside/missing', path.join(root, 'external'));
    await symlink('external', path.join(root, 'chain'));
    for (const name of ['internal', 'external', 'chain']) {
      const response = await call(query('/api/metadata', name));
      expect(response.status).toBe(200);
      expect(response.data.link.dangling).toBe(true);
      expect(response.data.link.outside).toBe(name !== 'internal');
    }
    expect((await call(query('/api/text', 'internal'))).status).toBe(404);
  });
  test('supports POSIX backslash names in browsing and mutations without allowing traversal', async () => {
    await writeFile(path.join(root, 'a\\b'), 'existing');
    expect((await call(query('/api/list', ''))).data.entries.map((item: any) => item.name)).toContain('a\\b');
    expect((await call(query('/api/metadata', 'a\\b'))).status).toBe(200);
    expect((await call('/api/create', 'POST', { path: 'new\\name', kind: 'file' })).status).toBe(201);
    expect((await call('/api/move', 'POST', { source: 'new\\name', destination: 'moved\\name' })).status).toBe(200);
    const uploaded = new FormData(); uploaded.append('files', new File(['ok'], 'up\\load'));
    expect((await api(new Request(`http://localhost${query('/api/upload', '')}`, { method: 'POST', body: uploaded }))).status).toBe(201);
    expect(await readFile(path.join(root, 'up\\load'), 'utf8')).toBe('ok');
    const response = await call(query('/api/metadata', '../a\\b'));
    expect(response.status).toBe(400); expect(response.data.error.code).toBe('INVALID_PATH');
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
  test('simultaneous saves from one version cannot both succeed', async () => {
    await writeFile(path.join(root, 'note'), 'original');
    const { version } = (await call(query('/api/text', 'note'))).data;
    const results = await Promise.all(['first', 'second'].map(content => call('/api/save', 'PUT', { path: 'note', content, version })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.data.error.code).toBe('VERSION_CONFLICT');
    expect(await readFile(path.join(root, 'note'), 'utf8')).toBe('first');
  });
  test('read-only Markdown preview uses preview rather than edit limit, validates UTF-8', async () => {
    api = handler(await parseConfig({ root, trash: '.trash', limits: { edit: 5, preview: 12, upload: 5 } }));
    await writeFile(path.join(root, 'note.md'), '# heading');
    expect((await call(query('/api/text', 'note.md'))).status).toBe(413);
    const preview = await call(query('/api/text-preview', 'note.md'));
    expect(preview.status).toBe(200);
    expect(preview.data).toEqual({ path: 'note.md', content: '# heading' });
    await writeFile(path.join(root, 'note.md'), '1234567890123');
    expect((await call(query('/api/text-preview', 'note.md'))).data.error.code).toBe('SIZE_LIMIT');
    await writeFile(path.join(root, 'note.md'), Buffer.from([0xff, 0x00]));
    const invalid = await call(query('/api/text-preview', 'note.md'));
    expect(invalid.status).toBe(415); expect(invalid.data.error.code).toBe('BINARY_FILE');
  });
  test('simultaneous no-overwrite moves to one destination keep both sources', async () => {
    await writeFile(path.join(root, 'a'), 'A'); await writeFile(path.join(root, 'b'), 'B');
    const results = await Promise.all(['a', 'b'].map(source => call('/api/move', 'POST', { source, destination: 'shared' })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.data.error.code).toBe('NAME_CONFLICT');
    expect((await readFile(path.join(root, 'shared'), 'utf8'))).toBe('A');
    expect((await readFile(path.join(root, 'b'), 'utf8'))).toBe('B');
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
  test('concurrent restores to same destination conflict and retain the losing item', async () => {
    await writeFile(path.join(root, 'a'), 'A'); await writeFile(path.join(root, 'b'), 'B');
    const first = await call('/api/delete', 'POST', { path: 'a', confirmed: true });
    const second = await call('/api/delete', 'POST', { path: 'b', confirmed: true });
    const ids: string[] = [first.data.id, second.data.id];
    const results = await Promise.all(ids.map(id => call(`/api/trash/${id}/restore`, 'POST', { destination: 'shared' })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.data.error.code).toBe('NAME_CONFLICT');
    expect((await call('/api/trash')).data.map((entry: any) => entry.id)).toEqual([ids[1]]);
    expect(await readFile(path.join(root, 'shared'), 'utf8')).toBe('A');
  });
  test('damaged trash items cause explicit error rather than disappearing from listing', async () => {
    const id = randomUUID();
    await mkdir(path.join(root, '.trash', id));
    const response = await call('/api/trash');
    expect(response.status).toBe(500);
    expect(response.data.error.code).toBe('TRASH_DAMAGED');
    expect(response.data.error.details.id).toBe(id);
  });
});
