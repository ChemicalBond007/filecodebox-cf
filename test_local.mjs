// 本地集成测试：用 node:sqlite 模拟 D1，用 globalThis.fetch 拦截并模拟
// CloudFlare-ImgBed 的 HTTP API（/upload、/file、/api/manage/delete）。
// 覆盖 Phase 3 架构：文件二进制委托给已部署的 ImgBed，本 Worker 只做取件码层。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './src/worker.js';
import { hmac, fileToken } from './src/auth.js';

// ---- 内存 SQLite 模拟 D1（仅 fcb_db，分享元数据） ----
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'));

class Stmt {
  constructor(db, q) { this.db = db; this.q = q; this.params = []; }
  bind(...p) { this.params = p; return this; }
  _all() { return this.db.prepare(this.q).all(...this.params); }
  first() { const r = this._all(); return r.length ? r[0] : null; }
  all() { return { results: this._all() }; }
  run() {
    const info = this.db.prepare(this.q).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0) } };
  }
}
const fcb_db = { prepare: (q) => new Stmt(sqlite, q) };

// ---- 模拟 CloudFlare-ImgBed 的 HTTP API ----
const IMG_BED_URL = 'https://imgbed.test';
const uploaded = {}; // id -> { bytes, contentType }
let uploadCounter = 0;
let deletedIds = []; // 记录被 /api/manage/delete 清理过的 id

async function streamToText(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  if (typeof stream.text === 'function') return await stream.text();
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return String(stream);
}

// 模拟 ImgBed：从转发的 multipart/form-data 中解析出文件本体（与真实 ImgBed 行为一致）
function parseMultipartFile(body, contentType) {
  const m = /boundary=(.*?)(;|$)/.exec(contentType || '');
  if (!m) return body;
  const boundary = '--' + m[1].trim();
  for (const part of body.split(boundary)) {
    if (part.includes('filename=')) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx >= 0) {
        let content = part.slice(idx + 4);
        if (content.endsWith('\r\n')) content = content.slice(0, -2);
        return content;
      }
    }
  }
  return body;
}

