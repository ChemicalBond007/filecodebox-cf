import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import gateway from './pickup/_worker.js';

const origin = 'https://pickup.test';
const filePath = '/file/test-key?c=ABCD2345&t=test-token';
const html = readFileSync(new URL('./pickup/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('./pickup/pickup.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pickup configuration is local, independent and limited to two public fields', async () => {
  let backendCalls = 0;
  const env = {
    PICKUP_NAME: 'pickupfiles', PICKUP_SUBTITLE: '独立取件服务',
    APP_NAME: 'https://main.test', APP_SUBTITLE: '主站专属文案',
    ADMIN_ORIGIN: 'https://main.test', FILE_SECRET: 'test-private-secret',
    IMG_BED_URL: 'https://storage.test',
    BACKEND: { fetch() {
      backendCalls++;
      throw new Error('Public config must not call the backend');
    } },
  };
  for (const path of ['/api/config', '/api/config/', '/api/config?storage=true']) {
    const response = await gateway.fetch(new Request(origin + path), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'pickupfiles', subtitle: '独立取件服务' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  assert.equal(backendCalls, 0);
  const defaults = await gateway.fetch(new Request(origin + '/api/config'), {
    APP_NAME: env.APP_NAME, APP_SUBTITLE: env.APP_SUBTITLE,
  });
  assert.deepEqual(await defaults.json(), { name: 'pickupfiles', subtitle: '输入取件码，领取文本或文件' });
  const custom = await gateway.fetch(new Request(origin + '/api/config'), {
    PICKUP_NAME: '自定义取件站', PICKUP_SUBTITLE: '',
  });
  assert.deepEqual(await custom.json(), { name: '自定义取件站', subtitle: '' });
});

test('gateway forwards only pickup routes and methods without admin credentials', async () => {
  const calls = [];
  const env = {
    BACKEND: { async fetch(request) {
      calls.push(request);
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'backend=private' } });
    } },
  };
  const routes = [
    ['GET', '/api/share/ABCD2345?x=1'],
    ['GET', '/api/share/ABCD2345/'],
    ['POST', '/api/share/ABCD2345/claim'],
    ['POST', '/api/share/ABCD2345/claim/'],
    ['GET', filePath],
    ['HEAD', filePath],
    ['GET', '/file/c%3Aencoded-key/?c=ABCD2345&t=test-token'],
  ];
  for (const [method, path] of routes) {
    const body = new FormData();
    body.set('password', 'test-password');
    const response = await gateway.fetch(new Request(origin + path, {
      method,
      headers: {
        Cookie: '__Host-fcb_admin=test-session', Authorization: 'Bearer private',
        Origin: origin, Range: 'bytes=0-6', 'Idempotency-Key': 'test-idempotency-key',
      },
      ...(method === 'POST' ? { body } : {}),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    const forwarded = calls.pop();
    assert.equal(forwarded.url, origin + path);
    assert.equal(forwarded.method, method);
    assert.equal(forwarded.redirect, 'manual');
    assert.equal(forwarded.headers.get('Cookie'), null);
    assert.equal(forwarded.headers.get('Authorization'), null);
    assert.equal(forwarded.headers.get('Origin'), origin);
    assert.equal(forwarded.headers.get('Range'), 'bytes=0-6');
    assert.equal(forwarded.headers.get('Idempotency-Key'), 'test-idempotency-key');
    if (method === 'POST') assert.equal((await forwarded.formData()).get('password'), 'test-password');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.equal((await response.json()).ok, true);
  }
});

test('gateway rejects upload, admin, install and unsupported methods before backend access', async () => {
  let calls = 0;
  const env = {
    BACKEND: { fetch() { calls++; throw new Error('Must not reach backend'); } },
    ASSETS: { fetch() { calls++; throw new Error('Must not serve SPA for blocked API'); } },
  };
  const routes = [
    ['GET', '/api'], ['GET', '/file'], ['GET', '/api/health'], ['GET', '/api/install'],
    ['POST', '/api/install'], ['POST', '/api/share'], ['POST', '/api/imgbed/upload'],
    ['POST', '/api/chunk/init'], ['POST', '/api/chunk/upload'], ['POST', '/api/chunk/merge'],
    ['GET', '/api/admin/status'], ['GET', '/api/admin/shares'], ['POST', '/api/admin/login'],
    ['POST', '/api/admin/passkey/login/options'], ['DELETE', '/api/admin/share/ABCD2345'],
    ['GET', '/api/share/ABCD2345/claim'], ['DELETE', '/api/share/ABCD2345'],
    ['POST', '/api/share/ABCD2345'], ['POST', '/api/config'], ['HEAD', '/api/config'],
    ['OPTIONS', '/api/config'], ['DELETE', filePath], ['POST', filePath], ['OPTIONS', filePath],
    ['GET', '/api/share/ABCD2345/claim/more'], ['GET', '/api/share/ABCD2345%2Fclaim'],
    ['GET', '/api/config%2f..%2fadmin/status'], ['GET', '/file/key/extra'],
  ];
  for (const [method, path] of routes) {
    const response = await gateway.fetch(new Request(origin + path, { method }), env);
    assert.equal(response.status, 404, `${method} ${path}`);
    if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'Not Found' });
    else assert.equal(await response.text(), '');
  }
  assert.equal(calls, 0);
});

