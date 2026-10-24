// 本地预览适配服务（仅用于开发/预览，不依赖 wrangler）
//
// 用真实的 src/worker.js 跑后端，并内嵌一个本地 ImgBed mock 替代真实 ImgBed 实例：
//   · ImgBed mock 监听 127.0.0.1:8790（纯根路径，与真实部署一致）
//       POST /upload                  -> 返回 { src }
//       GET  /file/:id                -> 返回文件内容
//       DELETE /api/manage/delete/:id -> 删除
//   · 主服务(8000) 额外提供 /__imgbed-file/:id 作为「浏览器可达」的文件代理：
//       Worker 的 /file/:key 302 跳转到 127.0.0.1:8790/file/:id（内部），
//       适配器改写为同源的 /__imgbed-file/:id，浏览器跟随后由本代理回源 ImgBed mock。
// 这样 /api/imgbed/upload、302 跳转、删除/清理都能端到端跑通。
// 元数据用 node:sqlite 充当本地 D1（fcb_db），静态前端由 ASSETS 绑定从 public/ 提供。

import http from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const IMGBED_PORT = 8790;
const USE_REAL_IMGBED = process.env.FCB_IMGBED_REAL === '1';
const IMG_BED_URL = process.env.FCB_IMGBED_URL || `http://127.0.0.1:${IMGBED_PORT}`;

const USE_TG_MOCK = process.env.FCB_TG_MODE === '1';

