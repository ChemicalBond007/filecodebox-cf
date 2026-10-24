// FileCodeBox-CF · 分享记录数据库（FileCodeBox 自有 D1: fcb_db）
// 仅负责分享元数据（取件码、类型、过期、次数、密码哈希等）。
// 文件二进制本体存放在 ImgBed 的 R2 桶（img_r2），不在此处。

// 自举建表（Bootstrap）：Cloudflare D1 支持在运行时执行 DDL。
// 部署后无需手动跑 wrangler d1 execute，Worker 会在首次访问（或显式 /api/install）时
// 自动执行 CREATE TABLE IF NOT EXISTS，幂等、可重复执行。
// 建表语句与 migrations/0001_init.sql 保持一致。
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
`;

// 模块级缓存：每个 Worker 实例（冷启动）只真正执行一次建表；
// 之后所有请求复用同一 Promise。建表语句本身 IF NOT EXISTS，重复执行无副作用。
let schemaReady = null;
export async function ensureSchema(db) {
  if (!db) return; // 未绑定 fcb_db 时跳过（防御）
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const raw of SCHEMA_SQL.split(';')) {
        const stmt = raw.trim();
        if (!stmt) continue;
        await db.prepare(stmt).run();
      }
    })().catch((e) => {
      schemaReady = null; // 失败后允许下次请求重试
      throw e;
    });
  }
  await schemaReady;
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
    .prepare(`SELECT * FROM shares WHERE code = ?`)
    .bind(code)
    .first();
  return row || null;
}

// 取件时原子消耗一次：条件 UPDATE 保证并发请求不会超过 download_limit。
export async function consumeDownload(db, code, now = Date.now()) {
  await ensureSchema(db);
  const result = await db
    .prepare(
      `UPDATE shares SET downloads = downloads + 1
       WHERE code = ?
         AND (expire_at IS NULL OR expire_at = 0 OR expire_at > ?)
         AND (download_limit = 0 OR downloads < download_limit)`
    )
    .bind(code, now)
    .run();
  const changes = Number(result && result.meta ? result.meta.changes : NaN);
  // 本地 mock 未提供 meta.changes 时按成功处理；生产 D1 一定返回 changes。
  return Number.isFinite(changes) ? changes > 0 : true;
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
            OR (download_limit > 0 AND downloads >= download_limit)
         LIMIT ${BATCH}`
      )
      .bind(now)
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
