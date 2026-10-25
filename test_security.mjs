import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker from './src/worker.js';
import * as db from './src/db.js';
import { uploadToken } from './src/auth.js';
import { SHARE_SCHEMA_SQL } from './src/share-schema.js';
import { MAINTENANCE_SCHEMA_SQL } from './src/maintenance-schema.js';
import { MAX_TEXT_BYTES, MAX_SHARE_BODY_BYTES, FILE_TOKEN_TTL, AUTO_CLEANUP_INTERVAL_MS } from './src/config.js';
import { memoryD1, TEST_TEXT_KEY } from './tests/helpers.mjs';

function fixture(t) {
  const store = memoryD1();
  t.after(() => store.close());
  const queries = [];
  const prepare = store.prepare;
  store.prepare = sql => { queries.push(sql); return prepare(sql); };
  const env = { fcb_db: store, TEXT_ENCRYPTION_KEY: TEST_TEXT_KEY, FILE_SECRET: 'security-test-signing' };
  const send = async (path, init = {}, overrides = {}) => {
    const jobs = [];
    const response = await worker.fetch(new Request('https://security.test' + path, init), { ...env, ...overrides }, {
      waitUntil(promise) { jobs.push(promise); },
    });
    await Promise.all(jobs);
    return response;
  };
  const create = async (input = {}, overrides = {}) => {
    const response = await send('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'text', text: 'private text 汉字', ...input }),
    }, overrides);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).code;
  };
  const claim = (code, id = crypto.randomUUID(), input, extra = {}, overrides = {}) => send(`/api/share/${code}/claim`, {
    method: 'POST', headers: { 'Idempotency-Key': id, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, overrides);
  const row = code => store.prepare('SELECT * FROM shares WHERE code = ?').bind(code).first();
  return { store, queries, env, send, create, claim, row };
}

test('security schema matches migration; metadata never selects text or password hashes', async t => {
  assert.equal(SHARE_SCHEMA_SQL.trim(), readFileSync(new URL('./migrations/0003_share_security.sql', import.meta.url), 'utf8').trim());
  assert.equal(MAINTENANCE_SCHEMA_SQL.trim(), readFileSync(new URL('./migrations/0004_access_cleanup.sql', import.meta.url), 'utf8').trim());
  const f = fixture(t);
  const code = await f.create({ password: 'correct' });
  f.queries.length = 0;
  const response = await f.send(`/api/share/${code}`, {}, { TEXT_ENCRYPTION_KEY: '' });
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.has_password, true);
  assert.equal('text_content' in meta, false);
  assert.equal('password' in meta, false);
  assert.equal(f.queries.length, 1);
  assert.doesNotMatch(f.queries[0], /SELECT\s+\*|text_content/i);
  assert.match(f.queries[0], /password IS NOT NULL AS has_password/);
});

test('text is encrypted with random nonces, bound to its code and decrypted only after authentication', async t => {
  const f = fixture(t);
  const text = '<script>private-secret-汉字-🔐</script>';
  const a = await f.create({ text, password: 'correct' });
  const b = await f.create({ text });
  const stored = f.row(a).text_content;
  assert.match(stored, /^v1\.[\w-]{16}\.[\w-]+$/);
  assert.notEqual(stored, text);
  assert.ok(!stored.includes('private-secret'));
  assert.notEqual(stored, f.row(b).text_content);
  f.queries.length = 0;
  assert.equal((await f.claim(a, undefined, { password: 'wrong' })).status, 401);
  assert.ok(!f.queries.some(q => /SELECT text_content/.test(q)));
  const response = await f.claim(a, undefined, { password: 'correct' });
  assert.deepEqual(await response.json(), { type: 'text', text });
  f.store.prepare('UPDATE shares SET text_content = ? WHERE code = ?').bind(stored, b).run();
  assert.equal((await f.claim(b)).status, 503, '密文不能挪到另一个取件码');
  assert.equal(f.row(b).downloads, 0);
});

test('missing/wrong keys and corrupted or plaintext records fail closed without consuming quota', async t => {
  const f = fixture(t);
  for (const key of ['', 'not-hex', '00'.repeat(31)]) {
    const response = await f.send('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'secret' }),
    }, { TEXT_ENCRYPTION_KEY: key });
    assert.equal(response.status, 503);
  }
  await db.ensureSchema(f.store);
  assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM shares').first().c, 0);
  const code = await f.create({ download_limit: 1 });
  assert.equal((await f.claim(code, undefined, undefined, {}, { TEXT_ENCRYPTION_KEY: '34'.repeat(32) })).status, 503);
  assert.equal(f.row(code).downloads, 0);
  const original = f.row(code).text_content;
  const parts = original.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  for (const invalid of [parts.join('.'), 'legacy plaintext']) {
    f.store.prepare('UPDATE shares SET text_content = ? WHERE code = ?').bind(invalid, code).run();
    assert.equal((await f.claim(code)).status, 503);
    assert.equal(f.row(code).downloads, 0);
  }
  f.store.prepare('UPDATE shares SET text_content = ? WHERE code = ?').bind(original, code).run();
  assert.equal((await f.claim(code)).status, 200);
});

