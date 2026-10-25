// 运行真实前端脚本，用可控 DOM / XHR / fetch 验证上传事件及完整寄件流程。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { CHUNK_SIZE } from './src/telegram.js';

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const MB = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(attrs) {
    this.attrs = attrs;
    this.value = attrs.value || '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.files = [];
    this.dataset = Object.fromEntries(Object.entries(attrs)
      .filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value]));
    this.events = new Map();
    const classes = new Set((attrs.class || '').split(/\s+/));
    this.classList = {
      add: (...values) => values.forEach(v => classes.add(v)),
      remove: (...values) => values.forEach(v => classes.delete(v)),
      contains: value => classes.has(value),
      toggle: (value, force = !classes.has(value)) => {
        if (force) classes.add(value); else classes.delete(value);
        return force;
      },
    };
  }
  addEventListener(type, handler) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(handler);
  }
  emit(type, event = {}) {
    return Promise.all((this.events.get(type) || []).map(handler =>
      handler({ target: this, preventDefault() {}, ...event })));
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  focus() {}
  click() { return this.emit('click'); }
}

async function app({ storage = 'CloudFlare-ImgBed (API)', chunkSize = CHUNK_SIZE, initError } = {}) {
  const elements = [...html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gi)].map(([, tag]) => {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    return new Element(attrs);
  });
  const ids = new Map(elements.filter(el => el.attrs.id).map(el => [el.attrs.id, el]));
  const el = id => {
    if (id === 'copyText' && !ids.has(id)) ids.set(id, new Element({ id }));
    assert.ok(ids.has(id), '前端元素存在：' + id);
    return ids.get(id);
  };
  const selectAll = selector => {
    if (selector.startsWith('.')) return elements.filter(el => el.classList.contains(selector.slice(1)));
    if (selector === '[data-admin-action]') return elements.filter(el => 'data-admin-action' in el.attrs);
    if (selector === '#shareRows .del') return [];
    throw new Error('未模拟的选择器：' + selector);
  };
  el('expireSel').value = '86400000';
  el('dlSel').value = '10';
  const xhrs = [], requests = [], fetches = [];
  class FakeXHR {
    constructor() { this.upload = {}; }
    open(method, path) { this.method = method; this.path = path; }
    send(body) {
      this.body = body;
      xhrs.push(this);
      assert.equal(this.method, 'POST');
      assert.equal(this.responseType, 'json');
    }
    progress(loaded, total, lengthComputable = true) { this.upload.onprogress({ loaded, total, lengthComputable }); }
    sent() { this.upload.onload(); }
    respond(status, response) { this.status = status; this.response = response; this.onload(); }
  }
  const fetch = (path, opts = {}) => {
    fetches.push({ path, opts });
    if (path === '/api/config') return Promise.resolve(Response.json({ storage }));
    if (path === '/api/chunk/init') return Promise.resolve(
      initError ? Response.json({ error: initError }, { status: 503 }) : Response.json({ chunkSize }));
    return new Promise((resolve, reject) => requests.push({
      path, opts, respond(data, status = 200) { resolve(Response.json(data, { status })); },
      fail: reject,
    }));
  };
  runInNewContext(script, {
    document: { querySelector: selector => el(selector.slice(1)), querySelectorAll: selectAll },
    window: { addEventListener() {} },
    location: { origin: 'https://frontend.test', hash: '' },
    localStorage: { removeItem() {} }, navigator: {},
    fetch, XMLHttpRequest: FakeXHR, FormData, TextEncoder, crypto,
    setTimeout: () => 0, clearTimeout() {},
  });
  await tick(); // 等待启动配置加载。
  const segment = type => elements.find(e => e.dataset.type === type);
  return {
    el, xhrs, requests, fetches, segment,
    async choose(file) {
      await segment('file').click();
      el('fileInput').files = [file];
      await el('fileInput').emit('change');
    },
    async finishShare() {
      await tick();
      const share = requests.find(r => r.path === '/api/share');
      assert.ok(share, '上传成功后创建分享');
      share.respond({ code: 'ABCD2345', type: share.opts.body.get('type'), download_limit: 1 });
      return share;
    },
  };
}
const file = (size = 1024, name = 'upload.bin') => new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
const uploadResult = { id: 'uploaded-file', upload_token: 'test-upload-token' };
function chunkResult(xhr) {
  const index = Number(xhr.body.get('index'));
  return { success: true, fileId: `chunk-${index}`, size: xhr.body.get('file').size,
    fileName: xhr.body.get('fileName'), chunkToken: `test-chunk-token-${index}` };
}
function assertUnlocked(a) {
  for (const id of ['sendBtn', 'fileInput', 'fileClear', 'textInput', 'expireSel', 'dlSel', 'pwdInput']) {
    assert.equal(a.el(id).disabled, false, id + ' 恢复可用');
  }
  assert.equal(a.segment('file').disabled, false);
  assert.equal(a.el('dropzone').getAttribute('aria-disabled'), 'false');
}

