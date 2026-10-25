// 仅供本地 workerd 测试：使用请求内创建的合成字节流，不访问 Telegram。
import { fileToken } from '../src/auth.js';
import { TelegramAPI, assembleChunkedKey, serveFromTelegram } from '../src/telegram.js';
import pickup from '../pickup/_worker.js';

const env = { FILE_SECRET: 'runtime-download-test-secret', TG_BOT_TOKEN: 'test-bot' };
const code = 'ABCD2345';
const contents = { 'single-file': 'abcdefghij', 'part-0': 'abcd', 'part-1': 'efghij', empty: '' };

TelegramAPI.prototype.getFileContent = async function (key) {
  if (!Object.hasOwn(contents, key)) throw new Error('Unexpected test file');
  const bytes = new TextEncoder().encode(contents[key]);
  let position = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (position === bytes.length) controller.close();
      else {
        controller.enqueue(bytes.slice(position, position + 2));
        position = Math.min(position + 2, bytes.length);
      }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'Content-Length': String(bytes.length) } });
};

export default {
  async fetch(request) {
    const mode = new URL(request.url).pathname.split('/').pop();
    if (!['single', 'chunked', 'empty'].includes(mode)) return new Response(null, { status: 404 });
    const key = mode === 'single' ? 'single-file' : mode === 'empty' ? 'empty'
      : assembleChunkedKey([
        { index: 0, fileId: 'part-0', size: 4 },
        { index: 1, fileId: 'part-1', size: 6 },
      ]);
    const url = new URL(`/file/${encodeURIComponent(key)}`, request.url);
    url.searchParams.set('c', code);
    url.searchParams.set('t', await fileToken(env, key, code));
    return pickup.fetch(new Request(url, { method: request.method, headers: request.headers }), {
      BACKEND: {
        fetch: forwarded => serveFromTelegram(env, forwarded, key, code, { file_name: 'runtime.bin' }),
      },
    });
  },
};