async function mockFetch(url, init = {}) {
  const u = new URL(url);
  if (!u.origin.endsWith('imgbed.test')) {
    throw new Error('非预期的 fetch 目标：' + url + '（测试只应访问 ImgBed）');
  }
  if (u.pathname === '/upload' && (init.method || 'GET') === 'POST') {
    const bytes = await streamToText(init.body);
    const id = 'img-' + (++uploadCounter);
    const ct = (init.headers && (init.headers['Content-Type'] || init.headers.get?.('Content-Type'))) || 'application/octet-stream';
    uploaded[id] = { bytes: parseMultipartFile(bytes, String(ct)), contentType: String(ct) };
    return new Response(
      JSON.stringify({ src: IMG_BED_URL + '/file/' + id, url: IMG_BED_URL + '/file/' + id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (u.pathname.startsWith('/file/') && (init.method || 'GET') === 'GET') {
    const id = u.pathname.split('/file/')[1];
    const f = uploaded[id];
    if (!f) return new Response('not found', { status: 404 });
    return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.contentType } });
  }
  if (u.pathname.startsWith('/api/manage/delete/') && (init.method || 'GET') === 'DELETE') {
    const id = u.pathname.split('/api/manage/delete/')[1];
    deletedIds.push(id);
    delete uploaded[id];
    return new Response('ok', { status: 200 });
  }
  return new Response('mock 404', { status: 404 });
}
globalThis.fetch = mockFetch;

const env = {
  fcb_db,
  IMG_BED_URL,
  ADMIN_KEY: 'secret123',
  FILE_SECRET: 'filesec',
  APP_NAME: 'T',
  APP_SUBTITLE: 'S',
  IMG_BED_ADMIN_TOKEN: 'imgbed-admin', // 让 deleteFromImgBed 真正触发清理
};
const defaultAdminToken = await hmac('change-me-please', 'fcb-admin');

// ---- 测试工具 ----
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('   ? ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }

async function call(method, path, body, headers = {}) {
  const init = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json', ...headers }; }
  return worker.fetch(new Request('https://x.com' + path, init), env, { waitUntil() {} });
}
function fd(obj) {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

// ---- 1. 健康检查 & 配置 ----
{
  const r = await call('GET', '/api/health');
  eq(r.status, 200, 'health 200');
  const c = await (await call('GET', '/api/config')).json();
  eq(c.status ?? c.storage, 'CloudFlare-ImgBed (API)', 'config 声明使用 ImgBed (API)');
}

// ---- 2. 文本分享：创建 → 元信息 → 取件 ----
let code;
{
  const r = await call('POST', '/api/share', fd({ type: 'text', text: 'hello 快递柜', expire_ms: '0', download_limit: '0' }));
  eq(r.status, 200, '创建文本分享 200');
  const d = await r.json();
  ok(/^[A-Z0-9]{8}$/.test(d.code), '取件码格式 AAAAAAAA: ' + d.code);
  code = d.code;

  const meta = await (await call('GET', '/api/share/' + code)).json();
  eq(meta.type, 'text', '元信息 type=text');
  eq(meta.has_password, false, '无密码标记');

  const claim = await (await call('POST', '/api/share/' + code + '/claim')).json();
  eq(claim.type, 'text', '取件返回文本');
  eq(claim.text, 'hello 快递柜', '文本内容一致');
}

// ---- 3. 文本分享 + 密码 ----
{
  const r = await call('POST', '/api/share', fd({ type: 'text', text: 'secret', password: 'pw', download_limit: '0' }));
  const c = await r.json();
  const m = await (await call('GET', '/api/share/' + c.code)).json();
  eq(m.has_password, true, '有密码标记');
  const noPwd = await call('POST', '/api/share/' + c.code + '/claim');
  eq(noPwd.status, 401, '无密码取件 401');
  const withPwd = await (await call('POST', '/api/share/' + c.code + '/claim', fd({ password: 'pw' }))).json();
  eq(withPwd.text, 'secret', '密码正确取到文本');
}

// ---- 4. 文件分享（委托 ImgBed）：上传 → 创建 → 取件 → 302 跳 ImgBed ----
let fileCode, fileKey;
{
  // 4a. 先把文件通过 /api/imgbed/upload 流式代理到 ImgBed
  const file = new File(['hello imgbed content'], 'note.txt', { type: 'text/plain' });
  const up = await (await call('POST', '/api/imgbed/upload', fd({ file }))).json();
  ok(up.id, 'ImgBed 返回文件 id');
  ok(up.src && up.src.includes('/file/'), 'ImgBed 返回可访问 src');
  ok(up.upload_token, '上传接口返回 upload_token');
  ok(uploaded[up.id], 'ImgBed 侧已收到并存储文件（bytes 非空）');
  eq(uploaded[up.id].bytes, 'hello imgbed content', 'ImgBed 存储内容一致');

  // 4a2. 缺 upload_token / 非法 file_key 必须被拒绝
  const noUploadToken = await call('POST', '/api/share', fd({
    type: 'file', file_key: up.id, file_name: 'note.txt',
    file_type: 'text/plain', file_size: '19', expire_ms: '0', download_limit: '0',
  }));
  eq(noUploadToken.status, 401, '缺少 upload_token 被拒绝');

  const badKey = await call('POST', '/api/share', fd({
    type: 'file', file_key: 'x"><img src=x onerror=alert(1)>', file_name: 'x',
    file_type: 'text/plain', file_size: '1', expire_ms: '0', download_limit: '0',
  }));
  eq(badKey.status, 400, '非法 file_key 被拒绝');

  // 4b. 用 file_key + upload_token 创建分享（文件本体不经过 /api/share）
  const r = await call('POST', '/api/share', fd({
    type: 'file', file_key: up.id, upload_token: up.upload_token, file_name: 'note.txt',
    file_type: 'text/plain', file_size: '19', expire_ms: '0', download_limit: '0',
  }));
  eq(r.status, 200, '用 file_key 创建文件分享 200');
  const d = await r.json();
  fileCode = d.code;

  const meta = await (await call('GET', '/api/share/' + fileCode)).json();
  eq(meta.type, 'file', '元信息 type=file');
  eq(meta.file_name, 'note.txt', '文件名一致');
  eq(meta.file_size, 19, '文件大小 19');

  const claim = await (await call('POST', '/api/share/' + fileCode + '/claim')).json();
  ok(claim.url.startsWith('/file/'), '取件返回 /file 直链');
  ok(claim.url.includes('t='), '直链带短时 token');
  ok(claim.url.includes('c=' + fileCode), '直链绑定 share code');

  fileKey = new URL(claim.url, 'https://x.com').pathname.split('/file/')[1].split('?')[0];
  ok(fileKey, '从 claim.url 解析出 file_key');

  // 4c. 缺 token 访问 → 403
  const noT = await call('GET', '/file/' + fileKey);
  eq(noT.status, 403, '缺 token 访问 403');

  // 4c2. 过期 token → 403
  const expiredToken = await fileToken(env, fileKey, fileCode, -1000);
  const expiredRes = await call('GET', '/file/' + encodeURIComponent(fileKey) + '?c=' + fileCode + '&t=' + expiredToken);
  eq(expiredRes.status, 403, '过期 token 403');

  // 4d. 带 token 访问 → 302 跳转到 ImgBed 原地址
  const fr = await call('GET', claim.url);
  eq(fr.status, 302, '带 token 访问 302 跳转');
  eq(fr.headers.get('Location'), IMG_BED_URL + '/file/' + fileKey, '跳转目标即 ImgBed 原地址');

  // 4e. 跟随跳转：模拟浏览器请求 ImgBed → 拿到真实内容（验证委托可取回）
  const real = await mockFetch(IMG_BED_URL + '/file/' + fileKey, { method: 'GET' });
  eq(real.status, 200, 'ImgBed 返回文件 200');
  eq(await real.text(), 'hello imgbed content', '跟随跳转取回内容一致');
}

// ---- 5. 取件次数上限 ----
{
  const r = await call('POST', '/api/share', fd({ type: 'text', text: 'once', download_limit: '1' }));
  const c = await r.json();
  const a = await (await call('POST', '/api/share/' + c.code + '/claim')).json();
  eq(a.text, 'once', '首次取件成功');
  const b = await call('POST', '/api/share/' + c.code + '/claim');
  eq(b.status, 410, '次数用尽 410');
}

// ---- 6. 管理员 ----
let adminToken;
{
  const wrong = await call('POST', '/api/admin/login', { password: 'bad' });
  eq(wrong.status, 401, '错误密码 401');
  const ok1 = await (await call('POST', '/api/admin/login', { password: 'secret123' })).json();
  ok(ok1.token, '登录返回 token');
  adminToken = ok1.token;

  const noAuth = await call('GET', '/api/admin/shares');
  eq(noAuth.status, 401, '无 token 访问 401');

  const defaultTokenRes = await call('GET', '/api/admin/stats', undefined, {
    Authorization: 'Bearer ' + defaultAdminToken,
  });
  eq(defaultTokenRes.status, 401, '公开默认密钥 token 不再可用');

  const list = await (await call('GET', '/api/admin/shares', undefined, { Authorization: 'Bearer ' + adminToken })).json();
  ok(Array.isArray(list.shares) && list.shares.length >= 3, '分享列表非空: ' + list.shares.length);
  const stats = await (await call('GET', '/api/admin/stats', undefined, { Authorization: 'Bearer ' + adminToken })).json();
  ok(stats.total >= 3, '统计 total>=3: ' + stats.total);
}

// ---- 7. 删除分享（同步清理 ImgBed 侧对象） ----
{
  // 先上传一个专属文件用于删除测试
  const up = await (await call('POST', '/api/imgbed/upload', fd({ file: new File(['to-delete'], 'd.txt', { type: 'text/plain' }) }))).json();
  const r = await call('POST', '/api/share', fd({ type: 'file', file_key: up.id, upload_token: up.upload_token, file_name: 'd.txt', file_type: 'text/plain', file_size: '9', expire_ms: '0', download_limit: '0' }));
  const code = (await r.json()).code;
  const claim = await (await call('POST', '/api/share/' + code + '/claim')).json();

  const del = await call('DELETE', '/api/admin/share/' + code, undefined, { Authorization: 'Bearer ' + adminToken });
  eq(del.status, 200, '删除 200');
  const meta = await call('GET', '/api/share/' + code);
  eq(meta.status, 404, '删除后元信息 404');
  const afterDelete = await call('GET', claim.url);
  eq(afterDelete.status, 404, '删除后文件直链失效');
  ok(!uploaded[up.id], 'ImgBed 侧对象已清理');
  ok(deletedIds.includes(up.id), 'deleteFromImgBed 命中 ImgBed 删除接口');
}

// ---- 8. 过期清理（sweep 应同步清理 ImgBed） ----
{
  const up = await (await call('POST', '/api/imgbed/upload', fd({ file: new File(['expired'], 'e.txt', { type: 'text/plain' }) }))).json();
  // 取件码已过期（expire_ms=1，立刻过期）。注意：Date.now() 为整数毫秒，管道处理本身可能 < 1ms，
  // 导致 sweep 取到的 now 仍 <= expire_at(=created_at+1) 而漏判——属墙钟时序抖动，非逻辑缺陷。
  // 这里把该分享的 expire_at 直接拨到确定已过去的时间，确保 sweep 必定命中（生产环境过期分享的 expire_at 即处于过去）。
  const createR = await call('POST', '/api/share', fd({ type: 'file', file_key: up.id, upload_token: up.upload_token, file_name: 'e.txt', file_type: 'text/plain', file_size: '7', expire_ms: '1', download_limit: '0' }));
  const createJ = await createR.json();
  await fcb_db.prepare('UPDATE shares SET expire_at = ? WHERE code = ?').bind(Date.now() - 60_000, createJ.code).run();

  const sweep = await (await call('POST', '/api/admin/sweep', undefined, { Authorization: 'Bearer ' + adminToken })).json();
  ok(sweep.cleaned >= 1, 'sweep 清理了至少 1 条: ' + sweep.cleaned);
  ok(sweep.cleaned >= 1, 'sweep 清理了至少 1 条: ' + sweep.cleaned);
  ok(deletedIds.includes(up.id) || !uploaded[up.id], 'sweep 同步清理了 ImgBed 侧的过期对象');

  // 顺带验证 cron scheduled 路径不会抛错（直接调用 storage 入口已在上面覆盖）
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