test('gateway serves pickup assets and preserves Telegram streaming, Range and errors', async () => {
  const env = { ASSETS: { fetch: async () => new Response('pickup asset') } };
  for (const path of ['/', '/pickup.js', '/styles.css', '/api-docs']) {
    assert.equal(await (await gateway.fetch(new Request(origin + path), env)).text(), 'pickup asset');
  }
  for (const method of ['GET', 'HEAD']) {
    const response = await gateway.fetch(new Request(origin + filePath, { method }), {
      BACKEND: { fetch: async () => new Response(method === 'HEAD' ? null : 'content', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-6/20', 'Content-Type': 'application/octet-stream',
          'Content-Disposition': "attachment; filename*=UTF-8''test.bin" },
      }) },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-6/20');
    assert.match(response.headers.get('Content-Disposition'), /test\.bin/);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'content');
  }
  for (const status of [401, 404, 410]) {
    const response = await gateway.fetch(new Request(origin + '/api/share/ABCD2345'), {
      BACKEND: { fetch: async () => Response.json({ error: 'unavailable' }, { status }) },
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
  }
});

test('ImgBed redirects are followed server-side with safe request and response headers', async t => {
  const target = 'https://imgbed.test/file/test-key';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(options.method === 'HEAD' ? null : 'content', {
      status: 206,
      headers: {
        'Content-Length': '7', 'Content-Range': 'bytes 0-6/20', 'Accept-Ranges': 'bytes',
        ETag: '"test-version"', 'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'Content-Type': 'text/html', 'Content-Disposition': 'inline',
        Location: target, 'Content-Location': target, Refresh: `0; url=${target}`,
        'Set-Cookie': 'upstream=private', 'Access-Control-Allow-Origin': '*',
        'X-Upstream-Host': 'imgbed.test',
      },
    });
  });
  for (const method of ['GET', 'HEAD']) {
    const response = await gateway.fetch(new Request(origin + filePath, {
      method, headers: {
        Range: 'bytes=0-6', 'If-Range': '"test-version"',
        Cookie: 'private=cookie', Authorization: 'Bearer private', Origin: origin, Referer: origin,
      },
    }), {
      BACKEND: { fetch: async () => new Response(null, { status: 302, headers: { Location: target } }) },
    });
    assert.equal(response.status, 206);
    const { url, options } = calls.pop();
    assert.equal(url, target);
    assert.equal(options.method, method);
    assert.equal(options.redirect, 'follow');
    assert.deepEqual(Object.fromEntries(options.headers), {
      'accept-encoding': 'identity', 'if-range': '"test-version"', range: 'bytes=0-6',
    });
    for (const name of ['Location', 'Content-Location', 'Refresh', 'Set-Cookie', 'X-Upstream-Host',
      'Access-Control-Allow-Origin']) assert.equal(response.headers.get(name), null, name);
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(response.headers.get('Content-Disposition'), 'attachment');
    assert.equal(response.headers.get('Content-Length'), '7');
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-6/20');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('ETag'), '"test-version"');
    assert.equal(response.headers.get('Last-Modified'), 'Wed, 21 Oct 2026 07:28:00 GMT');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'content');
  }
});

