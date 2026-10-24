// FileCodeBox-CF · API 处理函数
import * as db from './db.js';
import * as storage from './storage.js';
import {
  genCode,
  hashPassword,
  verifyPassword,
  fileToken,
  verifyUploadToken,
  isValidFileKey,
} from './auth.js';
import { getAdminSession } from './admin.js';
import { EXPIRE_PRESETS, DOWNLOAD_PRESETS, appName, appSubtitle } from './config.js';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function clientIp(request) {
  const fwd = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

// 过期判定：永久 = expire_at 为 null 或 0
export function isExpired(row, now = Date.now()) {
  return row.expire_at && row.expire_at !== 0 && row.expire_at <= now;
}
export function isDepleted(row) {
  return row.download_limit > 0 && row.downloads >= row.download_limit;
}

// POST /api/share  —— 创建分享（文本或文件）
export async function createShare({ request, env }) {
  let form;
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    // 把 JSON 包成伪 form，便于复用同一套逻辑
    form = {
      get(k) {
        return body[k] ?? null;
      },
      async formData() {
        return form;
      },
    };
  } else {
    form = await request.formData();
  }

  const type = form.get('type');
  const text = form.get('text');
  const password = form.get('password');

  let shareType = type ? String(type) : '';
  if (!shareType) shareType = form.get('file') ? 'file' : 'text';
  if (shareType !== 'text' && shareType !== 'file') {
    return json({ error: 'type 必须是 text 或 file' }, 400);
  }

  let row = {
    code: genCode(),
    type: shareType,
    created_at: Date.now(),
    upload_ip: clientIp(request),
    expire_at: null,
    download_limit: 0,
    password: null,
  };

  if (shareType === 'text') {
    if (typeof text !== 'string' || !text.trim()) return json({ error: '文本内容不能为空' }, 400);
    if (text.length > 222 * 1024) return json({ error: '文本过长（上限 222KB）' }, 413);
    row.text_content = text;
  } else {
    // 文件模式：file_key 由上传接口返回；upload_token 证明该 key 确实由本 Worker 产生，
    // 防止客户端随便引用他人文件（也防止删除时误删 ImgBed 上的任意对象）。
    const rawKey = form.get('file_key');
    if (!rawKey) {
      return json({ error: '请先通过 /api/imgbed/upload 上传文件，再提交 file_key' }, 400);
    }
    const fileKey = String(rawKey);
    if (!isValidFileKey(fileKey)) {
      return json({ error: '文件标识格式无效' }, 400);
    }
    const uploadTokenValue = form.get('upload_token');
    if (!uploadTokenValue || !(await verifyUploadToken(env, fileKey, String(uploadTokenValue)))) {
      return json({ error: '上传凭证无效或已过期，请重新上传文件' }, 401);
    }

    row.file_key = fileKey;
    row.file_name = String(form.get('file_name') || 'file').slice(0, 255);
    row.file_type = String(form.get('file_type') || 'application/octet-stream').slice(0, 255);
    const size = parseInt(String(form.get('file_size') ?? '0'), 10);
    row.file_size = Number.isFinite(size) && size >= 0 ? size : 0;
  }

  // 过期时间（毫秒，0/缺省=永久）
  const expireMs = parseInt(String(form.get('expire_ms') ?? '0'), 10);
  if (Number.isFinite(expireMs) && expireMs > 0) row.expire_at = row.created_at + expireMs;

  // 下载次数上限
  const dl = parseInt(String(form.get('download_limit') ?? '0'), 10);
  row.download_limit = Number.isFinite(dl) && dl > 0 ? dl : 0;

  // 访问密码
  if (password != null && String(password).length) {
    const plain = String(password);
    if (plain.length > 1024) return json({ error: '密码过长' }, 413);
    row.password = await hashPassword(plain);
  }

  await db.createShare(env.fcb_db, row);
  return json({
    code: row.code,
    type: row.type,
    expire_at: row.expire_at,
    download_limit: row.download_limit,
  });
}

// GET /api/share/:code  —— 查看分享元信息（不消耗次数）
export async function getShareMeta({ params, env }) {
  const row = await db.getShare(env.fcb_db, params.code);
  if (!row) return json({ error: '取件码不存在' }, 404);
  if (isExpired(row)) return json({ error: '该分享已过期', code: params.code, expired: true }, 410);
  if (isDepleted(row)) return json({ error: '该分享已达取件上限', code: params.code, depleted: true }, 410);

  const base = {
    code: row.code,
    type: row.type,
    expire_at: row.expire_at,
    download_limit: row.download_limit,
    downloads: row.downloads,
    has_password: !!row.password,
    remaining: row.download_limit > 0 ? Math.max(0, row.download_limit - row.downloads) : null,
  };
  if (row.type === 'file') {
    base.file_name = row.file_name;
    base.file_type = row.file_type;
    base.file_size = row.file_size;
  }
  return json(base);
}