// Telegram 存储 mock（仅 FCB_TG_MODE=1 时启用）：拦截 api.telegram.org 的 Bot API 调用，
// 在内存中模拟 sendDocument / getFile / file 取回，便于本地端到端验证 Telegram 存储逻辑。
const tgStore = new Map();
let tgCounter = 0;
async function mockTelegram(urlStr, opts) {
  const u = new URL(urlStr);
  let sub;
  const m = u.pathname.match(/^\/bot[^/]+(\/.*)$/); // /bot<token>/sendDocument、/bot<token>/getFile
  if (m) sub = m[1];
  else {
    const fm = u.pathname.match(/^\/file\/bot[^/]+(\/.*)$/); // /file/bot<token>/tgfiles/<id>
    sub = fm ? '/file' + fm[1] : u.pathname;
  }
  if (sub === '/sendDocument' && opts && opts.method === 'POST') {
    const fd = await new Request(urlStr, opts).formData();
    const file = fd.get('document');
    const id = 'tg-' + (++tgCounter);
    const buf = Buffer.from(await file.arrayBuffer());
    tgStore.set(id, { bytes: buf, contentType: file.type || 'application/octet-stream', fileName: file.name || 'file' });
    return new Response(JSON.stringify({ ok: true, result: { document: { file_id: id, file_name: file.name || 'file', file_size: buf.length } } }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (sub === '/getFile') {
    const id = u.searchParams.get('file_id');
    if (tgStore.has(id)) return new Response(JSON.stringify({ ok: true, result: { file_path: 'tgfiles/' + id } }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: false, description: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (sub.startsWith('/file/tgfiles/')) {
    const id = sub.slice('/file/tgfiles/'.length);
    const f = tgStore.get(id);
    if (!f) return new Response('not found', { status: 404 });
    return new Response(f.bytes, { headers: { 'Content-Type': f.contentType, 'Content-Length': String(f.bytes.length) } });
  }
  return new Response('mock telegram 404: ' + sub, { status: 404 });
}
if (USE_TG_MOCK) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url);
    if (u && u.includes('api.telegram.org')) return mockTelegram(u, opts);
    return realFetch(url, opts);
  };
  console.log('[preview] Telegram 存储 mock 已启用（拦截 api.telegram.org）');
}

// ---------- 本地 D1 mock（node:sqlite） ----------
const sqlite = new DatabaseSync(':memory:');
// 不在启动时手动建表：改为由 Worker 自举 ensureSchema 在首次访问时建表（与线上一致）
class Stmt {
  constructor(db, q) { this.db = db; this.q = q; this.params = []; }
  bind(...p) { this.params = p; return this; }
  _all() { return this.db.prepare(this.q).all(...this.params); }
  first() { const r = this._all(); return r.length ? r[0] : null; }
  all() { return { results: this._all() }; }
  run() {
    const result = this.db.prepare(this.q).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}
const fcb_db = {
  prepare: (q) => new Stmt(sqlite, q),
  batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(s => s.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};

// ---------- ImgBed mock（监听 127.0.0.1:8790） ----------
const store = new Map(); // id -> { bytes, contentType }
let counter = 0;
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function parseMultipartFile(buf, contentType) {
  const m = /boundary=(.*?)(;|$)/.exec(contentType || '');
  if (!m) return buf;
  const boundary = Buffer.from('--' + m[1].trim());
  const sep = Buffer.from('\r\n\r\n');
  const parts = [];
  let start = buf.indexOf(boundary);
  while (start >= 0) {
    const after = start + boundary.length;
    let end = buf.indexOf(boundary, after);
    if (end < 0) end = buf.length;
    parts.push(buf.subarray(after, end));
    if (end === buf.length) break;
    start = end;
  }
  for (const part of parts) {
    if (part.includes(Buffer.from('filename='))) {
      const h = part.indexOf(sep);
      if (h >= 0) {
        let content = part.subarray(h + 4);
        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) content = content.subarray(0, content.length - 2);
        return content;
      }
    }
  }
  return buf;
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const imgbedServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, IMG_BED_URL);
  const p = url.pathname;
  if (p === '/upload' && req.method === 'POST') {
    const buf = await readBody(req);
    const id = 'img-' + (++counter);
    store.set(id, { bytes: parseMultipartFile(buf, req.headers['content-type']), contentType: 'application/octet-stream' });
    sendJson(res, 200, { src: `${IMG_BED_URL}/file/${id}`, url: `${IMG_BED_URL}/file/${id}` });
    return;
  }
  if (p.startsWith('/file/') && req.method === 'GET') {
    const id = p.slice('/file/'.length);
    const f = store.get(id);
    if (!f) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': f.contentType });
    res.end(f.bytes);
    return;
  }
  if (p.startsWith('/api/manage/delete/') && req.method === 'DELETE') {
    const id = p.slice('/api/manage/delete/'.length);
    store.delete(id);
    res.writeHead(200); res.end('ok');
    return;
  }
  res.writeHead(404); res.end('imgbed mock 404');
});

// ---------- ASSETS 绑定（提供 public/ 静态资源） ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const ASSETS = {
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const filePath = path.join(PUBLIC, p);
    if (filePath.startsWith(PUBLIC) && existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const type = MIME[ext] || 'application/octet-stream';
      return new Response(await readFile(filePath), { headers: { 'Content-Type': type } });
    }
    return new Response(await readFile(path.join(PUBLIC, 'index.html')), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

const env = {
  fcb_db,
  ASSETS,
  IMG_BED_URL,
  IMG_BED_UPLOAD_TOKEN: process.env.FCB_IMGBED_UPLOAD_TOKEN || '',
  IMG_BED_UPLOAD_TOKEN_PARAM: process.env.FCB_IMGBED_UPLOAD_TOKEN_PARAM || '',
  TG_BOT_TOKEN: USE_TG_MOCK ? (process.env.FCB_TG_TOKEN || '12345:fakeToken') : '',
  TG_CHAT_ID: USE_TG_MOCK ? (process.env.FCB_TG_CHAT || '-100123456') : '',
  ADMIN_KEY: 'preview-admin',
  ADMIN_API_TOKEN: process.env.FCB_ADMIN_API_TOKEN || '',
  ADMIN_ORIGIN: process.env.FCB_ADMIN_ORIGIN || `http://localhost:${PORT}`,
  FILE_SECRET: 'preview-file-secret',
  APP_NAME: '文件快递柜',
  APP_SUBTITLE: '本地预览 · 委托 CloudFlare-ImgBed（mock）',
  IMG_BED_ADMIN_TOKEN: 'preview-imgbed-admin',
};

// ---------- 主服务：Node HTTP <-> Web Standard Request/Response ----------
async function proxyToImgBed(res, id) {
  // 用 URL 构造避免 IMG_BED_URL 结尾斜杠导致 //file/ 双斜杠（会触发 ImgBed SPA 回退返回 HTML）
  const target = new URL('/file/' + id, IMG_BED_URL).toString();
  const up = await fetch(target);
  res.writeHead(up.status, Object.fromEntries(up.headers.entries()));
  if (up.body) {
    const reader = up.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    // 浏览器可达的 ImgBed 文件代理
    if (url.pathname.startsWith('/__imgbed-file/')) {
      return proxyToImgBed(res, url.pathname.slice('/__imgbed-file/'.length));
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? Readable.toWeb(req) : undefined;
    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body,
      duplex: 'half',
    });
    const response = await worker.fetch(request, env, { waitUntil() {} });

    // 把 Worker 返回的内部绝对 302 改写为同源相对路径，浏览器才能在预览域名下跟随跳转
    if (response.status === 302) {
      const loc = response.headers.get('Location');
      if (loc && loc.startsWith(IMG_BED_URL)) {
        const rel = new URL(loc).pathname.replace(/^\/file\//, '/__imgbed-file/');        const h = new Headers(response.headers);
        h.set('Location', rel);
        res.writeHead(302, Object.fromEntries(h.entries()));
        res.end();
        return;
      }
    }

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end();
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server Error: ' + (e && e.stack ? e.stack : String(e)));
  }
});

if (!USE_REAL_IMGBED && !USE_TG_MOCK) {
  imgbedServer.listen(IMGBED_PORT, '127.0.0.1', () => {
    console.log(`[preview] ImgBed mock 运行中：http://127.0.0.1:${IMGBED_PORT}`);
  });
} else if (USE_TG_MOCK) {
  console.log('[preview] Telegram 模式：跳过 ImgBed mock（文件直存 Telegram）');
} else {
  console.log(`[preview] 真实 ImgBed 模式：${IMG_BED_URL}`);
}
server.listen(PORT, HOST, () => {
  console.log(`[preview] FileCodeBox-CF 本地预览运行中：http://${HOST}:${PORT}`);
});