test('ImgBed bodies stream without buffering and invalid ranges preserve Content-Range', async t => {
  const target = 'https://imgbed.test/file/test-key';
  let enqueue;
  const stream = new ReadableStream({
    start(controller) { enqueue = controller; },
  });
  let upstream = new Response(stream);
  t.mock.method(globalThis, 'fetch', async () => upstream);
  const env = {
    BACKEND: { fetch: async () => new Response(null, { status: 302, headers: { Location: target } }) },
  };
  const response = await gateway.fetch(new Request(origin + filePath), env);
  assert.equal(response.body, stream, '网关必须直接返回流，而非等待整个文件缓冲');
  const reader = response.body.getReader();
  enqueue.enqueue(new TextEncoder().encode('first'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  enqueue.enqueue(new TextEncoder().encode('second'));
  enqueue.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'second');
  assert.equal((await reader.read()).done, true);

  upstream = new Response('upstream error with a private address', {
    status: 416, headers: { 'Content-Range': 'bytes */20', 'Content-Length': '42' },
  });
  const invalidRange = await gateway.fetch(new Request(origin + filePath, {
    headers: { Range: 'bytes=100-200' },
  }), env);
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('Content-Range'), 'bytes */20');
  assert.equal(invalidRange.headers.get('Content-Length'), null);
  assert.equal(await invalidRange.text(), '');
});

test('gateway fails closed on bad redirects, backend failures and upstream errors', async t => {
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('private upstream address'); });
  for (const target of [null, '/file/key', 'data:text/html,unsafe', 'javascript:alert(1)',
    'file:///private', 'https://user:password@imgbed.test/file/key']) {
    const response = await gateway.fetch(new Request(origin + filePath), {
      BACKEND: { fetch: async () => new Response(null, {
        status: 302, headers: target === null ? {} : { Location: target },
      }) },
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Location'), null);
    assert.deepEqual(await response.json(), { error: '后端服务暂时不可用' });
  }
  assert.equal(networkCalls, 0);
  const unexpectedRedirect = await gateway.fetch(new Request(origin + '/api/share/ABCD2345'), {
    BACKEND: { fetch: async () => new Response(null, {
      status: 302, headers: { Location: 'https://main.test/' },
    }) },
  });
  assert.equal(unexpectedRedirect.status, 502);
  assert.equal(networkCalls, 0);

  for (const env of [{}, { BACKEND: { fetch: async () => { throw new Error('private backend address'); } } }]) {
    const response = await gateway.fetch(new Request(origin + '/api/share/ABCD2345'), env);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: '后端服务暂时不可用' });
  }
  const env = {
    BACKEND: { fetch: async () => new Response(null, {
      status: 302, headers: { Location: 'https://imgbed.test/file/key' },
    }) },
  };
  const networkFailure = await gateway.fetch(new Request(origin + filePath, { method: 'HEAD' }), env);
  assert.equal(networkFailure.status, 502);
  assert.equal(await networkFailure.text(), '');
  t.mock.method(globalThis, 'fetch', async () => new Response('https://private-upstream.test/failed', {
    status: 404, headers: { Location: 'https://private-upstream.test/' },
  }));
  const upstreamFailure = await gateway.fetch(new Request(origin + filePath), env);
  assert.equal(upstreamFailure.status, 404);
  assert.equal(upstreamFailure.headers.get('Location'), null);
  assert.deepEqual(await upstreamFailure.json(), { error: '文件下载失败，请稍后重试' });
});

