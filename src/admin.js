// 单管理员 WebAuthn。持久化挑战、防重放及状态变更均由 D1 原子执行。
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { ensureSchema } from './db.js';
import {
  constantTimeEqual, hashPassword, verifyPassword, sha256, toBase64Url, fromBase64Url,
} from './auth.js';

const SESSION_COOKIE = '__Host-fcb_admin';
const CHALLENGE_COOKIE = '__Host-fcb_challenge';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const SETUP_TTL = 10 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const enc = new TextEncoder();
const randomCode = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const reply = (data, status = 200, cookie) => Response.json(data, {
  status, headers: cookie ? { 'Set-Cookie': cookie } : {},
});
const denied = () => reply({ error: '未授权，请重新验证' }, 401);
const cookieHeader = (name, value, ttl) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}`;

function cookie(request, name) {
  const value = (request.headers.get('Cookie') || '').split(';')
    .map(p => p.trim()).find(p => p.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

export function relyingParty(env) {
  // 明确固定域名，不能信任请求中的 Host/Origin 自动注册任意 RP。
  if (!env.ADMIN_ORIGIN) throw new Error('ADMIN_ORIGIN 未配置');
  const url = new URL(env.ADMIN_ORIGIN);
  if (url.origin !== env.ADMIN_ORIGIN ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('ADMIN_ORIGIN 必须是 HTTPS origin（本地可使用 http://localhost）');
  }
  return { origin: url.origin, rpID: url.hostname };
}

export function checkAdminRequest(request, env) {
  let rp;
  try { rp = relyingParty(env); }
  catch { return reply({ error: '管理员登录域名未正确配置' }, 503); }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return reply({ error: '禁止跨站请求' }, 403);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (request.headers.get('Origin') !== rp.origin) return reply({ error: '登录来源不被允许' }, 403);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
      return reply({ error: '请使用 JSON 请求' }, 415);
    }
  }
  return null;
}

async function body(request) {
  // WebAuthn 数据很小。流式限定大小，不依赖可伪造的 Content-Length。
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error('请求过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value = JSON.parse(new TextDecoder().decode(bytes) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效请求');
  return value;
}

async function state(db) {
  await ensureSchema(db);
  return db.prepare('SELECT * FROM admin_auth WHERE id = 1').first();
}

export async function cleanupAdmin(db) {
  const now = Date.now();
  await db.batch(['admin_sessions', 'admin_challenges', 'admin_attempts']
    .map(table => db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(now)));
}

async function rateLimit(db, request) {
  const now = Date.now();
  const id = await sha256(`${request.headers.get('CF-Connecting-IP') || 'local'}|${Math.floor(now / 300000)}`);
  const row = await db.prepare(`INSERT INTO admin_attempts (id, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`)
    .bind(id, now + 300000).first();
  return row.attempts > 30 ? reply({ error: '尝试过多，请 5 分钟后重试' }, 429) : null;
}

export async function getAdminSession(env, request) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  await ensureSchema(env.fcb_db);
  return env.fcb_db.prepare(`SELECT s.*, a.initialized, a.user_id FROM admin_sessions s
    JOIN admin_auth a ON a.id = 1 AND a.version = s.version
    WHERE s.id = ? AND s.expires_at > ?
      AND ((s.scope = 'bootstrap' AND a.initialized = 0)
        OR (s.scope IN ('admin', 'recovery') AND a.initialized = 1))`)
    .bind(await sha256(token), Date.now()).first();
}

async function sessionRecord(scope, version) {
  const token = randomCode();
  const ttl = scope === 'admin' ? SESSION_TTL : SETUP_TTL;
  const now = Date.now();
  return { token, id: await sha256(token), scope, version, now, expires: now + ttl, ttl };
}
function insertSession(db, s, condition = '1', params = []) {
  return db.prepare(`INSERT INTO admin_sessions (id, scope, version, created_at, expires_at)
    SELECT ?, ?, ?, ?, ? WHERE ${condition}`)
    .bind(s.id, s.scope, s.version, s.now, s.expires, ...params);
}
const sessionReply = (s, data) => reply(data, 200, cookieHeader(SESSION_COOKIE, s.token, s.ttl));

export async function status({ env, request }) {
  const a = await state(env.fcb_db);
  const s = await getAdminSession(env, request);
  return reply({ initialized: !!a.initialized, authenticated: s?.scope === 'admin', scope: s?.scope || null });
}

// API 密钥与备用码复用同一入口。二者都只能获取绑定会话，不能直接管理分享。
export async function login({ env, request }) {
  const db = env.fcb_db;
  const a = await state(db);
  const limited = await rateLimit(db, request);
  if (limited) return limited;
  let input;
  try { input = String((await body(request)).code || ''); }
  catch { return reply({ error: '无效请求' }, 400); }
  if (!input || input.length > 1024) return denied();
  if (!a.initialized) {
    if (!env.ADMIN_API_TOKEN || !constantTimeEqual(input, String(env.ADMIN_API_TOKEN))) return denied();
    const s = await sessionRecord('bootstrap', a.version);
    const result = await db.batch([insertSession(db, s, 'EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND initialized = 0 AND version = ?)', [a.version])]);
    if (result[0].meta.changes !== 1) return denied();
    return sessionReply(s, { scope: 'bootstrap' });
  }
  if (!(await verifyPassword(input, a.backup_hash))) return denied();
  const backupCode = randomCode();
  const hash = await hashPassword(backupCode);
  const s = await sessionRecord('recovery', a.version + 1);
  const operation = randomCode();
  const guard = 'EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND operation = ?)';
  const results = await db.batch([
    db.prepare(`UPDATE admin_auth SET backup_hash = ?, version = version + 1, operation = ?
      WHERE id = 1 AND initialized = 1 AND version = ? AND backup_hash = ?`)
      .bind(hash, operation, a.version, a.backup_hash),
    db.prepare(`DELETE FROM admin_sessions WHERE ${guard}`).bind(operation),
    db.prepare(`DELETE FROM admin_challenges WHERE ${guard}`).bind(operation),
    db.prepare(`DELETE FROM admin_credentials WHERE ${guard}`).bind(operation),
    insertSession(db, s, guard, [operation]),
  ]);
  if (results[0].meta.changes !== 1) return denied();
  // 新码只在本次响应中提供。恢复会话仅允许绑定新 Passkey，绑定成功才替换旧凭证。
  return sessionReply(s, { scope: 'recovery', backup_code: backupCode });
}

async function saveChallenge(db, options, sessionId, purpose, version) {
  const id = randomCode();
  await db.prepare(`INSERT INTO admin_challenges (id, session_id, purpose, challenge, version, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(id), sessionId, purpose, options.challenge, version, Date.now() + CHALLENGE_TTL).run();
  return { options, challengeId: id };
}
async function consumeChallenge(db, id, sessionId, purpose, version) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  // DELETE RETURNING：包括验签失败在内，每个挑战最多尝试一次。
  return db.prepare(`DELETE FROM admin_challenges WHERE id = ? AND session_id = ?
    AND purpose = ? AND version = ? AND expires_at > ? RETURNING challenge`)
    .bind(await sha256(id), sessionId, purpose, version, Date.now()).first();
}

