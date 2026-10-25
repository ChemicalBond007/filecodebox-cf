import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileToken } from './src/auth.js';
import { TelegramAPI, assembleChunkedKey, serveFromTelegram } from './src/telegram.js';
import pickup from './pickup/_worker.js';

const env = { FILE_SECRET: 'telegram-download-test-secret', TG_BOT_TOKEN: 'test-bot' };
const code = 'ABCD2345';
const text = 'abcdefghij';
const chunks = [
  { index: 0, fileId: 'part-0', size: 4, fileName: 'part0.bin' },
  { index: 1, fileId: 'part-1', size: 6, fileName: 'part1.bin' },
];
const chunkKey = assembleChunkedKey(chunks);

function mockTelegram(t, { unknownSize = false, empty = false, fail = false } = {}) {
  const stats = { calls: [], reads: 0, cancelled: false };
  t.mock.method(TelegramAPI.prototype, 'getFileContent', async key => {
    stats.calls.push(key);
    if (fail) return new Response('upstream failure', { status: 404 });
    const content = empty ? '' : key === 'part-0' ? text.slice(0, 4)
      : key === 'part-1' ? text.slice(4) : text;
    const bytes = new TextEncoder().encode(content);
    let position = 0;
    const body = new ReadableStream({
      pull(controller) {
        stats.reads++;
        if (position === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(position, ++position));
      },
      cancel() { stats.cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = { 'Content-Type': 'text/html' };
    if (!unknownSize) headers['Content-Length'] = String(bytes.length);
    return new Response(body, { headers });
  });
  return stats;
}

async function download(key, headers = {}, method = 'GET', gateway = false) {
  const token = await fileToken(env, key, code);
  const request = new Request(`https://pickup.test/file/${encodeURIComponent(key)}?c=${code}&t=${token}`,
    { method, headers });
  const serve = request => serveFromTelegram(env, request, key, code,
    { file_name: '下载.html', file_size: 999999 });
  return gateway ? pickup.fetch(request, { BACKEND: { fetch: serve } }) : serve(request);
}

function assertSafe(response) {
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Cache-Control'), /no-store/);
}

for (const [name, key] of [['single', 'single-file'], ['chunked', chunkKey]]) {
  test(`${name}: partial, open-ended, suffix and capped byte ranges`, async t => {
    mockTelegram(t);
    for (const [range, start, end] of [
      ['bytes=0-0', 0, 0], ['bytes=2-6', 2, 6], ['bytes=5-', 5, 9],
      ['bytes=-3', 7, 9], ['bytes=-50', 0, 9], ['bytes=8-999', 8, 9],
      ['bytes=0-999999999999999999999999999999', 0, 9],
      ['bytes=-999999999999999999999999999999', 0, 9],
      ['BYTES=1-2', 1, 2],
    ]) {
      await t.test(range, async () => {
        const response = await download(key, { Range: range });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/10`);
        assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
        assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
        assertSafe(response);
        assert.equal(await response.text(), text.slice(start, end + 1));
      });
    }
  });

  test(`${name}: unsatisfiable ranges return 416 with the real total size`, async t => {
    const stats = mockTelegram(t);
    for (const range of ['bytes=10-', 'bytes=100-200', 'bytes=-0',
      'bytes=999999999999999999999999999999-']) {
      await t.test(range, async () => {
        const response = await download(key, { Range: range });
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('Content-Range'), 'bytes */10');
        assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
        assertSafe(response);
        assert.equal(await response.text(), '');
      });
    }
    if (name === 'chunked') assert.deepEqual(stats.calls, []);
    else assert.equal(stats.cancelled, true);
  });

  test(`${name}: full downloads and unsupported/invalid ranges remain intact`, async t => {
    mockTelegram(t);
    for (const range of [undefined, 'bytes=8-2', 'bytes=0-1,4-5', 'bytes=2-6junk',
      'bytes=-', 'items=0-2']) {
      await t.test(range ?? 'no Range', async () => {
        const response = await download(key, range ? { Range: range } : {});
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Range'), null);
        assert.equal(response.headers.get('Content-Length'), '10');
        assertSafe(response);
        assert.equal(await response.text(), text);
      });
    }
  });

  test(`${name}: HEAD ignores Range, returns the full size and does not read the body`, async t => {
    const stats = mockTelegram(t);
    const response = await download(key, { Range: 'bytes=999-' }, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), '10');
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.body, null);
    assert.equal(stats.reads, 0);
    if (name === 'single') assert.equal(stats.cancelled, true);
    else assert.deepEqual(stats.calls, []);
  });

  test(`${name}: unverifiable If-Range falls back to a full download`, async t => {
    mockTelegram(t);
    const response = await download(key, { Range: 'bytes=2-6', 'If-Range': '"old-version"' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(await response.text(), text);
  });

  test(`${name}: pickup gateway preserves partial bytes and 416 size information`, async t => {
    mockTelegram(t);
    const partial = await download(key, { Range: 'bytes=2-6' }, 'GET', true);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('Content-Range'), 'bytes 2-6/10');
    assert.equal(partial.headers.get('Content-Length'), '5');
    assert.equal(await partial.text(), 'cdefg');
    const unsatisfied = await download(key, { Range: 'bytes=10-' }, 'GET', true);
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await unsatisfied.text(), '');
  });
}

test('single: range slicing stops upstream reads after the last requested byte', async t => {
  const stats = mockTelegram(t);
  const response = await download('single-file', { Range: 'bytes=2-4' });
  assert.equal(await response.text(), 'cde');
  assert.equal(stats.reads, 5);
  assert.equal(stats.cancelled, true);
});

test('single: cancelling a partial download cancels the upstream stream', async t => {
  const stats = mockTelegram(t);
  const response = await download('single-file', { Range: 'bytes=2-8' });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'c');
  await reader.cancel('test client cancelled');
  assert.equal(stats.cancelled, true);
});

test('single: unknown upstream size ignores Range rather than trusting client metadata', async t => {
  mockTelegram(t, { unknownSize: true });
  const response = await download('single-file', { Range: 'bytes=2-6' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Accept-Ranges'), null);
  assert.equal(response.headers.get('Content-Range'), null);
  assert.equal(await response.text(), text);
});

test('single and chunked: empty files return 200 normally and bytes */0 for unsatisfied ranges', async t => {
  mockTelegram(t, { empty: true });
  const emptyChunked = assembleChunkedKey([{ index: 0, fileId: 'empty', size: 0 }]);
  for (const key of ['empty', emptyChunked]) {
    const full = await download(key);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('Content-Length'), '0');
    assert.equal(await full.text(), '');
    const partial = await download(key, { Range: 'bytes=0-' });
    assert.equal(partial.status, 416);
    assert.equal(partial.headers.get('Content-Range'), 'bytes */0');
    assert.equal(await partial.text(), '');
  }
});

test('single: upstream failures remain 502 rather than masquerading as valid partial files', async t => {
  mockTelegram(t, { fail: true });
  const response = await download('single-file', { Range: 'bytes=2-6' });
  assert.equal(response.status, 502);
  await response.text();
});

test('range downloads still reject missing, invalid or wrong-code tokens before contacting Telegram', async t => {
  const stats = mockTelegram(t);
  const valid = await fileToken(env, 'single-file', code);
  for (const [token, requestCode] of [[null, code], ['invalid-token', code], [valid, 'WXYZ2345']]) {
    const url = new URL('https://pickup.test/file/single-file');
    if (token) url.searchParams.set('t', token);
    const response = await serveFromTelegram(env,
      new Request(url, { headers: { Range: 'bytes=0-1' } }), 'single-file', requestCode, {});
    assert.equal(response.status, 403);
    await response.text();
  }
  assert.deepEqual(stats.calls, []);
});

test('Telegram file fetch requests identity encoding so byte offsets match Content-Length', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return calls.length === 1
      ? Response.json({ ok: true, result: { file_path: 'documents/test.bin' } })
      : new Response(text);
  });
  const response = await new TelegramAPI('test-bot').getFileContent('single-file');
  assert.equal(await response.text(), text);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get('Accept-Encoding'), 'identity');
});