test('222 KiB is enforced as UTF-8 bytes for ASCII, Chinese, emoji and escaped JSON', async t => {
  const f = fixture(t);
  for (const unit of ['a', '界', '🔐']) {
    const count = MAX_TEXT_BYTES / new TextEncoder().encode(unit).byteLength;
    const text = unit.repeat(count);
    const code = await f.create({ text });
    assert.equal((await (await f.claim(code)).json()).text, text);
    const tooLarge = await f.send('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text + unit }),
    });
    assert.equal(tooLarge.status, 413);
  }
  const escaped = await f.send('/api/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"text":"' + '\\u0061'.repeat(MAX_TEXT_BYTES) + '"}',
  });
  assert.equal(escaped.status, 200, '应为合法 JSON 转义预留请求体空间');
  const invalid = await f.send('/api/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"\\ud800"}',
  });
  assert.equal(invalid.status, 400);
});

test('bounded streaming stops oversized bodies with missing, false or excessive Content-Length', async t => {
  const f = fixture(t);
  for (const declared of [undefined, '1', String(MAX_SHARE_BODY_BYTES + 1)]) {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await f.send('/api/share', {
      method: 'POST', duplex: 'half', body,
      headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': declared } : {}) },
    });
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(pulls, declared === String(MAX_SHARE_BODY_BYTES + 1) ? 0 : Math.ceil((MAX_SHARE_BODY_BYTES + 1) / 65536));
  }
  await db.ensureSchema(f.store);
  assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM shares').first().c, 0);
});

test('malformed JSON/forms and unsupported Content-Type are client errors, not 500', async t => {
  const f = fixture(t);
  for (const [type, body, status] of [
    ['text/plain', 'hello', 415], ['garbage', 'hello', 415],
    ['application/json', '{', 400], ['application/json', '[]', 400],
    ['application/json', 'null', 400],
    ['multipart/form-data', 'hello', 400],
    ['multipart/form-data; boundary=test', 'not multipart', 400],
  ]) {
    const response = await f.send('/api/share', { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(response.status, status, type);
  }
  const body = new URLSearchParams({ type: 'text', text: 'urlencoded 中文' });
  const response = await f.send('/api/share', { method: 'POST', body });
  assert.equal(response.status, 200);
  const code = (await response.json()).code;
  assert.equal((await (await f.claim(code)).json()).text, 'urlencoded 中文');
  for (const path of ['/api/imgbed/upload', '/api/chunk/upload']) {
    const invalid = await f.send(path, { method: 'POST', headers: { 'Content-Type': 'garbage' }, body: 'bad' },
      { TG_BOT_TOKEN: 'test', TG_CHAT_ID: 'test' });
    assert.equal(invalid.status, 415);
  }
});

test('claim requires a valid key, limits its body and shares no unauthenticated results', async t => {
  const f = fixture(t);
  const code = await f.create({ password: 'correct' });
  const emptyStream = await f.send(`/api/share/${code}/claim`, {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  });
  assert.equal(emptyStream.status, 401, '真实 Workers 的空 POST 可能仍有非 null body');
  for (const id of ['', 'short', 'a'.repeat(129), 'has invalid characters!']) {
    assert.equal((await f.claim(code, id)).status, 400);
  }
  assert.equal((await f.claim(code, undefined, { password: 'x'.repeat(20000) })).status, 413);
  const id = crypto.randomUUID();
  assert.equal((await f.claim(code, id, { password: 'correct' })).status, 200);
  assert.equal((await f.claim(code, id)).status, 401, '有回执也不能绕过密码');
  assert.equal((await f.claim(code, id, { password: 'wrong' })).status, 401);
  assert.equal(f.row(code).downloads, 1);
});

test('concurrent same-key claims consume once; distinct keys still respect quota', async t => {
  const f = fixture(t);
  const code = await f.create({ download_limit: 1 });
  const id = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.claim(code, id)));
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200, 200, 200, 200]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  bodies.forEach(body => assert.deepEqual(body, bodies[0]));
  assert.equal(f.row(code).downloads, 1);
  assert.equal((await f.claim(code)).status, 410);
  const other = await f.create({ download_limit: 1 });
  const race = await Promise.all(Array.from({ length: 6 }, () => f.claim(other)));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 410, 410, 410, 410, 410]);
  assert.equal(f.row(other).downloads, 1);
});

