import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CONFIG_FILENAME, starterConfig } from '@forge/config';

export async function init(args: string[]): Promise<number> {
  const path = resolve(process.cwd(), CONFIG_FILENAME);
  if (existsSync(path) && !args.includes('--force')) {
    console.error(`${CONFIG_FILENAME} already exists. Pass --force to overwrite it.`);
    return 1;
  }
  // The project name becomes a directory name under .forge, so it is slugified
  // rather than taken verbatim from a folder that may contain spaces.
  const slug =
    basename(process.cwd())
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'forge';
  writeFileSync(path, starterConfig(slug));
  console.log(`wrote ${CONFIG_FILENAME}`);
  console.log('\nIt runs as-is against the bundled fixture. Edit `repo` to point at your own code,');
  console.log('then: forge doctor');
  return 0;
}
