import { toBase64Url, fromBase64Url } from './auth.js';
import { MAX_TEXT_BYTES } from './config.js';
import { HttpError } from './http.js';

const encoder = new TextEncoder();

async function key(env) {
  const value = env.TEXT_ENCRYPTION_KEY;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new HttpError(503, '未配置有效的 TEXT_ENCRYPTION_KEY（需要 64 位十六进制密钥）');
  }
  const bytes = new Uint8Array(value.match(/../g).map(byte => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(env, code, text) {
  if (!text.isWellFormed()) throw new HttpError(400, '文本包含无效的 Unicode 字符');
  if (text.length > MAX_TEXT_BYTES) throw new HttpError(413, '文本过长（UTF-8 上限 222 KiB）');
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_TEXT_BYTES) throw new HttpError(413, '文本过长（UTF-8 上限 222 KiB）');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`fcb-text-v1|${code}`),
  }, await key(env), bytes);
  return `v1.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptText(env, code, stored) {
  const secret = await key(env);
  try {
    if (typeof stored !== 'string' || stored.length > (MAX_TEXT_BYTES + 16) * 4 / 3 + 32) {
      throw new Error('Invalid ciphertext');
    }
    const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(stored);
    if (!match) throw new Error('Invalid ciphertext');
    const nonce = fromBase64Url(match[1]);
    const ciphertext = fromBase64Url(match[2]);
    if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_TEXT_BYTES + 16) {
      throw new Error('Invalid ciphertext');
    }
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`fcb-text-v1|${code}`),
    }, secret, ciphertext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new HttpError(503, '文本无法解密，请检查正文加密密钥或数据完整性');
  }
}