async function freshSession(env, request) {
  const s = await getAdminSession(env, request);
  if (!s || (s.scope === 'admin' && Date.now() - s.created_at > CHALLENGE_TTL)) return null;
  return s;
}

export async function registrationOptions({ env, request }) {
  const s = await freshSession(env, request);
  if (!s) return denied();
  const db = env.fcb_db;
  const limited = await rateLimit(db, request);
  if (limited) return limited;
  await cleanupAdmin(db);
  const { results } = await db.prepare('SELECT id, transports FROM admin_credentials').all();
  const options = await generateRegistrationOptions({
    rpName: 'FileCodeBox 管理后台', rpID: relyingParty(env).rpID,
    userID: enc.encode(s.user_id), userName: 'admin',
    attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: results.map(c => ({ id: c.id, transports: JSON.parse(c.transports) })),
  });
  return reply(await saveChallenge(db, options, s.id, 'register', s.version));
}

// 绑定、恢复绑定和备用码轮换使用同一个版本 CAS，撤销旧会话并防止并发覆盖。
async function updateCredentials(db, s, credential, backupHash, replace = false) {
  const next = await sessionRecord('admin', s.version + 1);
  const operation = randomCode();
  const guard = 'EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND operation = ?)';
  const statements = [
    db.prepare(`UPDATE admin_auth SET initialized = 1, backup_hash = COALESCE(?, backup_hash),
      version = version + 1, operation = ? WHERE id = 1 AND version = ?
      AND initialized = ? AND EXISTS (SELECT 1 FROM admin_sessions WHERE id = ? AND expires_at > ?)`)
      .bind(backupHash, operation, s.version, s.scope === 'bootstrap' ? 0 : 1, s.id, Date.now()),
    db.prepare(`DELETE FROM admin_credentials WHERE ? = 1 AND ${guard}`).bind(replace ? 1 : 0, operation),
  ];
  if (credential) {
    statements.push(db.prepare(`INSERT INTO admin_credentials
      (id, public_key, counter, transports, device_type, backed_up, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(credential.id, toBase64Url(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports || []), credential.deviceType, credential.backedUp ? 1 : 0,
        Date.now(), operation));
  }
  statements.push(
    db.prepare(`DELETE FROM admin_sessions WHERE ${guard}`).bind(operation),
    db.prepare(`DELETE FROM admin_challenges WHERE ${guard}`).bind(operation),
    insertSession(db, next, guard, [operation]),
  );
  const result = await db.batch(statements);
  return result[0].meta.changes === 1 ? next : null;
}

export async function registrationVerify({ env, request }) {
  const s = await freshSession(env, request);
  if (!s) return denied();
  let b;
  try { b = await body(request); } catch { return reply({ error: '无效请求' }, 400); }
  const db = env.fcb_db;
  const challenge = await consumeChallenge(db, b.challengeId, s.id, 'register', s.version);
  if (!challenge) return reply({ error: '挑战已失效，请重新开始' }, 400);
  let info;
  try {
    const rp = relyingParty(env);
    const verification = await verifyRegistrationResponse({
      response: b.response, expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!verification.verified) throw new Error('verification failed');
    info = verification.registrationInfo;
  } catch { return reply({ error: 'Passkey 验证失败，请重新尝试' }, 400); }
  const backupCode = s.scope === 'recovery' ? null : randomCode();
  const next = await updateCredentials(db, s, {
    ...info.credential, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
  }, backupCode ? await hashPassword(backupCode) : null, s.scope === 'recovery');
  if (!next) return reply({ error: '登录状态已改变，请重新验证' }, 409);
  return sessionReply(next, { authenticated: true, backup_code: backupCode });
}

export async function authenticationOptions({ env, request }) {
  const db = env.fcb_db;
  const a = await state(db);
  const limited = await rateLimit(db, request);
  if (limited) return limited;
  if (!a.initialized) return reply({ error: '请先使用 API 密钥绑定 Passkey' }, 409);
  await cleanupAdmin(db);
  const token = randomCode();
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(env).rpID, userVerification: 'required',
  });
  return reply(await saveChallenge(db, options, await sha256(token), 'login', a.version),
    200, cookieHeader(CHALLENGE_COOKIE, token, CHALLENGE_TTL));
}

export async function authenticationVerify({ env, request }) {
  const db = env.fcb_db;
  const a = await state(db);
  const token = cookie(request, CHALLENGE_COOKIE);
  if (!token || !a.initialized) return denied();
  let b;
  try { b = await body(request); } catch { return reply({ error: '无效请求' }, 400); }
  const challenge = await consumeChallenge(db, b.challengeId, await sha256(token), 'login', a.version);
  if (!challenge) return reply({ error: '挑战已失效，请重新开始' }, 400);
  const id = typeof b.response?.id === 'string' ? b.response.id : '';
  const credential = await db.prepare('SELECT * FROM admin_credentials WHERE id = ?').bind(id).first();
  if (!credential) return denied();
  let info;
  try {
    const rp = relyingParty(env);
    const userHandle = b.response.response.userHandle;
    if (userHandle && userHandle !== toBase64Url(enc.encode(a.user_id))) throw new Error('user mismatch');
    const verification = await verifyAuthenticationResponse({
      response: b.response, expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id, publicKey: fromBase64Url(credential.public_key),
        counter: credential.counter, transports: JSON.parse(credential.transports) },
    });
    if (!verification.verified) throw new Error('verification failed');
    info = verification.authenticationInfo;
  } catch { return reply({ error: 'Passkey 验证失败，请重新尝试' }, 400); }
  const s = await sessionRecord('admin', a.version);
  const nonce = randomCode();
  const result = await db.batch([
    db.prepare(`UPDATE admin_credentials SET counter = ?, backed_up = ?, auth_nonce = ?
      WHERE id = ? AND counter = ? AND EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND version = ?)`)
      .bind(info.newCounter, info.credentialBackedUp ? 1 : 0, nonce, id, credential.counter, a.version),
    insertSession(db, s, `EXISTS (SELECT 1 FROM admin_credentials WHERE id = ? AND auth_nonce = ?)
      AND EXISTS (SELECT 1 FROM admin_auth WHERE id = 1 AND version = ?)`, [id, nonce, a.version]),
  ]);
  if (result[0].meta.changes !== 1) return denied();
  return sessionReply(s, { authenticated: true });
}

export async function rotateBackup({ env, request }) {
  const s = await freshSession(env, request);
  if (s?.scope !== 'admin') return denied();
  const backupCode = randomCode();
  const next = await updateCredentials(env.fcb_db, s, null, await hashPassword(backupCode));
  return next ? sessionReply(next, { backup_code: backupCode }) : denied();
}

export async function logout({ env, request }) {
  const token = cookie(request, SESSION_COOKIE);
  if (token) {
    await ensureSchema(env.fcb_db);
    const id = await sha256(token);
    await env.fcb_db.batch([
      env.fcb_db.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(id),
      env.fcb_db.prepare('DELETE FROM admin_challenges WHERE session_id = ?').bind(id),
    ]);
  }
  return reply({ ok: true }, 200, cookieHeader(SESSION_COOKIE, '', 0));
}
