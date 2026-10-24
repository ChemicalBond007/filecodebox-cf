// Pages 只转发 API / 下载请求，全部业务逻辑仍由原 Worker 处理。
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/') || path === '/file' || path.startsWith('/file/')) {
      try {
        return await env.BACKEND.fetch(new Request(request, { redirect: 'manual' }));
      } catch {
        return Response.json({ error: '后端服务暂时不可用' }, {
          status: 502,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