// POST /api/share/:code/claim  —— 取件（原子消耗一次）
export async function claimShare({ request, params, env }) {
  const row = await db.getShare(env.fcb_db, params.code);
  if (!row) return json({ error: '取件码不存在' }, 404);
  if (isExpired(row)) return json({ error: '该分享已过期' }, 410);
  if (isDepleted(row)) return json({ error: '该分享已达取件上限' }, 410);

  // 密码校验
  if (row.password) {
    let provided = '';
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) {
      const b = await request.json().catch(() => ({}));
      provided = b.password || '';
    } else {
      const f = await request.formData().catch(() => null);
      provided = f ? f.get('password') || '' : '';
    }
    const ok = await verifyPassword(String(provided), row.password);
    if (!ok) return json({ error: '密码错误', requiresPassword: true }, 401);
  }

  if (row.type === 'file' && !isValidFileKey(row.file_key)) {
    return json({ error: '文件记录无效' }, 500);
  }

  // 条件 UPDATE：并发取件时最多只有一个请求能成功扣减，避免超发。
  const consumed = await db.consumeDownload(env.fcb_db, params.code);
  if (!consumed) return json({ error: '该分享已达取件上限或已过期' }, 410);

  if (row.type === 'text') {
    return json({ type: 'text', text: row.text_content });
  }

  // 文件：签发短时防直链 token（绑定 share code + file key），返回可直接访问的 URL。
  const token = await fileToken(env, row.file_key, params.code);
  const query = new URLSearchParams({ c: params.code, t: token });
  return json({
    type: 'file',
    file_name: row.file_name,
    file_type: row.file_type,
    file_size: row.file_size,
    url: `/file/${encodeURIComponent(row.file_key)}?${query.toString()}`,
  });
}

// ---------- 管理员 ----------

async function requireAdmin(env, request) {
  if ((await getAdminSession(env, request))?.scope !== 'admin') {
    return json({ error: '未授权' }, 401);
  }
  return null;
}

export async function adminStats(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  await db.ensureSchema(ctx.env.fcb_db);
  const total = await db.countShares(ctx.env.fcb_db);
  const active = await db.countActive(ctx.env.fcb_db);
  const now = Date.now();
  const expired = await ctx.env.fcb_db
    .prepare(`SELECT COUNT(*) AS c FROM shares WHERE (expire_at IS NOT NULL AND expire_at != 0 AND expire_at <= ?) OR (download_limit > 0 AND downloads >= download_limit)`)
    .bind(now)
    .first();
  return json({ total, active, expired: expired ? expired.c : 0 });
}

export async function adminList(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const rows = await db.listShares(ctx.env.fcb_db, 200, 0);
  return json({ shares: rows });
}

export async function adminDelete(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const code = ctx.params.code;
  const row = await db.getShare(ctx.env.fcb_db, code);
  if (!row) return json({ error: '不存在' }, 404);
  await db.deleteShare(ctx.env.fcb_db, code);
  if (row.type === 'file' && row.file_key) {
    // 同一对象可能被多个取件码引用，只有最后一个引用删除后才清理存储。
    const remaining = await db.countSharesByFileKey(ctx.env.fcb_db, row.file_key);
    if (remaining === 0) await storage.deleteFromImgBed(ctx.env, row.file_key);
  }
  return json({ ok: true });
}

export async function adminSweep(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const keys = await db.sweepExpired(ctx.env.fcb_db, Date.now());
  for (const k of [...new Set(keys)]) {
    const remaining = await db.countSharesByFileKey(ctx.env.fcb_db, k);
    if (remaining === 0) await storage.deleteFromImgBed(ctx.env, k);
  }
  return json({ cleaned: keys.length });
}

// GET /api/config  —— 前端公共配置
export async function publicConfig({ env }) {
  return json({
    name: appName(env),
    subtitle: appSubtitle(env),
    expirePresets: EXPIRE_PRESETS,
    downloadPresets: DOWNLOAD_PRESETS,
    storage: env.TG_BOT_TOKEN && env.TG_CHAT_ID ? 'Telegram (Bot API)' : 'CloudFlare-ImgBed (API)',
  });
}

export async function install({ env }) {
  // 自举建表：部署后访问 /api/install 即初始化 D1（幂等，可重复执行）
  await db.ensureSchema(env.fcb_db);
  return json({ ok: true, message: 'D1 数据库已初始化（表 shares 已就绪）' });
}

export async function health() {
  return json({ ok: true, service: 'filecodebox-cf', time: Date.now() });
}
