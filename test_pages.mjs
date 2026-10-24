import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import gateway from './pages/_worker.js';

const origin = 'https://frontend.pages.dev';
const calls = [];
const env = {
  BACKEND: { async fetch(request) {
    calls.push(request);
    return new Response('backend', { status: 206, headers: { 'Content-Range': 'bytes 0-6/7' } });
  } },
  ASSETS: { async fetch() { return new Response('frontend'); } },
};

const body = new FormData();
body.set('file', new Blob(['test bytes']), 'test.bin');
const upload = await gateway.fetch(new Request(origin + '/api/imgbed/upload?x=1', {
  method: 'POST', headers: { Authorization: 'Bearer test-admin' }, body,
}), env);
assert.equal(upload.status, 206);
const forwarded = calls.pop();
assert.equal(forwarded.url, origin + '/api/imgbed/upload?x=1');
assert.equal(forwarded.method, 'POST');
assert.equal(forwarded.headers.get('Authorization'), 'Bearer test-admin');
assert.equal(forwarded.redirect, 'manual');
assert.equal(await (await forwarded.formData()).get('file').text(), 'test bytes');

for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
  const response = await gateway.fetch(new Request(origin + '/file/key?c=CODE&t=test-token', {
    method, headers: { Range: 'bytes=0-6' },
  }), env);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-6/7');
  const request = calls.pop();
  assert.equal(request.method, method);
  assert.equal(request.headers.get('Range'), 'bytes=0-6');
  assert.equal(new URL(request.url).searchParams.get('t'), 'test-token');
}
for (const path of ['/api', '/api/missing', '/file', '/file/missing']) {
  assert.equal(await (await gateway.fetch(new Request(origin + path), env)).text(), 'backend');
  calls.pop();
}
for (const path of ['/', '/app.js', '/api-docs']) {
  assert.equal(await (await gateway.fetch(new Request(origin + path), env)).text(), 'frontend');
}
const redirect = await gateway.fetch(new Request(origin + '/file/key'), {
  BACKEND: { fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://imgbed.test/file/key' } }) },
});
assert.equal(redirect.status, 302);
assert.equal(redirect.headers.get('Location'), 'https://imgbed.test/file/key');
const sessionCookie = '__Host-fcb_admin=test-session; Path=/; Secure; HttpOnly; SameSite=Strict';
const auth = await gateway.fetch(new Request(origin + '/api/admin/passkey/login/verify', {
  method: 'POST', headers: { Origin: origin, Cookie: '__Host-fcb_challenge=test-challenge',
    'Content-Type': 'application/json' }, body: '{"response":{}}',
}), {
  BACKEND: { fetch: async request => {
    assert.equal(request.headers.get('Origin'), origin);
    assert.equal(request.headers.get('Cookie'), '__Host-fcb_challenge=test-challenge');
    assert.equal(await request.text(), '{"response":{}}');
    return Response.json({ authenticated: true }, {
      headers: { 'Set-Cookie': sessionCookie, 'Cache-Control': 'no-store' },
    });
  } },
});
assert.equal(auth.headers.get('set-cookie'), sessionCookie);
assert.equal(auth.headers.get('cache-control'), 'no-store');
assert.equal((await auth.json()).authenticated, true);
const failure = await gateway.fetch(new Request(origin + '/api/health'), {});
assert.equal(failure.status, 502);
assert.equal(failure.headers.get('Cache-Control'), 'no-store');
assert.deepEqual(await failure.json(), { error: '后端服务暂时不可用' });

const routes = JSON.parse(readFileSync(new URL('./pages/_routes.json', import.meta.url)));
assert.deepEqual(routes.include, ['/api', '/api/*', '/file', '/file/*']);
assert.deepEqual(routes.exclude, []);
const headers = readFileSync(new URL('./pages/_headers', import.meta.url), 'utf8');
assert.match(headers, /Content-Security-Policy: default-src 'self'/);
console.log('Pages gateway: static routing, streaming upload, auth, query, methods, Range, redirects and fail-closed behavior passed.');
