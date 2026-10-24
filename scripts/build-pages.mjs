// 只复制明确列出的前端文件，绝不上传仓库、数据库或本地密钥。
import { copyFile, mkdir } from 'node:fs/promises';

const output = new URL('../.wrangler/pages-dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  await copyFile(new URL(`../public/${file}`, import.meta.url), new URL(file, output));
}
for (const file of ['_worker.js', '_routes.json', '_headers']) {
  await copyFile(new URL(`../pages/${file}`, import.meta.url), new URL(file, output));
}
console.log('Pages build ready: 3 frontend assets and a service-binding gateway.');
