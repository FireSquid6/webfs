import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { parseConfig } from './server/config';
import { createServer } from './server/http';

const program = new Command();
program.name('filesystem-web-app').requiredOption('-c, --config <file>', 'YAML configuration file')
  .option('--lan', 'listen on all interfaces instead of localhost');
program.parse();
const options = program.opts<{ config: string; lan?: boolean }>();

try {
  const filename = path.resolve(options.config);
  const config = await parseConfig(Bun.YAML.parse(await readFile(filename, 'utf8')), path.dirname(filename));
  const server = createServer(config, options.lan ? '0.0.0.0' : '127.0.0.1');
  console.log(`Listening at ${server.url} (root: ${config.root})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
