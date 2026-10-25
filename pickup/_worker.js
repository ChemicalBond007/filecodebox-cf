const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'];

function error(message, status) {
  return Response.json({ error: message }, { status });
}

function finish(response, request) {
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie');
  headers.delete('Location');
  for (const name of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers', 'Access-Control-Allow-Credentials', 'Access-Control-Max-Age']) headers.delete(name);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

async function download(request, redirect) {
  const target = new URL(redirect.headers.get('Location'));
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Invalid download target');
  }
  if (redirect.body) await redirect.body.cancel();

  // 只转发下载所需的头，不能把站点 Cookie、Origin 或凭证带到存储服务。
  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  for (const name of ['Range', 'If-Range']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  const response = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
  if (!response.ok && response.status !== 416) {
    if (response.body) await response.body.cancel();
    return error('文件下载失败，请稍后重试', response.status >= 400 ? response.status : 502);
  }

  const outputHeaders = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment',
  });
  for (const name of DOWNLOAD_HEADERS) {
    if (response.headers.has(name)) outputHeaders.set(name, response.headers.get(name));
  }
  if (response.status === 416) {
    if (response.body) await response.body.cancel();
    outputHeaders.delete('Content-Length');
  }
  return new Response(response.status === 416 ? null : response.body, {
    status: response.status, headers: outputHeaders,
  });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    // 副站只公开自己的展示配置，绝不读取或转发原 Worker 的配置。
    if (method === 'GET' && /^\/api\/config\/?$/.test(path)) {
      return finish(Response.json({
        name: env.PICKUP_NAME || 'pickupfiles',
        subtitle: env.PICKUP_SUBTITLE ?? '输入取件码，领取文本或文件',
      }), request);
    }
    const isFile = /^\/file\/[^/]+\/?$/.test(path);
    const allowed = (method === 'GET' && /^\/api\/share\/[A-Za-z0-9]+\/?$/.test(path))
      || (method === 'POST' && /^\/api\/share\/[A-Za-z0-9]+\/claim\/?$/.test(path))
      || (isFile && (method === 'GET' || method === 'HEAD'));

    if (!allowed) {
      if (path === '/api' || path.startsWith('/api/') || path === '/file' || path.startsWith('/file/')) {
        return finish(error('Not Found', 404), request);
      }
      return env.ASSETS.fetch(request);
    }

    try {
      const headers = new Headers(request.headers);
      headers.delete('Cookie');
      headers.delete('Authorization');
      const response = await env.BACKEND.fetch(new Request(request, { headers, redirect: 'manual' }));
      if (REDIRECTS.has(response.status)) {
        if (!isFile) {
          if (response.body) await response.body.cancel();
          return finish(error('后端服务暂时不可用', 502), request);
        }
        return finish(await download(request, response), request);
      }
      return finish(response, request);
    } catch {
      return finish(error('后端服务暂时不可用', 502), request);
    }
  },
};
