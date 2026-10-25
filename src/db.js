// FileCodeBox-CF · 分享记录数据库（FileCodeBox 自有 D1: fcb_db）
// 负责分享元数据和管理员 Passkey / 会话状态。
// 文件二进制本体存放在 ImgBed 的 R2 桶（img_r2），不在此处。

// 自举建表（Bootstrap）：Cloudflare D1 支持在运行时执行 DDL。
// 部署后无需手动跑 wrangler d1 execute，Worker 会在首次访问（或显式 /api/install）时
// 自动执行 CREATE TABLE IF NOT EXISTS，幂等、可重复执行。
// 建表语句与 migrations/ 中的 SQL 保持一致。
import { ADMIN_SCHEMA_SQL } from './admin-schema.js';
import { SHARE_SCHEMA_SQL } from './share-schema.js';
import { MAINTENANCE_SCHEMA_SQL } from './maintenance-schema.js';
import { AUTO_CLEANUP_INTERVAL_MS } from './config.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shares (
  code           TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  text_content   TEXT,
  file_key       TEXT,
  file_name      TEXT,
  file_type      TEXT,
  file_size      INTEGER,
  password       TEXT,
  expire_at      INTEGER,
  download_limit INTEGER NOT NULL DEFAULT 0,
  downloads      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  upload_ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_shares_created_at ON shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expire_at ON shares(expire_at);
` + ADMIN_SCHEMA_SQL + SHARE_SCHEMA_SQL + MAINTENANCE_SCHEMA_SQL;

// 只缓存完成标记，不缓存请求产生的 Promise 或数据库 I/O。
const schemaReady = new WeakSet();
export async function ensureSchema(db) {
  if (!db) return; // 未绑定 fcb_db 时跳过（防御）
  if (schemaReady.has(db)) return;
  for (const raw of SCHEMA_SQL.split(';')) {
    const stmt = raw.trim();
    if (stmt) await db.prepare(stmt).run();
  }
  await db.prepare('INSERT OR IGNORE INTO admin_auth (id, user_id) VALUES (1, ?)')
    .bind(crypto.randomUUID()).run();
  schemaReady.add(db);
}

export async function createShare(db, row) {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO shares
       (code, type, text_content, file_key, file_name, file_type, file_size,
        password, expire_at, download_limit, downloads, created_at, upload_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      row.code,
      row.type,
      row.text_content ?? null,
      row.file_key ?? null,
      row.file_name ?? null,
      row.file_type ?? null,
      row.file_size ?? null,
      row.password ?? null,
      row.expire_at ?? null,
      row.download_limit ?? 0,
      row.created_at,
      row.upload_ip ?? ''
    )
    .run();
}

export async function getShare(db, code) {
  await ensureSchema(db);
  const row = await db
    .prepare(`SELECT code, type, file_key, file_name, file_type, file_size, password,
                     expire_at, download_limit, downloads, created_at FROM shares WHERE code = ?`)
    .bind(code)
    .first();
  return row || null;
}

export async function getShareMeta(db, code) {
  await ensureSchema(db);
  return db.prepare(`SELECT code, type, file_name, file_type, file_size, expire_at,
      download_limit, downloads, password IS NOT NULL AS has_password FROM shares WHERE code = ?`)
    .bind(code).first();
}

export async function getShareText(db, code) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT text_content FROM shares WHERE code = ? AND type = 'text'")
    .bind(code).first();
  return row?.text_content;
}

export async function getClaimReceipt(db, code, hash, now = Date.now()) {
  await ensureSchema(db);
  return db.prepare('SELECT created_at, expires_at FROM claim_receipts WHERE code = ? AND key_hash = ? AND expires_at > ?')
    .bind(code, hash, now).first();
}

// D1 batch 是事务：只有插入/更新了自己 nonce 的请求才扣次数，重复请求复用回执。
export async function consumeClaim(db, code, hash, expiresAt, now = Date.now()) {
  await ensureSchema(db);
  const nonce = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO claim_receipts (code, key_hash, nonce, created_at, expires_at)
      SELECT code, ?, ?, ?, ? FROM shares WHERE code = ?
        AND (expire_at IS NULL OR expire_at = 0 OR expire_at > ?)
        AND (download_limit = 0 OR downloads < download_limit)
      ON CONFLICT(code, key_hash) DO UPDATE SET nonce = excluded.nonce,
        created_at = excluded.created_at, expires_at = excluded.expires_at
      WHERE claim_receipts.expires_at <= ?`)
      .bind(hash, nonce, now, expiresAt, code, now, now),
    db.prepare(`UPDATE shares SET downloads = downloads + 1 WHERE code = ?
      AND EXISTS (SELECT 1 FROM claim_receipts WHERE code = ? AND key_hash = ? AND nonce = ?)`)
      .bind(code, code, hash, nonce),
  ]);
  return getClaimReceipt(db, code, hash, now);
}