test('file replay returns identical URL without extending its token, and needs no text key', async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const code = await f.create({
    type: 'file', file_key: 'test-file', file_name: 'test.bin', file_size: 20,
    upload_token: await uploadToken(f.env, 'test-file'), download_limit: 1,
  }, { TEXT_ENCRYPTION_KEY: '' });
  const id = crypto.randomUUID();
  const first = await (await f.claim(code, id)).json();
  now += 30000;
  assert.deepEqual(await (await f.claim(code, id)).json(), first);
  assert.equal(f.row(code).downloads, 1);
  const receipt = f.store.prepare('SELECT * FROM claim_receipts WHERE code = ?').bind(code).first();
  assert.equal(receipt.expires_at - receipt.created_at, FILE_TOKEN_TTL);
  assert.equal('response' in receipt, false, '不在回执中复制正文或下载 URL');
});

test('claim transaction rolls back its receipt if the quota update fails', async t => {
  const f = fixture(t);
  const code = await f.create();
  const batch = f.store.batch;
  f.store.batch = statements => batch([...statements, f.store.prepare('INSERT INTO nonexistent_table VALUES (1)')]);
  await assert.rejects(() => db.consumeClaim(f.store, code, 'test-key-hash', Date.now() + FILE_TOKEN_TTL), /nonexistent_table/);
  assert.equal(f.row(code).downloads, 0);
  assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM claim_receipts').first().c, 0);
});

test('password checks are capped per IP/code and recover on the next fixed window', async t => {
  const f = fixture(t);
  let now = Math.floor(Date.now() / 300000) * 300000 + 1000;
  t.mock.method(Date, 'now', () => now);
  const code = await f.create({ password: 'correct' });
  for (let i = 0; i < 5; i++) assert.equal((await f.claim(code, undefined, { password: 'wrong' })).status, 401);
  const blocked = await f.claim(code, undefined, { password: 'correct' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(f.row(code).downloads, 0);
  now += 300000;
  assert.equal((await f.claim(code, undefined, { password: 'correct' })).status, 200);
  const attempts = f.store.prepare('SELECT * FROM share_attempts').all().results;
  assert.ok(attempts.every(row => /^[A-Za-z0-9_-]{43}$/.test(row.id)));
});

test('cross-IP password guessing is capped and successful checks refund the failure budget', async t => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => 1800000001000);
  const code = await f.create({ password: 'correct' });
  const ip = n => ({ 'CF-Connecting-IP': `192.0.2.${n}` });
  for (let i = 0; i < 4; i++) assert.equal((await f.claim(code, undefined, { password: 'wrong' }, ip(1))).status, 401);
  assert.equal((await f.claim(code, undefined, { password: 'correct' }, ip(1))).status, 200);
  for (let i = 0; i < 26; i++) assert.equal((await f.claim(code, undefined, { password: 'wrong' }, ip(i + 2))).status, 401);
  assert.equal((await f.claim(code, undefined, { password: 'wrong' }, ip(100))).status, 429);
  assert.equal(f.row(code).downloads, 1);
});

test('expired text is deleted immediately on metadata or claim access, including receipts', async t => {
  const f = fixture(t);
  for (const useClaim of [false, true]) {
    const code = await f.create();
    const id = crypto.randomUUID();
    assert.equal((await f.claim(code, id)).status, 200);
    f.store.prepare('UPDATE shares SET expire_at = ? WHERE code = ?').bind(Date.now() - 1, code).run();
    const response = useClaim ? await f.claim(code, id) : await f.send(`/api/share/${code}`);
    assert.equal(response.status, 410);
    assert.equal(f.row(code), null);
    assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM claim_receipts WHERE code = ?').bind(code).first().c, 0);
  }
});

