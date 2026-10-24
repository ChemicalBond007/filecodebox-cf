// FileCodeBox-CF · 存储层（委托 CloudFlare-ImgBed 的 HTTP API）
//
// 设计：文件二进制不经过 FileCodeBox 自己写 R2，而是直接委托给已部署的
// ImgBed 实例 —— 它本就跑在 Cloudflare 上，原生支持大文件 / 分片上传 / R2 存储
// 与图床后台。FileCodeBox 只负责「取件码层」：
//   · 上传：把请求体流式代理到 ImgBed 的 /upload（不缓冲，大文件直穿）
//   · 取件：校验短时防直链 token 后 302 跳转到 ImgBed 原地址
//   · 删除：可选同步清理 ImgBed 侧对象（只删除本应用登记过的合法 key）

import { verifyFileToken, isValidFileKey, uploadToken } from './auth.js';

// 把请求体流式转发到 ImgBed 的 /upload，由 ImgBed 完成存储。
// 返回 { id, src, upload_token }，其中 upload_token 用于创建分享时证明来源。
export async function uploadToImgBed(env, request) {
  const base = env.IMG_BED_URL;
  if (!base) throw new Error('未配置 IMG_BED_URL（ImgBed 部署地址）');

  const url = new URL('/upload', base);
  // 可选：仅当显式配置 IMG_BED_UPLOAD_TOKEN_PARAM 时，才把 token 作为 query 参数附加
  // （用于 authCode 形式的 ImgBed；ImgBed 更常见的 API Token 走下面的 Authorization: Bearer 头）
  if (env.IMG_BED_UPLOAD_TOKEN_PARAM && env.IMG_BED_UPLOAD_TOKEN) {
    url.searchParams.set(env.IMG_BED_UPLOAD_TOKEN_PARAM, env.IMG_BED_UPLOAD_TOKEN);
  }
  if (env.IMG_BED_UPLOAD_CHANNEL) url.searchParams.set('uploadChannel', env.IMG_BED_UPLOAD_CHANNEL);

  // 流式转发：body 是 ReadableStream，运行时不会缓冲整段，大文件直穿到 ImgBed
  const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream' };
  if (env.IMG_BED_UPLOAD_TOKEN) headers['Authorization'] = 'Bearer ' + env.IMG_BED_UPLOAD_TOKEN;
  const upstream = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: request.body,
    redirect: 'manual',
    duplex: 'half', // Node/undici 转发流时必须；Cloudflare 运行时忽略此字段
  });

  if (upstream.status >= 400) {
    const txt = await upstream.text().catch(() => '');
    throw new Error('ImgBed 上传失败 (' + upstream.status + '): ' + txt.slice(0, 200));
  }

  const data = await upstream.json().catch(() => ({}));
  const first = Array.isArray(data) ? data[0] : data;
  const src = first && (first.src || first.url);
  if (!src) throw new Error('ImgBed 未返回文件地址');
  const id = String(src).split('/file/')[1]?.split('?')[0];
  if (!id || !isValidFileKey(id)) throw new Error('无法解析 ImgBed 文件 id');
  return { id, src, upload_token: await uploadToken(env, id) };
}

// 取件直链：校验短时防直链 token 后 302 跳转到 ImgBed 原地址。
// 实际传输（含 Range / 大文件流式）由 ImgBed 负责。
export async function serveFromImgBed(env, request, id, code) {
  if (!isValidFileKey(id)) return new Response('无效的文件标识', { status: 400 });

  const token = new URL(request.url).searchParams.get('t');
  if (!token || !(await verifyFileToken(env, id, code, token))) {
    return new Response('无效或缺失的访问凭证', { status: 403 });
  }
  const base = env.IMG_BED_URL;
  if (!base) return new Response('未配置 IMG_BED_URL', { status: 500 });

  const location = new URL('/file/' + encodeURIComponent(id), base).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

// 删除分享时可选同步清理 ImgBed 侧对象（需配置 IMG_BED_ADMIN_TOKEN）。
// 只接受合法、非分片的 key，并使用 encodeURIComponent，避免 `../` 改写删除路径。
export async function deleteFromImgBed(env, id) {
  const base = env.IMG_BED_URL;
  if (!base || !env.IMG_BED_ADMIN_TOKEN) return;
  if (!id || String(id).startsWith('c:') || !isValidFileKey(String(id))) return;

  try {
    const url = new URL('/api/manage/delete/' + encodeURIComponent(String(id)), base);
    await fetch(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + env.IMG_BED_ADMIN_TOKEN },
    });
  } catch (e) {
    /* 忽略清理失败 */
  }
}
