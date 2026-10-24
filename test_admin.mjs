import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './src/worker.js';
import { ADMIN_SCHEMA_SQL } from './src/admin-schema.js';
import { memoryD1, TestPasskey } from './tests/helpers.mjs';

const origin = 'https://admin.example.com';
const db = memoryD1();
const env = { fcb_db: db, ADMIN_ORIGIN: origin, ADMIN_API_TOKEN: 'test-api-key', ADMIN_KEY: 'old-password' };
let clientId = 0;
function client() {
  const cookies = new Map();
  const ip = '192.0.2.' + ++clientId;
  const call = async (method, path, data, extra = {}) => {
    const headers = { Origin: origin, 'CF-Connecting-IP': ip,
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
    if (method !== 'GET') headers['Content-Type'] ??= 'application/json';
    const res = await worker.fetch(new Request(origin + '/api/admin/' + path, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    }), env, {});
    const set = res.headers.get('set-cookie');
    if (set) {
      assert.match(set, /HttpOnly; Secure; SameSite=Strict/);
      const [name, value] = set.split(';')[0].split('=');
      cookies.set(name, value);
    }
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    return res;
  };
  return { call, cookies };
}
const data = async res => {
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
async function registration(c, key, overrides) {
  const start = await data(await c.call('POST', 'passkey/register/options', {}));
  return c.call('POST', 'passkey/register/verify', {
    challengeId: start.challengeId, response: key.register(start.options, origin, overrides),
  });
}
async function authentication(c, key, overrides) {
  const start = await data(await c.call('POST', 'passkey/login/options', {}));
  return c.call('POST', 'passkey/login/verify', {
    challengeId: start.challengeId, response: key.authenticate(start.options, origin, overrides),
  });
}

try {
  assert.equal(ADMIN_SCHEMA_SQL.trim(), readFileSync(new URL('./migrations/0002_admin_passkeys.sql', import.meta.url), 'utf8').trim());
  const first = client(), second = client(), outsider = client();
  assert.deepEqual(await data(await first.call('GET', 'status')),
    { initialized: false, authenticated: false, scope: null });
  assert.equal((await outsider.call('POST', 'login', { code: env.ADMIN_API_TOKEN }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await outsider.call('POST', 'login', { code: env.ADMIN_API_TOKEN }, { Origin: '' })).status, 403);
  assert.equal((await outsider.call('POST', 'login', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await outsider.call('POST', 'login', { code: 'old-password' })).status, 401);
  assert.equal((await outsider.call('GET', 'stats', undefined, { Authorization: 'Bearer test-api-key' })).status, 401);
  assert.equal((await outsider.call('POST', 'login', { code: 'x'.repeat(70000) })).status, 400);
  await data(await first.call('POST', 'login', { code: env.ADMIN_API_TOKEN }));
  await data(await second.call('POST', 'login', { code: env.ADMIN_API_TOKEN }));
  assert.equal((await first.call('GET', 'stats')).status, 401, '首次 API 密钥不能直接管理');

  // 注册必须验证 origin、RP ID 和用户验证。
  const firstKey = new TestPasskey(), secondKey = new TestPasskey();
  assert.equal((await registration(first, firstKey, { client: { origin: 'https://evil.example' } })).status, 400);
  assert.equal((await registration(first, firstKey, { rpID: 'evil.example' })).status, 400);
  assert.equal((await registration(first, firstKey, { flags: 0x41 })).status, 400);
  const firstOptions = await data(await first.call('POST', 'passkey/register/options', {}));
  const otherOptions = await data(await second.call('POST', 'passkey/register/options', {}));
  const raced = await Promise.all([
    first.call('POST', 'passkey/register/verify', {
      challengeId: firstOptions.challengeId, response: firstKey.register(firstOptions.options, origin),
    }),
    second.call('POST', 'passkey/register/verify', {
      challengeId: otherOptions.challengeId, response: secondKey.register(otherOptions.options, origin),
    }),
  ]);
  assert.equal(raced.filter(r => r.ok).length, 1, '并发首次绑定只能有一个成功');
  const winner = raced[0].ok ? first : second;
  const key = raced[0].ok ? firstKey : secondKey;
  const registrationData = await data(raced.find(r => r.ok));
  let backup = registrationData.backup_code;
  assert.match(backup, /^[A-Za-z0-9_-]{43}$/);
  const stored = await db.prepare('SELECT backup_hash FROM admin_auth').first();
  assert.ok(stored.backup_hash.startsWith('pbkdf2$'));
  assert.ok(!stored.backup_hash.includes(backup));
  assert.equal((await winner.call('GET', 'stats')).status, 200);
  assert.equal((await outsider.call('POST', 'login', { code: env.ADMIN_API_TOKEN })).status, 401, '绑定后 API 密钥停用');
  assert.equal((await outsider.call('GET', 'stats', undefined, { Authorization: 'Bearer test-api-key' })).status, 401);

  await data(await winner.call('POST', 'logout', {}));
  assert.equal((await winner.call('GET', 'stats')).status, 401);
  const active = client();
  for (const overrides of [
    { client: { origin: 'https://evil.example' } }, { rpID: 'evil.example' },
    { flags: 0x01 }, { flags: 0x04 }, { client: { challenge: 'wrong' } },
  ]) {
    assert.equal((await authentication(client(), key, overrides)).status, 400);
  }
  const badSig = client();
  const sigStart = await data(await badSig.call('POST', 'passkey/login/options', {}));
  const signatureResponse = key.authenticate(sigStart.options, origin);
  signatureResponse.response.signature = Buffer.alloc(72).toString('base64url');
  assert.equal((await badSig.call('POST', 'passkey/login/verify', {
    challengeId: sigStart.challengeId, response: signatureResponse,
  })).status, 400, '伪造签名不能登录');
  assert.equal((await authentication(client(), new TestPasskey())).status, 401, '未知凭证不能登录');

  const start = await data(await active.call('POST', 'passkey/login/options', {}));
  const loginBody = { challengeId: start.challengeId, response: key.authenticate(start.options, origin) };
  assert.equal((await outsider.call('POST', 'passkey/login/verify', loginBody)).status, 401, '挑战绑定浏览器 Cookie');
  const replay = await Promise.all([active.call('POST', 'passkey/login/verify', loginBody),
    active.call('POST', 'passkey/login/verify', loginBody)]);
  assert.deepEqual(replay.map(r => r.status).sort(), [200, 400]);
  assert.equal((await active.call('POST', 'passkey/login/verify', loginBody)).status, 400);
  assert.equal((await active.call('GET', 'stats')).status, 200);
  assert.equal((await authentication(client(), key, { counter: 0 })).status, 400, '计数器不能倒退');
  const expired = client();
  const expiredStart = await data(await expired.call('POST', 'passkey/login/options', {}));
  await db.prepare('UPDATE admin_challenges SET expires_at = 0').run();
  assert.equal((await expired.call('POST', 'passkey/login/verify', {
    challengeId: expiredStart.challengeId, response: key.authenticate(expiredStart.options, origin),
  })).status, 400);

  // 同一个备用码的并发恢复仅一次成功，立即撤销会话和旧 Passkey。
  const recoverA = client(), recoverB = client();
  const recoveryRace = await Promise.all([
    recoverA.call('POST', 'login', { code: backup }),
    recoverB.call('POST', 'login', { code: backup }),
  ]);
  assert.deepEqual(recoveryRace.map(r => r.status).sort(), [200, 401]);
  const recovery = recoveryRace[0].ok ? recoverA : recoverB;
  const recovered = await data(recoveryRace.find(r => r.ok));
  assert.equal(recovered.scope, 'recovery');
  assert.match(recovered.backup_code, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(recovered.backup_code, backup);
  assert.equal((await active.call('GET', 'stats')).status, 401, '恢复撤销旧会话');
  assert.equal((await recovery.call('GET', 'stats')).status, 401, '恢复码不能跳过新 Passkey 绑定');
  assert.equal((await client().call('POST', 'login', { code: backup })).status, 401, '旧备用码不能复用');
  assert.equal((await authentication(client(), key)).status, 401, '恢复后旧 Passkey 立即停用');
  backup = recovered.backup_code;
  const replacement = new TestPasskey();
  assert.equal((await data(await registration(recovery, replacement))).backup_code, null, '恢复绑定保留刚生成的备用码');
  assert.equal((await recovery.call('GET', 'stats')).status, 200);
  await data(await authentication(client(), replacement));

  const additional = new TestPasskey();
  const added = await data(await registration(recovery, additional));
  assert.match(added.backup_code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await client().call('POST', 'login', { code: backup })).status, 401, '添加 Passkey 后旧备用码失效');
  const rotated = await data(await recovery.call('POST', 'backup/rotate', {}));
  assert.notEqual(rotated.backup_code, added.backup_code);
  const status = await data(await recovery.call('GET', 'status'));
  assert.equal(status.backup_code, undefined, '状态接口不能泄漏备用码');
  const sessionId = recovery.cookies.get('__Host-fcb_admin');
  const staleCookies = '__Host-fcb_admin=' + sessionId;
  await db.prepare('UPDATE admin_sessions SET created_at = 0').run();
  assert.equal((await recovery.call('POST', 'backup/rotate', {})).status, 401, '敏感操作需要最近验证');
  await db.prepare('UPDATE admin_sessions SET expires_at = 0').run();
  assert.equal((await recovery.call('GET', 'stats')).status, 401, '过期会话不能管理');
  assert.equal((await outsider.call('GET', 'stats', undefined, { Cookie: staleCookies })).status, 401);

  const throttled = client();
  for (let i = 0; i < 30; i++) assert.equal((await throttled.call('POST', 'login', { code: 'wrong' })).status, 401);
  assert.equal((await throttled.call('POST', 'login', { code: 'wrong' })).status, 429);
  console.log('Admin auth: real ECDSA signatures, UV/origin/RP checks, concurrent binding, challenge replay/expiry, cookie sessions, API key lockout, backup rotation/recovery and rate limits passed.');
} finally { db.close(); }