test('普通上传显示实际进度，等待存储/取件码，锁定文件并防止重复提交', async () => {
  const a = await app();
  await a.choose(file(1024, 'original.bin'));
  const sending = a.el('sendBtn').click();
  assert.equal(a.el('uploadProgressBar').value, 0);
  assert.equal(a.el('uploadProgressBar').getAttribute('aria-label'), '文件上传进度');
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), false);
  assert.equal(a.el('fileInput').disabled, true);
  assert.equal(a.segment('text').disabled, true);
  assert.equal(a.el('dropzone').getAttribute('aria-disabled'), 'true');
  await a.el('sendBtn').click();
  assert.equal(a.xhrs.length, 1);
  a.el('fileInput').files = [file(99, 'replacement.bin')];
  await a.el('fileInput').emit('change');
  await a.el('dropzone').emit('drop', { dataTransfer: { files: [file(88, 'dropped.bin')] } });
  await a.el('dropzone').emit('dragover');
  assert.equal(a.el('dropzone').classList.contains('drag'), false);
  await a.el('fileClear').click();
  await a.segment('text').click();
  assert.equal(a.el('fcName').textContent, 'original.bin');

  const xhr = a.xhrs[0];
  assert.equal(xhr.path, '/api/imgbed/upload');
  xhr.progress(500, 1000);
  assert.equal(a.el('uploadProgressBar').value, 50);
  assert.equal(a.el('uploadProgressDetail').textContent, '512 B / 1.0 KB');
  xhr.progress(100, 1000); // 乱序事件不能让累计进度倒退。
  xhr.progress(1000, 0);
  xhr.progress(1000, 1000, false);
  assert.equal(a.el('uploadProgressBar').value, 50);
  xhr.progress(2000, 1000); // 防止超过 100%。
  assert.equal(a.el('uploadProgressBar').value, 100);
  xhr.sent();
  assert.match(a.el('uploadProgressStatus').textContent, /等待存储确认/);
  assert.equal(a.el('uploadProgress').dataset.status, 'uploading');
  assert.equal(a.el('sendResult').classList.contains('hidden'), true);
  xhr.respond(200, uploadResult);
  await tick();
  assert.match(a.el('uploadProgressStatus').textContent, /正在生成取件码/);
  assert.equal(a.el('sendBtn').disabled, true);
  const share = await a.finishShare();
  assert.equal(share.opts.body.get('file_name'), 'original.bin');
  assert.equal(share.opts.body.get('file_size'), '1024');
  assert.equal(share.opts.body.get('file_key'), uploadResult.id);
  await sending;
  assert.equal(a.el('uploadProgressBar').value, 100);
  assert.equal(a.el('uploadProgress').dataset.status, 'complete');
  assert.equal(a.el('sendResult').classList.contains('hidden'), false);
  assertUnlocked(a);
});

test('Telegram 三个不等长分片按文件字节累计，而不是每片重新从 0% 开始', async () => {
  const a = await app({ storage: 'Telegram (Bot API)' });
  await a.choose(file(42 * MB));
  const sending = a.el('sendBtn').click();
  await tick();
  const seen = [];
  for (let index = 0; index < 3; index++) {
    const xhr = a.xhrs[index];
    assert.ok(xhr);
    assert.equal(xhr.path, '/api/chunk/upload');
    assert.equal(xhr.body.get('file').size, index === 2 ? 2 * MB : 20 * MB);
    xhr.progress(1, 2);
    seen.push(a.el('uploadProgressBar').value);
    assert.match(a.el('uploadProgressStatus').textContent, new RegExp(`分片 ${index + 1}/3`));
    xhr.sent();
    xhr.respond(200, chunkResult(xhr));
    await tick();
  }
  assert.deepEqual(seen, [23, 71, 97]);
  assert.equal(a.el('uploadProgressBar').value, 100);
  assert.match(a.el('uploadProgressStatus').textContent, /合并分片/);
  assert.equal(a.el('uploadProgress').dataset.status, 'uploading');
  const merge = a.requests.find(r => r.path === '/api/chunk/merge');
  assert.equal(JSON.parse(merge.opts.body).totalChunks, 3);
  merge.respond({ id: 'c:chunked-file', upload_token: 'chunked-upload-token' });
  await a.finishShare();
  await sending;
  assert.equal(a.el('uploadProgress').dataset.status, 'complete');
  assert.equal(a.el('uploadProgressDetail').textContent, '42.00 MB / 42.00 MB');
  assertUnlocked(a);
});

