// FileCodeBox-CF · Worker 入口
//
// 路由说明：
//   /api/share            POST  创建分享（文本 / 文件）
//   /api/share/:code      GET   查看分享元信息（不消耗）
//   /api/share/:code/claim POST 取件（消耗一次，文本直接返回 / 文件返回短时防直链 URL）
//   /api/imgbed/upload    POST  把文件流式代理到 ImgBed 的 /upload（原生支持大文件）
//   /file/:key?c=&t=      GET   校验短时 token + 分享状态后：ImgBed 302 / Telegram 服务端取回
//   /api/admin/*          *     WebAuthn 管理接口（HttpOnly 会话）
//   /api/install          GET/POST 初始化 D1（幂等）
//   /api/config、/api/health
//
// 安全要点：
//   · 管理员使用 WebAuthn 与有过期时间的 Cookie；文件/上传 token 使用 HMAC
//   · 文件响应统一 attachment + nosniff，避免上传 HTML/SVG 后在本站同源执行
//   · 管理接口不加通配 CORS；公开 API 保留 CORS

import * as api from './api.js';
import * as storage from './storage.js';
import * as db from './db.js';
import * as telegram from './telegram.js';
import * as admin from './admin.js';
import { isValidFileKey } from './auth.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function withSecurityHeaders(res, { cors = false, noStore = false } = {}) {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', CSP);
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (cors) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else {
    headers.delete('Access-Control-Allow-Origin');
  }
  if (noStore) headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

// 编译 "/api/share/:code/claim" -> 正则 + 参数名
function compile(pattern) {
  const names = [];
  const rx = pattern.replace(/:[^/]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp('^' + rx + '/?$'), names };
}

const ROUTES = [
  { method: 'GET', pattern: '/api/install', handler: api.install },
  { method: 'POST', pattern: '/api/install', handler: api.install },
  { method: 'GET', pattern: '/api/health', handler: api.health },
  { method: 'GET', pattern: '/api/config', handler: api.publicConfig },
  { method: 'POST', pattern: '/api/share', handler: api.createShare },
  { method: 'POST', pattern: '/api/imgbed/upload', handler: async (ctx) => {
    const env = ctx.env;
    // 配置了 Telegram（TG_BOT_TOKEN + TG_CHAT_ID）则直传 Telegram；否则走外部 ImgBed
    const r = (env.TG_BOT_TOKEN && env.TG_CHAT_ID)
      ? await telegram.uploadToTelegram(env, ctx.request)
      : await storage.uploadToImgBed(env, ctx.request);
    return api.json(r);
  } },
  // 客户端分块上传（init → 逐片 /api/chunk/upload → /api/chunk/merge），仅在 Telegram 模式可用。
  { method: 'POST', pattern: '/api/chunk/init', handler: async (ctx) => {
    const { env } = ctx;
    if (!(env.TG_BOT_TOKEN && env.TG_CHAT_ID)) return api.json({ error: '未启用 Telegram 存储' }, 400);
    return api.json({ chunkSize: telegram.CHUNK_SIZE });
  } },
  { method: 'POST', pattern: '/api/chunk/upload', handler: async (ctx) => {
    const { env } = ctx;
    if (!(env.TG_BOT_TOKEN && env.TG_CHAT_ID)) return api.json({ error: '未启用 Telegram 存储' }, 400);
    let form;
    try { form = await ctx.request.formData(); } catch (e) { return api.json({ error: '无效的分片上传请求' }, 400); }
    const file = form.get('file');
    const index = Number.parseInt(String(form.get('index') ?? '0'), 10);
    const fileName = String(form.get('fileName') || `part${String(index).padStart(3, '0')}`).slice(0, 255);
    if (!Number.isInteger(index) || index < 0) return api.json({ error: '分片序号无效' }, 400);
    if (!file || typeof file === 'string') return api.json({ error: '分片必须为文件' }, 400);
    try {
      const r = await telegram.uploadChunk(env, file, fileName, index);
      return api.json({ success: true, index, ...r });
    } catch (e) {
      if (e instanceof RangeError) return api.json({ error: e.message }, 413);
      console.error('[chunk upload]', e);
      return api.json({ error: '分片上传失败' }, 500);
    }
  } },
  { method: 'POST', pattern: '/api/chunk/merge', handler: async (ctx) => {
    const { env } = ctx;
    if (!(env.TG_BOT_TOKEN && env.TG_CHAT_ID)) return api.json({ error: '未启用 Telegram 存储' }, 400);
    const body = await ctx.request.json().catch(() => ({}));
    const chunks = body.chunks;
    try {
      const r = await telegram.verifyAndAssembleChunkedKey(env, chunks);
      const count = Array.isArray(chunks) ? chunks.length : 0;
      return api.json({ id: r.id, src: `tg://chunked:${count}`, upload_token: r.upload_token });
    } catch (e) {
      return api.json({ error: '分片校验失败：' + e.message }, 400);
    }
  } },
  { method: 'GET', pattern: '/api/share/:code', handler: api.getShareMeta },
  { method: 'POST', pattern: '/api/share/:code/claim', handler: api.claimShare },
  { method: 'GET', pattern: '/file/:key', handler: async (ctx) => {
    const { env, request, params } = ctx;
    const key = params.key;
    const code = new URL(request.url).searchParams.get('c') || '';

    if (!code) return api.json({ error: '无效或缺失的访问凭证' }, 403);
    if (!isValidFileKey(key)) return api.json({ error: '无效的文件标识' }, 400);

    const row = await db.getShare(env.fcb_db, code);
    if (!row || row.type !== 'file' || row.file_key !== key) {
      return api.json({ error: '文件不存在或已失效' }, 404);
    }
    if (api.isExpired(row)) return api.json({ error: '该分享已过期' }, 410);

    // 注：claim 已原子扣减一次；这里不能再按 downloads >= download_limit 拒绝，
    // 否则 download_limit=1 的首次下载会被误伤。token 本身 10 分钟后过期。
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      return telegram.serveFromTelegram(env, request, key, code, row);
    }
    return storage.serveFromImgBed(env, request, key, code);
  } },
  { method: 'GET', pattern: '/api/admin/status', handler: admin.status },
  { method: 'POST', pattern: '/api/admin/login', handler: admin.login },
  { method: 'POST', pattern: '/api/admin/passkey/register/options', handler: admin.registrationOptions },
  { method: 'POST', pattern: '/api/admin/passkey/register/verify', handler: admin.registrationVerify },
  { method: 'POST', pattern: '/api/admin/passkey/login/options', handler: admin.authenticationOptions },
  { method: 'POST', pattern: '/api/admin/passkey/login/verify', handler: admin.authenticationVerify },
  { method: 'POST', pattern: '/api/admin/backup/rotate', handler: admin.rotateBackup },
  { method: 'POST', pattern: '/api/admin/logout', handler: admin.logout },
  { method: 'GET', pattern: '/api/admin/stats', handler: api.adminStats },
  { method: 'GET', pattern: '/api/admin/shares', handler: api.adminList },
  { method: 'DELETE', pattern: '/api/admin/share/:code', handler: api.adminDelete },
  { method: 'POST', pattern: '/api/admin/sweep', handler: api.adminSweep },
].map((r) => ({ ...r, ...compile(r.pattern) }));