test('daily access-triggered cleanup preserves active receipts and removes stale security state', async t => {
  const f = fixture(t);
  let now = 1800000001000;
  t.mock.method(Date, 'now', () => now);
  assert.match(readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8'), /crons = \[\]/);
  assert.equal(worker.scheduled, undefined);
  await f.send('/api/health'); // 首次访问建立全局下一次清理时间。
  now += AUTO_CLEANUP_INTERVAL_MS - 1000;
  const code = await f.create({ download_limit: 1 });
  const id = crypto.randomUUID();
  assert.equal((await f.claim(code, id)).status, 200);
  const expired = await f.create();
  f.store.prepare('UPDATE shares SET expire_at = ? WHERE code = ?').bind(now - 1, expired).run();
  f.store.prepare('INSERT INTO share_attempts VALUES (?, 1, ?)').bind('expired-attempt', now - 1).run();
  now += 1000;
  await f.send('/api/health');
  assert.ok(f.row(code), '清理不能破坏有效的幂等回执');
  assert.equal(f.row(expired), null);
  assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM share_attempts').first().c, 0);
  assert.equal((await f.claim(code, id)).status, 200);
  f.store.prepare('UPDATE claim_receipts SET expires_at = ?').bind(now - 1).run();
  await f.send('/api/health');
  assert.ok(f.row(code), '未到下一次清理间隔，不重复全库清理');
  now += AUTO_CLEANUP_INTERVAL_MS;
  await f.send('/api/health');
  assert.equal(f.row(code), null);
  for (const table of ['claim_receipts', 'share_attempts']) {
    assert.equal(f.store.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first().c, 0);
  }
});

test('D1 reserves one global cleanup slot per rolling 24 hours, including cold instances', async t => {
  const f = fixture(t);
  const now = 1800000001000;
  const results = await Promise.all(Array.from({ length: 8 }, () => db.reserveCleanup(f.store, now)));
  assert.equal(results.filter(r => r.acquired).length, 1);
  assert.ok(results.every(r => r.nextRun === now + AUTO_CLEANUP_INTERVAL_MS));
  const coldStore = { prepare: sql => f.store.prepare(sql), batch: statements => f.store.batch(statements) };
  const cold = await db.reserveCleanup(coldStore, now + AUTO_CLEANUP_INTERVAL_MS - 1);
  assert.equal(cold.acquired, false, '不能只依赖实例内存，每个新实例都清理一次');
  assert.equal(cold.nextRun, now + AUTO_CLEANUP_INTERVAL_MS);
  const next = await db.reserveCleanup(coldStore, now + AUTO_CLEANUP_INTERVAL_MS);
  assert.equal(next.acquired, true);
  assert.equal(next.nextRun, now + 2 * AUTO_CLEANUP_INTERVAL_MS);
  assert.equal(f.store.prepare('SELECT COUNT(*) AS c FROM maintenance_state').first().c, 1);
});

test('no traffic means no cleanup; warm requests do not repeat even the D1 gate query', async t => {
  const f = fixture(t);
  let now = 1800000001000;
  t.mock.method(Date, 'now', () => now);
  const code = await f.create();
  f.store.prepare('UPDATE shares SET expire_at = ? WHERE code = ?').bind(now - 1, code).run();
  f.queries.length = 0;
  now += AUTO_CLEANUP_INTERVAL_MS - 1;
  await f.send('/api/health');
  await f.send('/api/config');
  assert.equal(f.queries.length, 0, '同实例未到期不再查询/写入清理预约表');
  now += 3 * AUTO_CLEANUP_INTERVAL_MS;
  assert.ok(f.row(code), '时间流逝本身不会发出定时请求');
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected HTTP request'); });
  await f.send('/api/health');
  assert.equal(f.row(code), null);
  assert.equal(network.mock.callCount(), 0, '文本清理不发送额外 HTTP 请求');
});

test('static resources, unmatched routes and preflights do not start automatic cleanup', async t => {
  const f = fixture(t);
  for (const [method, path] of [['GET', '/'], ['GET', '/app.js'], ['GET', '/api/missing'], ['OPTIONS', '/api/health']]) {
    await f.send(path, { method });
  }
  assert.equal(f.queries.length, 0);
});

test('slow cleanup runs in waitUntil without blocking the response', async t => {
  const f = fixture(t);
  const prepare = f.store.prepare;
  let release;
  f.store.prepare = sql => {
    const statement = prepare(sql);
    if (/SELECT code, file_key FROM shares/.test(sql)) {
      statement.all = () => new Promise(resolve => { release = () => resolve({ results: [] }); });
    }
    return statement;
  };
  const jobs = [];
  const response = await worker.fetch(new Request('https://security.test/api/health'), f.env, {
    waitUntil(promise) { jobs.push(promise); },
  });
  assert.equal(response.status, 200);
  assert.equal(jobs.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  release();
  await Promise.all(jobs);
});

test('failed background cleanup leaves normal responses intact and does not retry immediately', async t => {
  const f = fixture(t);
  const log = t.mock.method(console, 'error', () => {});
  const prepare = f.store.prepare;
  f.store.prepare = sql => {
    if (/SELECT code, file_key FROM shares/.test(sql)) throw new Error('sensitive upstream details');
    return prepare(sql);
  };
  assert.equal((await f.send('/api/health')).status, 200);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ['[cleanup] background cleanup failed']);
  f.queries.length = 0;
  assert.equal((await f.send('/api/health')).status, 200);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(f.queries.length, 0);
});

test('public API, errors, file and preflight responses have no cross-origin grant', async t => {
  const f = fixture(t);
  const code = await f.create();
  for (const path of ['/api/config', '/api/health', `/api/share/${code}`, '/api/missing', '/file/test']) {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await f.send(path, { method, headers: { Origin: 'https://evil.test' } });
      for (const header of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods']) {
        assert.equal(response.headers.get(header), null, `${method} ${path}`);
      }
    }
  }
});