test('恰好 20MiB 单发，超过 1 字节时按 20MiB + 1 字节分片', async t => {
  assert.equal(CHUNK_SIZE, 20 * MB);
  for (const size of [CHUNK_SIZE, CHUNK_SIZE + 1]) {
    await t.test(String(size), async () => {
      const a = await app({ storage: 'Telegram (Bot API)' });
      await a.choose(file(size));
      const sending = a.el('sendBtn').click();
      await tick();
      assert.equal(a.xhrs[0].body.get('file').size, CHUNK_SIZE);
      if (size === CHUNK_SIZE) {
        assert.equal(a.xhrs[0].path, '/api/imgbed/upload');
        a.xhrs[0].respond(200, uploadResult);
      } else {
        for (let i = 0; i < 2; i++) {
          assert.equal(a.xhrs[i].path, '/api/chunk/upload');
          assert.equal(a.xhrs[i].body.get('file').size, i ? 1 : CHUNK_SIZE);
          a.xhrs[i].sent();
          a.xhrs[i].respond(200, chunkResult(a.xhrs[i]));
          await tick();
        }
        a.requests.find(r => r.path === '/api/chunk/merge').respond(uploadResult);
      }
      await a.finishShare();
      await sending;
      assert.equal(a.el('uploadProgressBar').value, 100);
      assert.equal(a.el('uploadProgress').dataset.status, 'complete');
      assertUnlocked(a);
    });
  }
});

test('HTTP 错误持久显示，重试清除错误并从 0% 开始', async () => {
  const a = await app();
  await a.choose(file());
  let sending = a.el('sendBtn').click();
  a.xhrs[0].progress(3, 4);
  a.xhrs[0].respond(413, { error: '文件过大' });
  await sending;
  assert.equal(a.el('uploadProgressBar').value, 75);
  assert.equal(a.el('uploadProgress').dataset.status, 'error');
  assert.match(a.el('uploadProgressStatus').textContent, /文件过大/);
  assert.equal(a.requests.length, 0);
  assertUnlocked(a);
  sending = a.el('sendBtn').click();
  assert.equal(a.el('uploadProgressBar').value, 0);
  assert.equal(a.el('uploadProgress').dataset.status, 'uploading');
  a.xhrs[1].respond(200, uploadResult);
  await a.finishShare();
  await sending;
  assert.equal(a.el('uploadProgress').dataset.status, 'complete');
});

test('网络错误、取消、超时及无效响应均解锁界面且不创建分享', async t => {
  for (const [name, finish, message] of [
    ['network', xhr => xhr.onerror(), /网络异常/],
    ['abort', xhr => xhr.onabort(), /取消/],
    ['timeout', xhr => xhr.ontimeout(), /超时/],
    ['invalid JSON', xhr => xhr.respond(200, null), /上传响应无效/],
    ['non-object JSON', xhr => xhr.respond(200, 'invalid'), /上传响应无效/],
    ['missing token', xhr => xhr.respond(200, { id: 'key' }), /未返回文件凭证/],
    ['non-JSON server error', xhr => xhr.respond(502, null), /502/],
  ]) {
    await t.test(name, async () => {
      const a = await app();
      await a.choose(file());
      const sending = a.el('sendBtn').click();
      finish(a.xhrs[0]);
      await sending;
      assert.equal(a.el('uploadProgress').dataset.status, 'error');
      assert.match(a.el('uploadProgressStatus').textContent, message);
      assert.equal(a.requests.length, 0);
      assertUnlocked(a);
    });
  }
});

