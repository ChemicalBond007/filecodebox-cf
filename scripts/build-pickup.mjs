import { copyFile, mkdir } from 'node:fs/promises';

const output = new URL('../.wrangler/pickup-dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'pickup.js', '_worker.js', '_routes.json', '_headers']) {
  await copyFile(new URL(`../pickup/${file}`, import.meta.url), new URL(file, output));
}
await copyFile(new URL('../public/styles.css', import.meta.url), new URL('styles.css', output));
console.log('Pickup build ready: 3 frontend assets and a pickup-only service-binding gateway.');
