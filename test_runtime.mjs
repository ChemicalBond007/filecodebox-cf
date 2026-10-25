// 在真实 Workers 本地运行时验证静态资源路由、响应头与 D1 行为。
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bindTestAdmin } from './tests/helpers.mjs';

const testStorage = fileURLToPath(new URL(`./.wrangler/runtime-test-${crypto.randomUUID()}/`, import.meta.url));
mkdirSync(testStorage, { recursive: true });
// Windows 上 workerd 可能无法写入系统临时目录，统一使用项目内被忽略的目录。
if (process.platform === 'win32') {
  process.env.TEMP = testStorage;
  process.env.TMP = testStorage;
}
const { unstable_dev } = await import('wrangler');
const devOptions = {
  config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
  ip: '127.0.0.1',
  port: 0,
  local: true,
  persist: true,
  persistTo: testStorage,
  logLevel: 'error',
  vars: {
    ADMIN_API_TOKEN: 'runtime-test-admin',
    ADMIN_ORIGIN: 'https://admin.runtime.test',
    FILE_SECRET: 'runtime-test-signing-secret',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: '',
  },
  experimental: {
    disableExperimentalWarning: true,
    disableDevRegistry: true,
    watch: false,
    d1Databases: [{ binding: 'fcb_db', database_name: 'runtime-test', database_id: 'runtime-test' }],
  },
};
const worker = await unstable_dev(fileURLToPath(new URL('./src/worker.js', import.meta.url)), devOptions);

try {
  const home = await worker.fetch('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.ok(home.headers.get('content-security-policy'), '首页必须经过 Worker 添加安全响应头');
  await home.text();

  const navigation = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };
  const health = await worker.fetch('/api/health', { headers: navigation });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true, 'API 导航请求不得被 SPA 回退覆盖');
  const missing = await worker.fetch('/api/not-found', { headers: navigation });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Not Found');
  const denied = await worker.fetch('/file/missing', { headers: navigation });
  assert.equal(denied.status, 403, '浏览器下载导航必须经过文件鉴权');
  await denied.text();

  const create = await worker.fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'text', text: 'Workers runtime test', password: 'test-password', download_limit: 1,
    }),
  });
  assert.equal(create.status, 200);
  const { code } = await create.json();
  assert.match(code, /^[A-Z0-9]{8}$/);
  const noPassword = await worker.fetch(`/api/share/${code}/claim`, { method: 'POST' });
  assert.equal(noPassword.status, 401);
  await noPassword.text();
  const claims = await Promise.all([1, 2].map(() => worker.fetch(`/api/share/${code}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  })));
  assert.deepEqual(claims.map(r => r.status).sort(), [200, 410], 'D1 必须原子执行取件次数限制');
  for (const response of claims) {
    const body = await response.json();
    if (response.ok) assert.equal(body.text, 'Workers runtime test');
  }

  const adminCall = (method, path, body, headers = {}) => worker.fetch(path, {
    method, headers: { Origin: 'https://admin.runtime.test', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const admin = await bindTestAdmin(adminCall, 'runtime-test-admin', 'https://admin.runtime.test');
  const locked = await adminCall('POST', '/api/admin/login', { code: 'runtime-test-admin' });
  assert.equal(locked.status, 401);
  await locked.text();
  const logout = await adminCall('POST', '/api/admin/logout', {}, { Cookie: admin.cookie });
  assert.equal(logout.status, 200);
  await logout.text();
  const loggedOut = await adminCall('GET', '/api/admin/stats', undefined, { Cookie: admin.cookie });
  assert.equal(loggedOut.status, 401);
  await loggedOut.text();
  const options = await adminCall('POST', '/api/admin/passkey/login/options', {});
  assert.equal(options.status, 200);
  const challengeCookie = options.headers.get('set-cookie').split(';')[0];
  const loginStart = await options.json();
  const loginBody = {
    challengeId: loginStart.challengeId,
    response: admin.key.authenticate(loginStart.options, 'https://admin.runtime.test'),
  };
  const logins = await Promise.all([1, 2].map(() => adminCall('POST', '/api/admin/passkey/login/verify',
    loginBody, { Cookie: challengeCookie })));
  assert.deepEqual(logins.map(r => r.status).sort(), [200, 400], '真实 D1 挑战只能消费一次');
  let sessionCookie;
  for (const response of logins) {
    if (response.ok) sessionCookie = response.headers.get('set-cookie').split(';')[0];
    await response.text();
  }
  const stats = await adminCall('GET', '/api/admin/stats', undefined, { Cookie: sessionCookie });
  assert.equal(stats.status, 200);
  await stats.text();
  const recoveries = await Promise.all([1, 2].map(() =>
    adminCall('POST', '/api/admin/login', { code: admin.backupCode })));
  assert.deepEqual(recoveries.map(r => r.status).sort(), [200, 401], '真实 D1 备用码只能恢复一次');
  for (const response of recoveries) await response.text();
  const revoked = await adminCall('GET', '/api/admin/stats', undefined, { Cookie: sessionCookie });
  assert.equal(revoked.status, 401);
  await revoked.text();
  console.log('Workers runtime: routing, atomic claims, real WebAuthn signatures, API key lockout, concurrent challenge/recovery and session revocation passed.');
} finally {
  await worker.stop();
}

const downloads = await unstable_dev(
  fileURLToPath(new URL('./tests/telegram-runtime-worker.mjs', import.meta.url)), devOptions);
try {
  for (const mode of ['single', 'chunked']) {
    for (const [range, expected, contentRange] of [
      ['bytes=2-6', 'cdefg', 'bytes 2-6/10'],
      ['bytes=7-', 'hij', 'bytes 7-9/10'],
      ['bytes=-3', 'hij', 'bytes 7-9/10'],
    ]) {
      const response = await downloads.fetch(`/api/${mode}`, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('Content-Range'), contentRange);
      assert.equal(response.headers.get('Content-Length'), String(expected.length),
        '真实 Workers 响应必须保留部分内容的准确长度');
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
      assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
      assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
      assert.equal(await response.text(), expected);
    }
    const invalid = await downloads.fetch(`/api/${mode}`, { headers: { Range: 'bytes=10-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await invalid.text(), '');
    const head = await downloads.fetch(`/api/${mode}`, {
      method: 'HEAD', headers: { Range: 'bytes=999-' },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), '10');
    assert.equal(head.headers.get('Content-Range'), null);
    assert.equal(await head.text(), '');
    const full = await downloads.fetch(`/api/${mode}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('Content-Length'), '10');
    assert.equal(await full.text(), 'abcdefghij');
  }
  const empty = await downloads.fetch('/api/empty', { headers: { Range: 'bytes=0-' } });
  assert.equal(empty.status, 416);
  assert.equal(empty.headers.get('Content-Range'), 'bytes */0');
  assert.equal(await empty.text(), '');
  console.log('Workers runtime: Telegram single/chunked Range, Content-Length, 416, HEAD and pickup forwarding passed.');
} finally {
  await downloads.stop();
}
