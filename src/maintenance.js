import * as db from './db.js';
import { cleanupAdmin } from './admin.js';
import { deleteFromImgBed } from './storage.js';
import { AUTO_CLEANUP_INTERVAL_MS } from './config.js';

// 只缓存时间，不缓存请求产生的 Promise/I/O。D1 原子预约才是跨实例的全局节流。
const nextChecks = new WeakMap();

export function queueCleanup(env, ctx) {
  const store = env.fcb_db;
  if (!store || typeof ctx?.waitUntil !== 'function') return;
  const now = Date.now();
  if ((nextChecks.get(store) || 0) > now) return;
  // 同实例并发请求先跳过；即使后台失败，也不因下一次访问立即重试。
  nextChecks.set(store, now + AUTO_CLEANUP_INTERVAL_MS);
  ctx.waitUntil((async () => {
    const slot = await db.reserveCleanup(store, now);
    nextChecks.set(store, slot.nextRun);
    if (!slot.acquired) return;
    const keys = await db.sweepExpired(store);
    await db.cleanupShareSecurity(store);
    await cleanupAdmin(store);
    for (const key of new Set(keys)) {
      if (await db.countSharesByFileKey(store, key) === 0) await deleteFromImgBed(env, key);
    }
  })().catch(() => {
    // 上游错误可能含凭证/URL，不将原始错误写入日志或影响正常响应。
    console.error('[cleanup] background cleanup failed');
  }));
}