test('分片初始化失败不启动上传，无效分片大小不会进入循环', async t => {
  for (const options of [{ initError: '存储暂不可用' },
    ...[0, -1, 1.5, null, '16'].map(chunkSize => ({ chunkSize }))]) {
    await t.test(JSON.stringify(options), async () => {
      const a = await app({ storage: 'Telegram (Bot API)', ...options });
      await a.choose(file(21 * MB));
      await a.el('sendBtn').click();
      assert.equal(a.xhrs.length, 0);
      assert.equal(a.el('uploadProgressBar').value, 0);
      assert.equal(a.el('uploadProgress').dataset.status, 'error');
      assertUnlocked(a);
    });
  }
});

test('中途分片失败保留累计进度，不合并也不创建分享', async () => {
  const a = await app({ storage: 'Telegram (Bot API)' });
  await a.choose(file(21 * MB));
  const sending = a.el('sendBtn').click();
  await tick();
  a.xhrs[0].sent();
  a.xhrs[0].respond(200, chunkResult(a.xhrs[0]));
  await tick();
  a.xhrs[1].progress(1, 4);
  a.xhrs[1].respond(500, { error: '分片存储失败' });
  await sending;
  assert.equal(a.el('uploadProgressBar').value, 96);
  assert.equal(a.el('uploadProgress').dataset.status, 'error');
  assert.equal(a.requests.length, 0);
  assertUnlocked(a);
});

test('合并失败不能显示完成，即使所有文件字节已经发送', async () => {
  const a = await app({ storage: 'Telegram (Bot API)' });
  await a.choose(file(21 * MB));
  const sending = a.el('sendBtn').click();
  await tick();
  for (let i = 0; i < 2; i++) {
    a.xhrs[i].sent();
    a.xhrs[i].respond(200, chunkResult(a.xhrs[i]));
    await tick();
  }
  a.requests[0].respond({ error: '合并失败' }, 400);
  await sending;
  assert.equal(a.el('uploadProgressBar').value, 100);
  assert.equal(a.el('uploadProgress').dataset.status, 'error');
  assert.match(a.el('uploadProgressStatus').textContent, /合并失败/);
  assert.equal(a.el('sendResult').classList.contains('hidden'), true);
  assert.equal(a.requests.length, 1);
  assertUnlocked(a);
});

test('创建分享失败显示错误，换文件或清除文件时重置进度', async () => {
  const a = await app();
  await a.choose(file());
  const sending = a.el('sendBtn').click();
  a.xhrs[0].sent();
  a.xhrs[0].respond(200, uploadResult);
  await tick();
  a.requests[0].respond({ error: '取件码生成失败' }, 503);
  await sending;
  assert.equal(a.el('uploadProgress').dataset.status, 'error');
  assert.match(a.el('uploadProgressStatus').textContent, /取件码生成失败/);
  assert.equal(a.el('sendResult').classList.contains('hidden'), true);
  await a.el('fileClear').click();
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), true);
  assert.equal(a.el('uploadProgressBar').value, 0);
  assert.equal(a.el('uploadProgress').dataset.status, '');
  await a.choose(file(42));
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), true);
});

test('空文件与无可计算长度事件可正常完成', async () => {
  const a = await app({ storage: 'Telegram (Bot API)' });
  await a.choose(new File([], 'empty.bin'));
  const sending = a.el('sendBtn').click();
  assert.equal(a.xhrs[0].path, '/api/imgbed/upload');
  a.xhrs[0].progress(5, 10, false);
  a.xhrs[0].sent();
  a.xhrs[0].respond(200, uploadResult);
  await a.finishShare();
  await sending;
  assert.equal(a.el('uploadProgressBar').value, 100);
  assert.equal(a.el('uploadProgressDetail').textContent, '0 B / 0 B');
});

test('文本寄件不显示上传进度，无文件或空文本校验后仍可操作', async () => {
  const a = await app();
  await a.el('sendBtn').click();
  assert.equal(a.xhrs.length, 0);
  assertUnlocked(a);
  await a.segment('file').click();
  await a.el('sendBtn').click();
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), true);
  assertUnlocked(a);
  await a.segment('text').click();
  a.el('textInput').value = 'text share';
  const sending = a.el('sendBtn').click();
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), true);
  const share = await a.finishShare();
  assert.equal(share.opts.body.get('text'), 'text share');
  await sending;
  assert.equal(a.xhrs.length, 0);
  assert.equal(a.el('sendResult').classList.contains('hidden'), false);
  assert.equal(a.el('uploadProgress').classList.contains('hidden'), true);
  assertUnlocked(a);
});