export async function passwordAttempt(db, id, expiresAt) {
  await ensureSchema(db);
  return db.prepare(`INSERT INTO share_attempts (id, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`)
    .bind(id, expiresAt).first();
}

export async function passwordAccepted(db, pair, shared) {
  await db.batch([
    db.prepare('DELETE FROM share_attempts WHERE id = ?').bind(pair),
    db.prepare('UPDATE share_attempts SET attempts = MAX(0, attempts - 1) WHERE id = ?').bind(shared),
  ]);
}

export async function deleteExpiredText(db, code, now = Date.now()) {
  await db.prepare("DELETE FROM shares WHERE code = ? AND type = 'text' AND expire_at > 0 AND expire_at <= ?")
    .bind(code, now).run();
}

export async function cleanupShareSecurity(db, now = Date.now()) {
  await ensureSchema(db);
  await db.batch([
    db.prepare('DELETE FROM claim_receipts WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM share_attempts WHERE expires_at <= ?').bind(now),
  ]);
}

export async function reserveCleanup(db, now = Date.now()) {
  await ensureSchema(db);
  const nextRun = now + AUTO_CLEANUP_INTERVAL_MS;
  const row = await db.prepare(`INSERT INTO maintenance_state (id, next_run) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET next_run = excluded.next_run
    WHERE maintenance_state.next_run <= ? RETURNING next_run`)
    .bind(nextRun, now).first();
  if (row) return { acquired: true, nextRun: row.next_run };
  const state = await db.prepare('SELECT next_run FROM maintenance_state WHERE id = 1').first();
  return { acquired: false, nextRun: state?.next_run ?? nextRun };
}

export async function deleteShare(db, code) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM shares WHERE code = ?`).bind(code).run();
}

export async function listShares(db, limit = 100, offset = 0) {
  await ensureSchema(db);
  const rows = await db
    .prepare(
      `SELECT code, type, file_name, file_type, file_size, expire_at,
              download_limit, downloads, created_at, password IS NOT NULL AS has_password
       FROM shares ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all();
  return rows.results || [];
}

export async function countShares(db) {
  await ensureSchema(db);
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM shares`).first();
  return r ? r.c : 0;
}

export async function countActive(db) {
  await ensureSchema(db);
  const now = Date.now();
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM shares
       WHERE (expire_at IS NULL OR expire_at = 0 OR expire_at > ?)
         AND (download_limit = 0 OR downloads < download_limit)`
    )
    .bind(now)
    .first();
  return r ? r.c : 0;
}

// 清理过期 / 超额分享：返回被删除的 file_key 列表，供调用方清理 R2
export async function countSharesByFileKey(db, key) {
  if (!key) return 0;
  await ensureSchema(db);
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM shares WHERE file_key = ?`)
    .bind(key)
    .first();
  return r ? r.c : 0;
}

export async function getShareByFileKey(db, key) {
  if (!key) return null;
  await ensureSchema(db);
  const row = await db
    .prepare(`SELECT code, file_name, file_type, file_size FROM shares WHERE file_key = ?`)
    .bind(key)
    .first();
  return row || null;
}

export async function sweepExpired(db, now = Date.now()) {
  await ensureSchema(db);
  const keys = [];
  const BATCH = 100; // D1 单条 SQL 的绑定参数有上限，批量删除避免超限

  for (let round = 0; round < 1000; round++) {
    const expired = await db
      .prepare(
        `SELECT code, file_key FROM shares
         WHERE (expire_at IS NOT NULL AND expire_at != 0 AND expire_at <= ?)
            OR (download_limit > 0 AND downloads >= download_limit
                AND NOT EXISTS (SELECT 1 FROM claim_receipts
                  WHERE claim_receipts.code = shares.code AND claim_receipts.expires_at > ?))
         LIMIT ${BATCH}`
      )
      .bind(now, now)
      .all();
    const rows = expired.results || [];
    if (!rows.length) break;

    const codes = rows.map((r) => r.code);
    const placeholders = codes.map(() => '?').join(',');
    await db
      .prepare(`DELETE FROM shares WHERE code IN (${placeholders})`)
      .bind(...codes)
      .run();

    for (const r of rows) {
      if (r.file_key) keys.push(r.file_key);
    }
    if (rows.length < BATCH) break;
  }

  return keys;
}
