import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { Config } from './config';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new ApiError(status, code, message, details);
};

export class Files {
  constructor(readonly config: Config) {}
  private mutationTail: Promise<void> = Promise.resolve();

  // Shared by every mutation route in this server. Read-only requests remain concurrent.
  async mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  private inside(target: string): boolean {
    const relative = path.relative(this.config.root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private protected(target: string): boolean {
    return !!this.config.trash && (target === this.config.trash || target.startsWith(`${this.config.trash}${path.sep}`));
  }

  private ensureNotTrashAncestor(target: string): void {
    if (this.config.trash && this.config.trash.startsWith(`${target}${path.sep}`)) {
      fail(403, 'TRASH_RESERVED', 'Cannot move or delete an ancestor of trash');
    }
  }

  private relative(target: string): string { return path.relative(this.config.root, target).split(path.sep).join('/'); }

  private lexical(input: string, allowTrash = false): string {
    if (typeof input !== 'string' || input.includes('\0') || input.startsWith('/') ||
        input.split('/').some(part => part === '..' || part === '.' || part === '')) {
      if (input === '') return this.config.root;
      return fail(400, 'INVALID_PATH', 'Use a root-relative path without dot or empty segments');
    }
    const target = path.resolve(this.config.root, input);
    if (!this.inside(target)) return fail(403, 'OUTSIDE_ROOT', 'Path is outside root');
    if (!allowTrash && this.protected(target)) return fail(403, 'TRASH_RESERVED', 'Use the trash API');
    return target;
  }

  private async parent(input: string): Promise<string> {
    const target = this.lexical(input);
    if (target === this.config.root) return fail(400, 'INVALID_PATH', 'Cannot modify root');
    const parent = await realpath(path.dirname(target));
    if (!this.inside(parent) || this.protected(parent)) return fail(403, 'OUTSIDE_ROOT', 'Parent resolves outside root or into trash');
    if (!(await stat(parent)).isDirectory()) return fail(400, 'NOT_DIRECTORY', 'Parent is not a directory');
    return path.join(parent, path.basename(target));
  }

  private async entry(input: string): Promise<{ target: string; info: Stats }> {
    const target = await this.parent(input);
    const info = await lstat(target);
    return { target, info };
  }

  private async readable(input: string): Promise<{ target: string; info: Stats }> {
    const lexical = this.lexical(input);
    const target = await realpath(lexical);
    if (!this.inside(target) || this.protected(target)) return fail(403, 'OUTSIDE_ROOT', 'Target resolves outside root or into trash');
    return { target, info: await stat(target) };
  }

  private async exists(target: string): Promise<boolean> {
    try { await lstat(target); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async conflict(target: string, overwrite = false): Promise<void> {
    if (!await this.exists(target)) return;
    if (!overwrite) return fail(409, 'NAME_CONFLICT', 'Destination already exists', { path: this.relative(target) });
    const info = await lstat(target);
    if (info.isDirectory() && !info.isSymbolicLink()) return fail(409, 'NAME_CONFLICT', 'Cannot overwrite a directory');
  }

  async describe(input: string) {
    const lexical = this.lexical(input);
    const target = input === '' ? lexical : (await this.entry(input)).target;
    const info = await lstat(target);
    let link: { target: string; outside: boolean; dangling: boolean } | undefined;
    if (info.isSymbolicLink()) {
      const raw = await readlink(target);
      let outside = false, dangling = false;
      try { const resolved = await realpath(target); outside = !this.inside(resolved) || this.protected(resolved); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        dangling = true;
        outside = await this.danglingOutside(path.resolve(path.dirname(target), raw));
      }
      link = { target: raw, outside, dangling };
    }
    return { path: input, name: path.basename(target), kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      size: info.size, modified: info.mtime.toISOString(), link };
  }

  private async danglingOutside(candidate: string, visited = new Set<string>()): Promise<boolean> {
    if (!this.inside(candidate) || this.protected(candidate)) return true;
    if (visited.has(candidate)) return true;
    visited.add(candidate);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        const raw = await readlink(candidate);
        return this.danglingOutside(path.resolve(path.dirname(candidate), raw), visited);
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (candidate === this.config.root) return false;
      return this.danglingOutside(path.dirname(candidate), visited);
    }
  }

  async list(input: string) {
    const { target, info } = await this.readable(input);
    if (!info.isDirectory()) return fail(400, 'NOT_DIRECTORY', 'Not a directory');
    const names = await readdir(target);
    const entries = await Promise.all(names.filter(name => !this.protected(path.join(target, name))).map(name => this.describe(input ? `${input}/${name}` : name)));
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || Date.parse(b.modified) - Date.parse(a.modified) || a.name.localeCompare(b.name));
    return { path: input, entries };
  }

  async file(input: string, limit?: number) {
    const { target, info } = await this.readable(input);
    if (!info.isFile()) return fail(400, 'NOT_FILE', 'Not a regular file');
    if (limit !== undefined && info.size > limit) return fail(413, 'SIZE_LIMIT', `File exceeds ${limit} bytes`);
    return { target, info };
  }

  async text(input: string) {
    return this.readText(input, this.config.limits.edit);
  }

  async previewText(input: string) {
    const { path, content } = await this.readText(input, this.config.limits.preview);
    return { path, content };
  }

  private async readText(input: string, limit: number) {
    const { target, info } = await this.file(input, limit);
    const bytes = await readFile(target);
    if (bytes.length > limit) return fail(413, 'SIZE_LIMIT', 'File exceeds text size limit');
    const content = this.decodeText(bytes);
    return { path: input, content, version: this.version(bytes, info) };
  }

  private decodeText(bytes: Uint8Array): string {
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail(415, 'BINARY_FILE', 'File is not valid UTF-8'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return fail(415, 'BINARY_FILE', 'File contains binary control characters');
    return content;
  }

  private version(bytes: Uint8Array, info: Stats): string {
    return createHash('sha256').update(bytes).update(`:${info.mtimeMs}:${info.ino}:${info.size}`).digest('hex');
  }

  async save(input: string, content: string, version: string, overwrite = false) {
    if (typeof content !== 'string' || typeof version !== 'string') return fail(400, 'INVALID_INPUT', 'content and version are required');
    const { target, info } = await this.file(input, this.config.limits.edit);
    // Editing through a symlink would replace the symlink. Require direct file paths for writes.
    if ((await this.entry(input)).info.isSymbolicLink()) return fail(400, 'SYMLINK_WRITE', 'Edit the target directly');
    const current = await readFile(target);
    if (current.length > this.config.limits.edit) return fail(413, 'SIZE_LIMIT', 'File exceeds edit limit');
    this.decodeText(current);
    this.decodeText(Buffer.from(content, 'utf8'));
    const actual = this.version(current, info);
    if (actual !== version && !overwrite) return fail(409, 'VERSION_CONFLICT', 'File changed since it was opened', { version: actual });
    const data = Buffer.from(content, 'utf8');
    if (data.length > this.config.limits.edit) return fail(413, 'SIZE_LIMIT', 'Text exceeds edit limit');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: info.mode });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return this.text(input);
  }

  async create(input: string, kind: 'file' | 'directory') {
    const target = await this.parent(input);
    if (kind === 'directory') await mkdir(target);
    else if (kind === 'file') { const handle = await open(target, 'wx'); await handle.close(); }
    else return fail(400, 'INVALID_INPUT', 'kind must be file or directory');
    return this.describe(input);
  }

  async upload(directory: string, files: File[], overwrite = false) {
    const { info } = await this.readable(directory);
    if (!info.isDirectory()) return fail(400, 'NOT_DIRECTORY', 'Not a directory');
    if (!files.length) return fail(400, 'INVALID_INPUT', 'No files provided');
    const names = files.map(file => file.name);
    if (new Set(names).size !== names.length) return fail(409, 'NAME_CONFLICT', 'Duplicate uploaded filenames');
    for (const file of files) {
      this.validName(file.name);
      if (file.size > this.config.limits.upload) return fail(413, 'SIZE_LIMIT', `${file.name} exceeds upload limit`);
      const target = await this.parent(directory ? `${directory}/${file.name}` : file.name);
      if (!overwrite && await this.exists(target)) return fail(409, 'NAME_CONFLICT', 'Destination already exists', { path: this.relative(target) });
      if (overwrite && await this.exists(target) && (await lstat(target)).isDirectory()) return fail(409, 'NAME_CONFLICT', 'Cannot overwrite directory');
    }
    const results = [];
    for (const file of files) {
      const destination = directory ? `${directory}/${file.name}` : file.name;
      const target = await this.parent(destination);
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > this.config.limits.upload) return fail(413, 'SIZE_LIMIT', 'Upload exceeds limit');
      await this.conflict(target, overwrite);
      if (overwrite) {
        const temporary = `${target}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }); }
      } else await writeFile(target, bytes, { flag: 'wx' });
      results.push(await this.describe(destination));
    }
    return results;
  }

  private validName(name: string) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      return fail(400, 'INVALID_PATH', 'Invalid filename');
    }
  }

  async move(source: string, destination: string, overwrite = false) {
    const { target: from, info } = await this.entry(source);
    this.ensureNotTrashAncestor(from);
    const to = await this.parent(destination);
    if (from === to) return fail(400, 'INVALID_PATH', 'Source and destination are the same');
    if (info.isDirectory() && (to.startsWith(`${from}${path.sep}`) || to === from)) return fail(400, 'INVALID_PATH', 'Cannot move a directory into itself');
    await this.conflict(to, overwrite);
    await rename(from, to);
    return this.describe(destination);
  }

  async delete(input: string, confirmed: boolean) {
    if (confirmed !== true) return fail(400, 'CONFIRM_REQUIRED', 'Deletion requires confirmed: true');
    const { target } = await this.entry(input);
    this.ensureNotTrashAncestor(target);
    if (!this.config.trash) { await rm(target, { recursive: true }); return { deleted: true }; }
    const id = randomUUID();
    const folder = path.join(this.config.trash, id);
    await mkdir(folder);
    try {
      await writeFile(path.join(folder, 'meta.json'), JSON.stringify({ original: input, deletedAt: new Date().toISOString() }), { flag: 'wx' });
      await rename(target, path.join(folder, 'item'));
    } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
    return { id, deleted: true };
  }

  private async trashEntry(id: string) {
    if (!this.config.trash) return fail(400, 'TRASH_DISABLED', 'Trash is not configured');
    if (!/^[0-9a-f-]{36}$/.test(id)) return fail(400, 'INVALID_PATH', 'Invalid trash ID');
    const folder = path.join(this.config.trash, id);
    const meta = JSON.parse(await readFile(path.join(folder, 'meta.json'), 'utf8')) as { original: string; deletedAt: string };
    return { id, ...meta, folder, item: path.join(folder, 'item') };
  }

  async trashList() {
    if (!this.config.trash) return fail(400, 'TRASH_DISABLED', 'Trash is not configured');
    const ids = await readdir(this.config.trash);
    return Promise.all(ids.filter(id => /^[0-9a-f-]{36}$/.test(id)).map(async id => {
      try {
        const { folder, item, ...meta } = await this.trashEntry(id);
        const info = await lstat(item);
        return { ...meta, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', size: info.size };
      } catch (error) {
        throw new ApiError(500, 'TRASH_DAMAGED', `Cannot read trash item ${id}`, { id, cause: (error as Error).message });
      }
    }));
  }

  async restore(id: string, destination?: string) {
    const entry = await this.trashEntry(id);
    const targetPath = destination ?? entry.original;
    const target = await this.parent(targetPath);
    await this.conflict(target);
    await rename(entry.item, target);
    await rm(entry.folder, { recursive: true });
    return this.describe(targetPath);
  }

  async purge(id: string, confirmed: boolean) {
    if (confirmed !== true) return fail(400, 'CONFIRM_REQUIRED', 'Permanent deletion requires confirmed: true');
    const entry = await this.trashEntry(id);
    await rm(entry.folder, { recursive: true });
    return { deleted: true };
  }
}