class Element {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.value = '';
    this.disabled = false;
    this.children = [];
    this.style = {};
    this.events = new Map();
    this.className = attrs.class || '';
    const classes = new Set(this.className.split(/\s+/));
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { throw new Error('不能把分享内容作为 HTML 插入：' + value); }
  addEventListener(type, callback) { this.events.set(type, callback); }
  async emit(type) { return this.events.get(type)?.({ preventDefault() {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attrs[name] = value; }
  focus() { this.focused = true; }
}

async function app(handler, hash = '', config = { name: 'pickupfiles', subtitle: '独立取件服务' }) {
  const ids = new Map([...html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gi)].flatMap(([, tag]) => {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    return attrs.id ? [[attrs.id, new Element(attrs)]] : [];
  }));
  const events = new Map();
  const requests = [];
  const copied = [];
  const location = { origin, hash };
  ids.get('appName').textContent = html.match(/<h1 id="appName">([^<]*)<\/h1>/)[1];
  ids.get('appSubtitle').textContent = html.match(/<p id="appSubtitle">([^<]*)<\/p>/)[1];
  const document = {
    title: html.match(/<title>([^<]*)<\/title>/)[1],
    querySelector(selector) {
      const el = ids.get(selector.slice(1));
      assert.ok(el, '页面元素存在：' + selector);
      return el;
    },
    createElement: () => new Element(),
  };
  runInNewContext(script, {
    document, location, URL, FormData, crypto,
    window: { addEventListener: (type, fn) => events.set(type, fn) },
    navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    fetch: async (path, options) => {
      requests.push({ path, options });
      assert.equal(options.credentials, 'omit');
      const data = path === '/api/config' ? config : await handler(path, options);
      return data instanceof Response ? data : Response.json(data);
    },
    setTimeout: () => 0, clearTimeout() {},
  });
  await tick();
  return { el: id => ids.get(id), requests, copied, events, location, document };
}

test('pickup frontend normalizes codes, renders text safely and copies it', async () => {
  const text = '<img src=x onerror=alert(1)>&secret';
  const a = await app(path => path.endsWith('/claim') ? { type: 'text', text } : { has_password: false });
  assert.equal(a.document.title, 'pickupfiles · 取件');
  a.el('codeInput').value = 'abcd-2345';
  await a.el('receiveForm').emit('submit');
  assert.deepEqual(a.requests.map(r => r.path), [
    '/api/config', '/api/share/ABCD2345', '/api/share/ABCD2345/claim',
  ]);
  assert.equal(a.el('receiveOut').children[0].textContent, text);
  await a.el('receiveOut').children[1].emit('click');
  assert.deepEqual(a.copied, [text]);
  assert.equal(a.el('codeInput').disabled, false);
  assert.equal(a.el('receiveOut').attrs['aria-busy'], 'false');
});

test('pickup branding uses its own config and keeps independent defaults if config fails', async () => {
  const noShareRequests = () => { throw new Error('Startup must only request pickup config'); };
  const a = await app(noShareRequests, '', {
    name: '<独立取件站>', subtitle: '<b>仅用于取件</b>',
  });
  assert.deepEqual(a.requests.map(r => r.path), ['/api/config']);
  assert.equal(a.el('appName').textContent, '<独立取件站>');
  assert.equal(a.el('appSubtitle').textContent, '<b>仅用于取件</b>');
  assert.equal(a.document.title, '<独立取件站> · 取件');

  const unavailable = await app(noShareRequests, '', Response.json({ error: 'Unavailable' }, { status: 503 }));
  assert.equal(unavailable.el('appName').textContent, 'pickupfiles');
  assert.equal(unavailable.el('appSubtitle').textContent, '输入取件码，领取文本或文件');
  assert.equal(unavailable.document.title, 'pickupfiles · 取件');
  assert.deepEqual(unavailable.requests.map(r => r.path), ['/api/config']);
});

test('password pickup waits for confirmation, retries incorrect passwords and clears old passwords', async () => {
  let claims = 0;
  const a = await app((path, options) => {
    if (!path.endsWith('/claim')) return { has_password: true };
    claims++;
    return options.body.get('password') === 'correct'
      ? { type: 'text', text: 'protected' }
      : Response.json({ error: '密码错误' }, { status: 401 });
  });
  a.el('codeInput').value = 'ABCD2345';
  await a.el('receiveForm').emit('submit');
  assert.equal(claims, 0);
  assert.equal(a.el('pwdRow').classList.contains('hidden'), false);
  assert.equal(a.el('receivePwd').focused, true);
  a.el('receivePwd').value = 'wrong';
  await a.el('pwdRow').emit('submit');
  assert.equal(claims, 1);
  assert.match(a.el('receiveOut').textContent, /密码错误/);
  assert.equal(a.el('pwdRow').classList.contains('hidden'), false);
  a.el('receivePwd').value = 'correct';
  await a.el('pwdRow').emit('submit');
  assert.equal(claims, 2);
  assert.equal(a.el('receiveOut').children[0].textContent, 'protected');
  assert.equal(a.el('pwdRow').classList.contains('hidden'), true);
  assert.equal(a.el('receivePwd').value, '');

  a.el('codeInput').value = 'NEWCODE1';
  a.el('receivePwd').value = 'old-password';
  await a.el('codeInput').emit('input');
  assert.equal(a.el('receivePwd').value, '');
  await a.el('pwdRow').emit('submit');
  assert.equal(claims, 2, '更换取件码后必须重新确认密码');
});

test('pickup frontend prevents duplicate claims and supports hash links', async () => {
  let release;
  let claims = 0;
  const a = await app(path => {
    if (path.endsWith('/claim')) { claims++; return { type: 'text', text: 'once' }; }
    return new Promise(resolve => { release = resolve; });
  });
  a.el('codeInput').value = 'ABCD2345';
  const first = a.el('receiveForm').emit('submit');
  assert.equal(a.el('receiveBtn').disabled, true);
  await a.el('receiveForm').emit('submit');
  await a.el('pwdRow').emit('submit');
  release({ has_password: false });
  await first;
  assert.equal(claims, 1);
  assert.equal(a.el('receiveBtn').disabled, false);

  const b = await app(path => path.endsWith('/claim')
    ? { type: 'file', file_name: '<test>.bin', file_size: 2048, url: filePath }
    : { has_password: false }, '#r/abcd-2345');
  assert.equal(b.el('codeInput').value, 'abcd-2345');
  const result = b.el('receiveOut').children[0];
  assert.equal(result.children[0].textContent, '<test>.bin');
  assert.equal(result.children[1].textContent, '2.0 KB');
  assert.equal(result.children[2].href, filePath);
  assert.equal(result.children[2].download, '<test>.bin');
  b.location.hash = '#r/NEWCODE1';
  await b.events.get('hashchange')();
  assert.equal(b.requests.at(-1).path, '/api/share/NEWCODE1/claim');
});

test('pickup frontend shows expired-share errors and rejects off-site download URLs', async () => {
  const expired = await app(() => Response.json({ error: '该分享已过期' }, { status: 410 }));
  expired.el('codeInput').value = 'ABCD2345';
  await expired.el('receiveForm').emit('submit');
  assert.match(expired.el('receiveOut').textContent, /该分享已过期/);
  assert.equal(expired.el('receiveBtn').disabled, false);
  assert.equal(expired.requests.filter(r => r.path.endsWith('/claim')).length, 0);
  for (const url of ['https://main.test/file/key', '//main.test/file/key', 'javascript:alert(1)', '/api/admin']) {
    const a = await app(path => path.endsWith('/claim')
      ? { type: 'file', url } : { has_password: false });
    a.el('codeInput').value = 'ABCD2345';
    await a.el('receiveForm').emit('submit');
    assert.match(a.el('receiveOut').textContent, /下载地址无效/);
  }
});

test('pickup retries an uncertain claim directly with the same key, then rotates after success', async () => {
  for (const failure of ['network', '503']) {
    let claims = 0;
    const a = await app(path => {
      if (!path.endsWith('/claim')) return claims === 1
        ? Response.json({ error: '次数用尽' }, { status: 410 }) : { has_password: false };
      claims++;
      if (claims === 1) {
        if (failure === 'network') throw new TypeError('network lost after commit');
        return Response.json({ error: 'temporary failure' }, { status: 503 });
      }
      return { type: 'text', text: 'replayed' };
    });
    a.el('codeInput').value = 'ABCD2345';
    await a.el('receiveForm').emit('submit');
    const first = a.requests.at(-1).options.headers['Idempotency-Key'];
    assert.match(first, /^[0-9a-f-]{36}$/i);
    await a.el('receiveForm').emit('submit');
    assert.equal(a.requests.at(-1).options.headers['Idempotency-Key'], first);
    assert.equal(a.requests.filter(r => r.path === '/api/share/ABCD2345').length, 1);
    assert.equal(a.el('receiveOut').children[0].textContent, 'replayed');
    await a.el('receiveForm').emit('submit');
    assert.notEqual(a.requests.at(-1).options.headers['Idempotency-Key'], first);
  }
});

test('pickup clears an uncertain attempt when the code changes', async () => {
  let calls = 0;
  const a = await app(path => {
    if (!path.endsWith('/claim')) return { has_password: false };
    if (++calls === 1) throw new TypeError('network lost');
    return { type: 'text', text: 'new share' };
  });
  a.el('codeInput').value = 'ABCD2345';
  await a.el('receiveForm').emit('submit');
  const key = a.requests.at(-1).options.headers['Idempotency-Key'];
  a.el('codeInput').value = 'NEWCODE1';
  await a.el('codeInput').emit('input');
  await a.el('receiveForm').emit('submit');
  assert.equal(a.requests.at(-1).path, '/api/share/NEWCODE1/claim');
  assert.notEqual(a.requests.at(-1).options.headers['Idempotency-Key'], key);
});

test('pickup allows an edited password after an explicit rate-limit failure', async () => {
  let claims = 0;
  const a = await app((path, options) => {
    if (!path.endsWith('/claim')) return { has_password: true };
    if (++claims === 1) return Response.json({ error: 'rate limited' }, { status: 429 });
    assert.equal(options.body.get('password'), 'correct');
    return { type: 'text', text: 'protected' };
  });
  a.el('codeInput').value = 'ABCD2345';
  await a.el('receiveForm').emit('submit');
  a.el('receivePwd').value = 'wrong';
  await a.el('pwdRow').emit('submit');
  const old = a.requests.at(-1).options.headers['Idempotency-Key'];
  a.el('receivePwd').value = 'correct';
  await a.el('pwdRow').emit('submit');
  assert.notEqual(a.requests.at(-1).options.headers['Idempotency-Key'], old);
  assert.equal(a.el('receiveOut').children[0].textContent, 'protected');
});

test('pickup strips backend CORS but preserves password rate-limit status and Retry-After', async () => {
  const response = await gateway.fetch(new Request(origin + '/api/share/ABCD2345/claim', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
  }), { BACKEND: { fetch: async () => Response.json({ error: 'rate limited' }, {
    status: 429, headers: { 'Retry-After': '30', 'Access-Control-Allow-Origin': '*' },
  }) } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('pickup build contains only pickup assets and gateway files', async () => {
  await import('./scripts/build-pickup.mjs');
  const output = new URL('./.wrangler/pickup-dist/', import.meta.url);
  assert.deepEqual(readdirSync(output).sort(), [
    '_headers', '_routes.json', '_worker.js', 'index.html', 'pickup.js', 'styles.css',
  ]);
  for (const file of ['index.html', 'pickup.js', '_worker.js', '_routes.json', '_headers']) {
    assert.equal(readFileSync(new URL(file, output), 'utf8'),
      readFileSync(new URL('./pickup/' + file, import.meta.url), 'utf8'));
  }
  assert.equal(readFileSync(new URL('styles.css', output), 'utf8'),
    readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8'));
  assert.doesNotMatch(html, /admin|app\.js|view-send|upload|https?:\/\/(?!www\.w3\.org)/i);
  const routes = JSON.parse(readFileSync(new URL('./pickup/_routes.json', import.meta.url)));
  assert.deepEqual(routes.include, ['/api', '/api/*', '/file', '/file/*']);
  assert.deepEqual(routes.exclude, []);
  assert.equal(readFileSync(new URL('./pickup/_headers', import.meta.url), 'utf8'),
    readFileSync(new URL('./pages/_headers', import.meta.url), 'utf8'));
  const config = readFileSync(new URL('./pickup/wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /name = "pickupfiles"/);
  assert.match(config, /^PICKUP_NAME = "pickupfiles"$/m);
  assert.match(config, /^PICKUP_SUBTITLE = /m);
  assert.doesNotMatch(config, /^(APP_NAME|APP_SUBTITLE|ADMIN_ORIGIN) = /m);
  assert.match(config, /binding = "BACKEND"\r?\nservice = "filecodebox-cf"/);
  const { scripts } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.match(scripts['pickup:deploy'], /--project-name pickupfiles(?:\s|$)/);
  assert.equal(scripts['prepickup:deploy'], 'npm run pickup:build');
});

test('backend disables public HTTP routes while both Pages projects keep service bindings', () => {
  const backendConfig = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
  const topLevel = backendConfig.split(/^\[/m)[0];
  assert.match(topLevel, /^workers_dev = false$/m);
  assert.match(topLevel, /^preview_urls = false$/m);
  assert.match(topLevel, /^routes = \[\]$/m);
  for (const file of ['pages/wrangler.toml', 'pickup/wrangler.toml']) {
    const config = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
    assert.match(config, /binding = "BACKEND"\r?\nservice = "filecodebox-cf"/);
  }
});
