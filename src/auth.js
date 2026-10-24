// FileCodeBox-CF · 加密与鉴权工具
// 全部基于 Web Crypto（Cloudflare Workers 运行时原生提供）

import { FILE_TOKEN_TTL } from './config.js';

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const UPLOAD_TOKEN_TTL = 60 * 60 * 1000; // 上传凭证 1 小时
const CHUNK_TOKEN_TTL = 60 * 60 * 1000; // 分片凭证 1 小时

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 恒定时间字符串比较，避免通过响应时间猜测密钥/token。
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// HMAC-SHA256，返回 base64url 字符串
export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// SHA-256，返回 hex（仅用于兼容旧版密码哈希）
export async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return toHex(new Uint8Array(buf));
}

// ---------- 密码哈希（PBKDF2 + 随机盐，兼容旧 SHA-256） ----------

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const value = String(stored);

  if (value.startsWith('pbkdf2$')) {
    const parts = value.split('$');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;

    let salt;
    try {
      salt = fromBase64Url(parts[2]);
    } catch (e) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(password)),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256
    );
    return constantTimeEqual(toBase64Url(new Uint8Array(bits)), parts[3]);
  }

  // 兼容历史数据：旧记录是未加盐 SHA-256，仅用于校验，新记录一律 PBKDF2。
  const legacy = await sha256(String(password));
  return constantTimeEqual(legacy, value);
}

// ---------- 令牌签发 / 校验 ----------
//
// 令牌格式：<exp>.<HMAC(secret, payload|exp)>
// 时间戳在签名覆盖范围内，过期后不可继续使用。

function fileSecret(env) {
  const secret = env.FILE_SECRET || env.ADMIN_KEY || env.ADMIN_API_TOKEN;
  if (!secret) {
    throw new Error('未配置 FILE_SECRET（或 ADMIN_KEY / ADMIN_API_TOKEN），无法签发文件令牌');
  }
  return String(secret);
}

async function signToken(secret, payload, ttl) {
  const exp = Date.now() + ttl;
  const sig = await hmac(secret, `${payload}|${exp}`);
  return `${exp}.${sig}`;
}

async function verifyToken(secret, payload, token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmac(secret, `${payload}|${exp}`);
  return constantTimeEqual(sig, expected);
}

// 文件直链 token：绑定 share code + file key + 过期时间
export async function fileToken(env, key, code, ttl = FILE_TOKEN_TTL) {
  return signToken(fileSecret(env), `file|${code}|${key}`, ttl);
}

export async function verifyFileToken(env, key, code, token) {
  return verifyToken(fileSecret(env), `file|${code}|${key}`, token);
}

// 上传凭证：证明 file_key 确实由本 Worker 的上传接口产生，防止任意引用他人文件
export async function uploadToken(env, key, ttl = UPLOAD_TOKEN_TTL) {
  return signToken(fileSecret(env), `upload|${key}`, ttl);
}

export async function verifyUploadToken(env, key, token) {
  return verifyToken(fileSecret(env), `upload|${key}`, token);
}

// 分片凭证：绑定 file_id / size / index，防止 merge 时伪造任意 Telegram 文件
export async function chunkToken(env, fileId, size, index, ttl = CHUNK_TOKEN_TTL) {
  return signToken(fileSecret(env), `chunk|${fileId}|${size}|${index}`, ttl);
}

export async function verifyChunkToken(env, fileId, size, index, token) {
  return verifyToken(fileSecret(env), `chunk|${fileId}|${size}|${index}`, token);
}

// 文件标识白名单：禁止引号、斜杠、反斜杠、空白、`..` 等危险字符。
// Telegram 分片 key 为 "c:" + base64url(JSON)。
export function isValidFileKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 16384) return false;
  if (key.startsWith('c:')) return /^c:[A-Za-z0-9_-]+$/.test(key);
  if (key.includes('..')) return false;
  return /^[A-Za-z0-9._~+=-]{1,512}$/.test(key);
}

// 生成随机取件码（拒绝采样，避免取模偏差）
export function genCode(length = 8) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const limit = 256 - (256 % alphabet.length);
  let raw = '';
  while (raw.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array(length - raw.length));
    for (const byte of buf) {
      if (byte >= limit) continue;
      raw += alphabet[byte % alphabet.length];
      if (raw.length === length) break;
    }
  }
  return raw;
}

// 把规范化取件码渲染为 XXXX-XXXX 可读形式
export function formatCode(code, group = 4) {
  const s = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!group || group <= 0) return s;
  const parts = [];
  for (let i = 0; i < s.length; i += group) parts.push(s.slice(i, i + group));
  return parts.join('-');
}

// 生成随机 slug（保留给未来 R2 直连场景）
export function genKey() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return toHex(buf);
}
