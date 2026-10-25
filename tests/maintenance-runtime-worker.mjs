// 仅用于本地真实 D1 验证，不作为生产入口部署。
import { reserveCleanup } from '../src/db.js';

export default {
  async fetch(request, env) {
    const now = Number(new URL(request.url).searchParams.get('now'));
    return Response.json(await reserveCleanup(env.fcb_db, now));
  },
};