test('文本寄件在发送前按 UTF-8 字节拒绝超限中文和 ASCII', async () => {
  for (const text of ['a'.repeat(222 * 1024 + 1), '界'.repeat(222 * 1024 / 3 + 1)]) {
    const a = await app();
    a.el('textInput').value = text;
    await a.el('sendBtn').click();
    assert.equal(a.requests.length, 0);
    assert.match(a.el('toast').textContent, /UTF-8/);
    assertUnlocked(a);
  }
});

test('主站取件防重入；网络或 5xx 后直接复用原 key，成功后新操作换 key', async () => {
  assert.doesNotMatch(script, /\bpendingCode\b/);
  for (const failure of ['network', '503']) {
    const a = await app();
    a.el('codeInput').value = 'ABCD2345';
    const first = a.el('receiveBtn').click();
    await a.el('receiveBtn').click();
    assert.equal(a.requests.length, 1);
    a.requests[0].respond({ has_password: false });
    await tick();
    const original = a.requests.at(-1);
    assert.match(original.opts.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/i);
    if (failure === 'network') original.fail(new TypeError('network lost after commit'));
    else original.respond({ error: 'temporary failure' }, 503);
    await first;
    const retry = a.el('receiveBtn').click();
    await tick();
    const repeated = a.requests.at(-1);
    assert.equal(repeated.path, '/api/share/ABCD2345/claim');
    assert.equal(repeated.opts.headers['Idempotency-Key'], original.opts.headers['Idempotency-Key']);
    assert.equal(a.requests.filter(r => !r.path.endsWith('/claim')).length, 1, '重试不得重新读取元信息');
    repeated.respond({ type: 'text', text: '<retried>' });
    await retry;
    assert.match(a.el('receiveOut').innerHTML, /&lt;retried&gt;/);
    const next = a.el('receiveBtn').click();
    a.requests.at(-1).respond({ has_password: false });
    await tick();
    const fresh = a.requests.at(-1);
    assert.notEqual(fresh.opts.headers['Idempotency-Key'], original.opts.headers['Idempotency-Key']);
    fresh.respond({ type: 'text', text: 'new request' });
    await next;
  }
});

test('主站更换取件码会丢弃结果未知的旧请求', async () => {
  const a = await app();
  a.el('codeInput').value = 'ABCD2345';
  const first = a.el('receiveBtn').click();
  a.requests.at(-1).respond({ has_password: false });
  await tick();
  const original = a.requests.at(-1);
  original.fail(new TypeError('network lost'));
  await first;
  a.el('codeInput').value = 'NEWCODE1';
  await a.el('codeInput').emit('input');
  const next = a.el('receiveBtn').click();
  assert.equal(a.requests.at(-1).path, '/api/share/NEWCODE1');
  a.requests.at(-1).respond({ has_password: false });
  await tick();
  const fresh = a.requests.at(-1);
  assert.notEqual(fresh.opts.headers['Idempotency-Key'], original.opts.headers['Idempotency-Key']);
  fresh.respond({ type: 'text', text: 'new share' });
  await next;
});

test('主站限流明确失败后允许更正密码，不能沿用旧密码', async () => {
  const a = await app();
  a.el('codeInput').value = 'ABCD2345';
  const start = a.el('receiveBtn').click();
  a.requests.at(-1).respond({ has_password: true });
  await start;
  a.el('receivePwd').value = 'wrong';
  const first = a.el('pwdSubmit').click();
  a.requests.at(-1).respond({ has_password: true });
  await tick();
  const original = a.requests.at(-1);
  original.respond({ error: 'rate limited' }, 429);
  await first;
  a.el('receivePwd').value = 'correct';
  const next = a.el('pwdSubmit').click();
  a.requests.at(-1).respond({ has_password: true });
  await tick();
  const fresh = a.requests.at(-1);
  assert.equal(fresh.opts.body.get('password'), 'correct');
  assert.notEqual(fresh.opts.headers['Idempotency-Key'], original.opts.headers['Idempotency-Key']);
  fresh.respond({ type: 'text', text: 'protected' });
  await next;
});
