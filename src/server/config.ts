import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  root: z.string().min(1),
  trash: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).default(3000),
  limits: z.object({
    edit: z.number().int().positive().default(5 * 1024 * 1024),
    preview: z.number().int().positive().default(25 * 1024 * 1024),
    upload: z.number().int().positive().default(100 * 1024 * 1024),
  }).default({ edit: 5 * 1024 * 1024, preview: 25 * 1024 * 1024, upload: 100 * 1024 * 1024 }),
});

export type Config = z.infer<typeof schema> & { root: string; trash?: string };

export async function parseConfig(value: unknown, base = process.cwd()): Promise<Config> {
  const config = schema.parse(value);
  const root = await realpath(path.resolve(base, config.root));
  if (!(await stat(root)).isDirectory()) throw new Error('root must be a directory');
  let trash: string | undefined;
  if (config.trash) {
    const candidate = path.resolve(root, config.trash);
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('trash must be strictly inside root');
    }
    // The trash directory must already exist, so no symlinked ancestor can escape validation.
    trash = await realpath(candidate);
    const realRelative = path.relative(root, trash);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error('trash must resolve strictly inside root');
    }
    if (!(await stat(trash)).isDirectory()) throw new Error('trash must be a directory');
  }
  return { ...config, root, trash };
}