function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const adminPath = pathname.startsWith('/api/admin');
    const noStore = pathname.startsWith('/api/') || pathname.startsWith('/file/');
    const cors = !adminPath && (pathname.startsWith('/api/') || pathname.startsWith('/file/'));

    // HEAD 复用 GET 路由（文件服务支持 HEAD）
    const lookupMethod = method === 'HEAD' ? 'GET' : method;
    let found;
    try {
      found = match(lookupMethod, pathname);
    } catch (e) {
      return withSecurityHeaders(api.json({ error: '非法请求' }, 400), { cors, noStore });
    }

    if (found) {
      const context = { request, env, ctx, params: found.params };
      try {
        if (adminPath) {
          const denied = admin.checkAdminRequest(request, env);
          if (denied) return withSecurityHeaders(denied, { cors: false, noStore: true });
        }
        const res = await found.handler(context);
        const out = method === 'HEAD'
          ? new Response(null, { status: res.status, headers: res.headers })
          : res;
        return withSecurityHeaders(out, { cors, noStore });
      } catch (e) {
        console.error('[worker]', e);
        const err = api.json({ error: '服务器错误' }, 500);
        const out = method === 'HEAD'
          ? new Response(null, { status: err.status, headers: err.headers })
          : err;
        return withSecurityHeaders(out, { cors, noStore });
      }
    }

    // 预检
    if (method === 'OPTIONS') {
      const headers = new Headers();
      if (cors) {
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        headers.set('Access-Control-Max-Age', '86400');
      }
      headers.set('Allow', 'GET,POST,DELETE,OPTIONS');
      return withSecurityHeaders(new Response(null, { status: 204, headers }), { cors, noStore });
    }

    // 未匹配的 /api/* 返回 JSON 404，而不是 SPA HTML
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(api.json({ error: 'Not Found' }, 404), { cors: false, noStore: true });
    }

    // 其余交给静态资源（SPA）
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return withSecurityHeaders(res, { cors: false });
    }
    return withSecurityHeaders(new Response('Not Found', { status: 404 }), {});
  },

  // Cron Trigger：定期清理过期 / 超额分享
  async scheduled(event, env, ctx) {
    const keys = await db.sweepExpired(env.fcb_db, Date.now());
    await admin.cleanupAdmin(env.fcb_db);
    for (const k of [...new Set(keys)]) {
      ctx.waitUntil((async () => {
        const remaining = await db.countSharesByFileKey(env.fcb_db, k);
        if (remaining === 0) await storage.deleteFromImgBed(env, k);
      })());
    }
  },
};
