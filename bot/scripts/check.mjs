import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(path);
    else if (/\.(js|mjs)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
    }
  }
}
await check(fileURLToPath(new URL('../bot', import.meta.url)));
await check(fileURLToPath(new URL('.', import.meta.url)));
console.log('All Buzzo bot modules pass syntax checks.');
